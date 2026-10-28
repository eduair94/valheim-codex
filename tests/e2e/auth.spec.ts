import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { STORAGE_STATE } from './global-setup';
import { refuseTranslations, waitForHydration } from './helpers';

/**
 * The sign-in flow, exercised from a signed-out browser.
 *
 * Kept in its own project so the rest of the suite can reuse one session:
 * login is rate limited to 10 attempts per address per 15 minutes, and these
 * are the only tests that need to spend one. A test about what a connected
 * reader sees borrows the session global setup saved instead of spending
 * another.
 *
 * Nothing here reaches Google or Puter: a Gemini key is only ever submitted
 * to a stand-in for `/api/auth/byok`, and the Puter panel is shown with a
 * stand-in SDK and Puter's domains refused (`withoutPuter`).
 *
 * The suite runs against a production build, where the session cookie is
 * `__Host-wv_session`; against `next dev` it is plain `wv_session`. Tests
 * that name the cookie accept either.
 *
 * That cookie is Secure, and Playwright's API client (`request`,
 * `page.request`) withholds Secure cookies from http://127.0.0.1, so anything
 * that needs the session asks from inside the page, where the browser sends
 * it like it would for a reader. The `request` fixture is only for requests
 * that are meant to be anonymous.
 */

const PASSWORD = process.env.E2E_PASSWORD ?? 'valheim-dev-2026';
/** The profile global setup signs in with too. */
const PROFILE = 'E2E Tester';
const SESSION_COOKIES = ['__Host-wv_session', 'wv_session'];
const DEVICE_COOKIES = ['__Host-wv_device', 'wv_device'];

/** How the connect page names its choice of method (`connectMethods`). */
const METHODS = 'Cómo te conectás';

/**
 * Iron Sword's question for the chat: its Spanish name, as the page shows it,
 * with the wiki's English one alongside.
 */
const IRON_SWORD_QUESTION = 'Espada de hierro (Iron Sword)';

