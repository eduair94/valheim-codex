import { chromium, type FullConfig, type Page } from '@playwright/test';

export const STORAGE_STATE = 'tests/e2e/.auth/state.json';

/**
 * Signs in once and saves the session for the whole run.
 *
 * The app rate limits login to 10 attempts per address per 15 minutes, and a
 * suite that logged in per test tripped its own defence — every test after
 * the tenth failed with a 429 that looked like a broken login. Reusing a
 * session is also how the app is actually used, so this is the more faithful
 * test as well as the passing one.
 *
 * Through the API rather than the form: the form has its own tests in
 * `auth.spec.ts`, and setup should not break when its labels change.
 *
 * But from inside a page, with `fetch`, not with `page.request`. A production
 * build names the cookie `__Host-wv_session` and marks it Secure, and
 * Playwright's API client withholds Secure cookies from any http:// URL whose
 * host is not `localhost` — so on http://127.0.0.1 every `page.request` call
 * goes out without the session and looks signed out. The browser itself
 * treats loopback as a secure context: it stores the cookie from a `fetch`
 * response and sends it back, exactly as for a reader.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL ?? 'http://127.0.0.1:3100';
  const password = process.env.E2E_PASSWORD ?? 'valheim-dev-2026';

  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });
  // Any page of the site, so the requests below are same-origin.
  const loginPage = await page.goto('/login');
  await warnIfPagesNeverHydrate(page, baseURL, loginPage?.headers()['content-security-policy'] ?? '');

  const login = await page.evaluate(
    async (credentials) => {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
      });
      return { status: response.status, body: await response.text() };
    },
    { password, profile: 'E2E Tester' },
  );
  if (login.status !== 200) {
    throw new Error(`Signing in for the e2e run failed: ${login.status} ${login.body}`);
  }

  /*
   * If a browser ever stopped accepting a Secure cookie on loopback, every
   * signed-in test would fail obscurely; it is checked here once, with the
   * reason.
   */
  const session = await page.evaluate(
    async () => (await (await fetch('/api/auth/session')).json()) as { mode?: string | null },
  );
  if (session.mode !== 'password') {
    const names = (await page.context().cookies()).map((c) => c.name).join(', ') || 'none';
    throw new Error(
      `Signed in, but the session cookie did not stick (cookies: ${names}). ` +
        'A Secure __Host- cookie needs https or a loopback address.',
    );
  }

  await page.context().storageState({ path: STORAGE_STATE });
  await browser.close();
}

/**
 * Says so, once and up front, when the pages of this run will not hydrate.
 *
 * `next dev` serves its hot-reload socket only to the host it was started on
 * (`localhost` unless told otherwise; `allowedDevOrigins` in next.config.ts
 * names any other), and its client hydrates no page until that socket
 * connects. Against a dev server reached as http://127.0.0.1 the HTML still
 * arrives, so every test that only reads a page passes, while every one that
 * types, clicks a client-side control or waits for a script fails, in ways
 * that look like a broken app. A production build has no such socket.
 *
 * Only a warning: the run goes on, and its results are the same either way.
 * `csp` is the page's policy header; only `next dev` allows `eval` in it
 * (`contentSecurityPolicy`, src/lib/auth/proxy-policy.ts).
 */
async function warnIfPagesNeverHydrate(page: Page, baseURL: string, csp: string): Promise<void> {
  const hydrated = await page
    .waitForFunction(
      () => {
        const main = document.querySelector('main');
        return main !== null && Object.keys(main).some((key) => key.startsWith('__reactProps$'));
      },
      undefined,
      { timeout: 20_000 },
    )
    .then(
      () => true,
      () => false,
    );
  if (hydrated) return;

  const devServer = csp.includes("'unsafe-eval'");
  console.warn(
    `\n[e2e] ${baseURL}/login did not hydrate within 20 s, so every test that needs the page's script will fail.` +
      (devServer
        ? ` This is \`next dev\`: it hydrates nothing while its hot-reload socket is refused, which it is for any ` +
          `host but the one it was started on (localhost, by default). Reach it as http://localhost:<port> instead.\n`
        : '\n'),
  );
}