async function signIn(page: Page, password: string): Promise<void> {
  await page.goto('/login');
  const profile = page.getByLabel('Tu nombre');
  // The button stays disabled for fields filled in before the form hydrates.
  await waitForHydration(profile);
  await profile.fill(PROFILE);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

/**
 * The Puter panel without Puter: the panel loads the SDK as soon as it is
 * shown, and reuses one already on the page, so a stand-in is put there
 * first. Anything addressed to Puter's domains is refused as well.
 */
async function withoutPuter(context: BrowserContext): Promise<void> {
  await context.route(/^https?:\/\/([a-z0-9-]+\.)*puter\.com\//, (route) => route.abort('blockedbyclient'));
  await context.addInitScript(() => {
    Object.assign(window, {
      puter: {
        authToken: null,
        auth: { isSignedIn: () => false, signIn: async () => ({ success: false }), signOut: () => {} },
        ai: { chat: async () => (async function* () {})() },
      },
    });
  });
}

/** `/api/auth/session`, asked by the page itself so the Secure cookie goes along. */
async function sessionInPage(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => (await (await fetch('/api/auth/session')).json()) as Record<string, unknown>);
}

/**
 * A cookie for the site under test. Given as `domain` + `path`, not `url`:
 * Chromium refuses a Secure cookie set through `url: 'http://…'` ("Invalid
 * cookie fields"), and a `__Host-` cookie must be Secure.
 */
function siteCookie(baseURL: string | undefined, name: string, value: string) {
  const domain = new URL(baseURL ?? 'http://127.0.0.1:3100').hostname;
  return { name, value, domain, path: '/', secure: name.startsWith('__Host-') };
}

test.beforeEach(async ({ context }) => {
  // A signed-out reader of an untranslated article may ask for its translation too.
  await refuseTranslations(context);
});

test.describe('access control', () => {
  test('an anonymous visitor lands on the reader, not a password prompt', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/wiki/);
    await expect(page.getByPlaceholder(/Buscá un objeto/)).toBeVisible();
  });

  test('a shared link with tracking parameters still opens the reader', async ({ request }) => {
    // Social networks add fbclid to every outbound link, campaigns utm_*.
    for (const path of ['/?fbclid=abc123', '/?utm_source=newsletter&utm_medium=email']) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(307);
      expect(response.headers()['location'], path).toMatch(/^(https?:\/\/[^/]+)?\/wiki$/);
    }
  });

  test('a sign-in link pointing off the site has its destination replaced', async ({ page }) => {
    await page.goto('/login?next=%2F%2Fevil.example');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('an anonymous visitor can read an article and search inside it', async ({ page }) => {
    await page.goto('/wiki/a/iron-sword');
    await expect(page.getByRole('heading', { level: 1, name: 'Espada de hierro' })).toBeVisible();

    await page.goto('/wiki');
    const search = page.getByPlaceholder(/Buscá un objeto/);
    await waitForHydration(search);
    await search.fill('iron sword');
    await expect(page.getByRole('link', { name: /Iron Sword/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('"Ask about this" takes an anonymous reader to sign in, with the question kept', async ({ page }) => {
    // It used to bounce to /wiki and drop the article's title. One such link
    // at any width; the end of the article says "Preguntarle al chat sobre…".
    await page.goto('/wiki/a/iron-sword');
    await page.getByRole('link', { name: /Preguntar sobre esto/ }).click();
    await expect(page).toHaveURL(/\/login\?next=/);
    const next = new URL(page.url()).searchParams.get('next') ?? '';
    const destination = new URL(next, page.url());
    expect(destination.pathname).toBe('/');
    expect(destination.searchParams.get('about')).toBe(IRON_SWORD_QUESTION);
  });

  test('the read-only API answers an anonymous request', async ({ request }) => {
    for (const path of ['/api/wiki/index', '/api/wiki/search?q=iron']) {
      expect((await request.get(path)).status(), path).toBe(200);
    }
  });

  test('crawlers get robots.txt and a sitemap instead of the login page', async ({ request }) => {
    const robots = await request.get('/robots.txt', { maxRedirects: 0 });
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain('Disallow: /api/');

    const sitemap = await request.get('/sitemap.xml', { maxRedirects: 0 });
    expect(sitemap.status()).toBe(200);
    expect(await sitemap.text()).toContain('/wiki/a/iron-sword</loc>');
  });

  test('the chat tab says it needs a password before asking for one', async ({ page }) => {
    await page.goto('/wiki');
    await page.getByRole('link', { name: /Chat/ }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Valheim Codex' })).toBeVisible();
  });

  test('the session endpoint always answers, and says nobody is signed in', async ({ request }) => {
    const response = await request.get('/api/auth/session');
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(await response.json()).toMatchObject({
      authenticated: false,
      mode: null,
      profile: null,
      modes: { password: true },
    });
  });

  test('the API refuses an unauthenticated request', async ({ request }) => {
    for (const path of ['/api/conversations', '/api/ingest']) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
    const chat = await request.post('/api/chat', {
      data: {
        conversationId: 'x',
        lang: 'es',
        message: { id: '1', role: 'user', parts: [{ type: 'text', text: 'hola' }] },
      },
    });
    expect(chat.status()).toBe(401);
  });

  test('a write from another site is refused before it does anything', async ({ request }) => {
    // Signing a visitor out, or into an account someone else chose, needs no cookie.
    const logout = await request.post('/api/auth/logout', {
      headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      data: '{}',
    });
    expect(logout.status()).toBe(403);
    expect(await logout.json()).toEqual({ error: 'forbidden_origin' });
  });

  test('pages carry the security headers', async ({ request }) => {
    const response = await request.get('/wiki');
    const headers = response.headers();
    // Enforced from the first deploy: what no page of the site can trip.
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("object-src 'none'");
    // The whole policy: report-only until CSP_ENFORCE=1, enforced after.
    const policy = headers['content-security-policy-report-only'] ?? headers['content-security-policy'];
    expect(policy).toContain('https://static.wikia.nocookie.net');
    expect(policy).toContain('report-uri /api/csp-report');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    expect(headers['x-powered-by']).toBeUndefined();
  });

  test('browsers have somewhere to report what the policy blocks', async ({ request }) => {
    const response = await request.post('/api/csp-report', {
      headers: { 'Content-Type': 'application/csp-report' },
      data: JSON.stringify({
        'csp-report': {
          'document-uri': 'http://127.0.0.1:3100/wiki?q=private',
          'effective-directive': 'img-src',
          'blocked-uri': 'https://tracker.example/pixel.gif',
          disposition: 'report',
        },
      }),
    });
    expect(response.status()).toBe(204);
  });

  test('a forged session cookie does not get in', async ({ page, context, baseURL }) => {
    // An "alg: none" token with an admin claim, under both cookie names:
    // rejected by signature checking, not merely by shape.
    const forged = 'eyJhbGciOiJub25lIn0.eyJwcm9maWxlIjoiYWRtaW4ifQ.';
    await context.addCookies([
      siteCookie(baseURL, 'wv_session', forged),
      siteCookie(baseURL, '__Host-wv_session', forged),
    ]);
    await page.goto('/');
    // Bounced to the public reader like any other stranger. The forged claim
    // buys nothing: the chat, and the bill behind it, stay out of reach.
    await expect(page).toHaveURL(/\/wiki/);
  });

  test('a wrong password is rejected and says so', async ({ page }) => {
    await signIn(page, 'not-the-password');
    // Next renders its own role="alert" route announcer, so match on the text.
    await expect(page.getByText('Contraseña incorrecta')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('signing in works, and the app remembers who you are', async ({ page, context }) => {
    await signIn(page, PASSWORD);
    await expect(page.getByPlaceholder('Preguntá sobre Valheim…')).toBeVisible();
    await expect(page.getByText(PROFILE)).toBeVisible();

    const cookie = (await context.cookies()).find((c) => SESSION_COOKIES.includes(c.name));
    expect(cookie, 'session cookie').toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    if (cookie?.name.startsWith('__Host-')) {
      expect(cookie.secure).toBe(true);
      expect(cookie.path).toBe('/');
    }

    // The browser is now a known one: the limiter's lockouts no longer apply to it.
    const device = (await context.cookies()).find((c) => DEVICE_COOKIES.includes(c.name));
    expect(device, 'known-browser cookie').toBeDefined();
    expect(device?.httpOnly).toBe(true);
    expect(device?.sameSite).toBe('Strict');

    expect(await sessionInPage(page)).toMatchObject({ authenticated: true, mode: 'password', profile: PROFILE });
  });
});

/** The ways of connecting this server offers, as `GET /api/auth/session` lists them. */
type Methods = { password: boolean; byok: boolean; puter: boolean };

async function offeredMethods(request: APIRequestContext): Promise<Methods> {
  const response = await request.get('/api/auth/session');
  return ((await response.json()) as { modes: Methods }).modes;
}

test.describe('connect page', () => {
  test('opens on the password when the browser remembers no method', async ({ page, request }) => {
    const modes = await offeredMethods(request);
    test.skip(!modes.password || !(modes.byok || modes.puter), 'This server offers no choice of method.');

    await page.goto('/login');
    const methods = page.getByRole('radiogroup', { name: METHODS });
    const names = [modes.password ? 'Contraseña' : null, modes.byok ? 'Gemini' : null, modes.puter ? 'Puter' : null];
    await expect(methods.getByRole('radio')).toHaveText(names.filter((name) => name !== null));
    await expect(methods.getByRole('radio', { name: 'Contraseña' })).toBeChecked();
    await expect(page.getByLabel('Tu nombre')).toBeVisible();
    await expect(page.getByLabel('Contraseña')).toBeVisible();
  });

  test('switches method with a click, or with the arrow keys', async ({ page, context, request }) => {
    const modes = await offeredMethods(request);
    test.skip(!(modes.password && modes.byok && modes.puter), 'This server does not offer all three methods.');
    await withoutPuter(context);

    await page.goto('/login');
    const methods = page.getByRole('radiogroup', { name: METHODS });
    const password = methods.getByRole('radio', { name: 'Contraseña' });
    const gemini = methods.getByRole('radio', { name: 'Gemini' });
    const puter = methods.getByRole('radio', { name: 'Puter' });
    await waitForHydration(gemini);

    // Only the chosen method's panel is there at all.
    await gemini.click();
    await expect(gemini).toBeChecked();
    await expect(password).not.toBeChecked();
    await expect(page.getByLabel('Clave de API de Gemini')).toBeVisible();
    await expect(page.getByLabel('Tu nombre')).toHaveCount(0);

    // One tab stop for the group, as with native radio buttons; the arrows move the choice.
    await page.keyboard.press('ArrowRight');
    await expect(puter).toBeChecked();
    await expect(puter).toBeFocused();
    await expect(page.getByRole('button', { name: 'Conectar con Puter' })).toBeVisible();
    await expect(page.getByLabel('Clave de API de Gemini')).toHaveCount(0);

    await page.keyboard.press('Home');
    await expect(password).toBeChecked();
    await expect(password).toBeFocused();
    await expect(page.getByLabel('Tu nombre')).toBeVisible();
  });

  test('opens on the Gemini panel when the link asks for it', async ({ page, request }) => {
    const modes = await offeredMethods(request);
    test.skip(!(modes.byok && (modes.password || modes.puter)), 'This server offers no choice beside Gemini keys.');

    // The chat's "Cambiar clave" links here this way.
    await page.goto('/login?method=byok');
    await expect(page.getByRole('radio', { name: 'Gemini' })).toBeChecked();
    await expect(page.getByLabel('Clave de API de Gemini')).toBeVisible();
    await expect(page.getByLabel('Tu nombre')).toHaveCount(0);
  });

  test('says so when Google refuses a key, and connects nobody', async ({ page, request }) => {
    test.skip(!(await offeredMethods(request)).byok, 'This server does not take Gemini keys.');

    // Answered in the browser: the key never reaches the server, which would ask Google.
    const sent: unknown[] = [];
    await page.route('**/api/auth/byok', async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'byok_key_invalid' }),
      });
    });

    await page.goto('/login?method=byok');
    const key = page.getByLabel('Clave de API de Gemini');
    await waitForHydration(key);
    await key.fill('  not-a-real-gemini-key  ');
    await page.getByRole('button', { name: 'Guardar y conectar' }).click();

    // Next renders an empty role="alert" of its own, so the panel's is the one with words.
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveText(
      'Google no aceptó esa clave. Revisá que esté completa y que tenga habilitada la API de Gemini.',
    );
    // Back in the field, to correct the key or paste another.
    await expect(key).toBeFocused();
    expect(sent).toEqual([{ key: 'not-a-real-gemini-key', model: expect.any(String) }]);
    expect(await sessionInPage(page)).toMatchObject({ authenticated: false });
  });

  test.describe('for a reader already connected', () => {
    test.use({ storageState: STORAGE_STATE });

    test('sends them on, unless they came to change method', async ({ page }) => {
      await page.goto('/login');
      await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);

      // "Cambiar método" in the chat links here with `switch=1`.
      await page.goto('/login?switch=1');
      await expect(
        page.getByText(`Ahora estás conectado con la contraseña del grupo, como ${PROFILE}.`),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: 'Volver al chat' })).toHaveAttribute('href', '/');
    });
  });
});
