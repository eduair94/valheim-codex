import { expect, test, type Page } from '@playwright/test';
import {
  chatErrorBar,
  refuseTranslations,
  skipIfGenerationFailed,
  skipIfModelQuotaExhausted,
  waitForHydration,
} from './helpers';

/**
 * The chat, opened with the session global setup saved; the sign-in flow
 * itself lives in auth.spec.ts.
 *
 * The answer tests ask the real model, and skip with the reason when its
 * quota is spent (helpers.ts). Everything else needs no model: the error
 * bar's failures and the index update are answered in the browser, and no
 * article opened on the way asks the server for a translation.
 */

const COMPOSER = 'Preguntá sobre Valheim…';
const EMPTY = 'Preguntá lo que necesites saber de Valheim.';
const IRON_SWORD = '¿Qué necesito para forjar una espada de hierro?';
const BONEMASS = '¿Cómo invoco a Bonemass?';

/** The address with no conversation in it: the chat's own, `/`. */
const NO_CONVERSATION = /^https?:\/\/[^/]+\/$/;

/** The address naming conversation `id`: `/?c=<id>`. */
function naming(id: string): RegExp {
  return new RegExp(`[?&]c=${id}(&|$)`);
}

/** What the chat posts to `/api/chat` for a question. */
type ChatRequest = {
  conversationId?: unknown;
  lang?: unknown;
  message?: { id?: unknown; role?: unknown; parts?: unknown };
  messages?: unknown;
};

test.beforeEach(async ({ context }) => {
  await refuseTranslations(context);
});

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  const composer = page.getByPlaceholder(COMPOSER);
  await expect(composer).toBeVisible();
  // Typed into before the page hydrates, the question would stay in the box unsent.
  await waitForHydration(composer);
}

/** Asks `question` and resolves with what the chat sent for it. */
async function ask(page: Page, question: string): Promise<ChatRequest & { conversationId: string }> {
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/chat');
  await page.getByPlaceholder(COMPOSER).fill(question);
  await page.getByRole('button', { name: 'Preguntar' }).click();
  const body = (await sent).postDataJSON() as ChatRequest;
  expect(typeof body.conversationId, 'the request names its conversation').toBe('string');
  return body as ChatRequest & { conversationId: string };
}

test.describe('chat', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('shows the empty state with runnable examples', async ({ page }) => {
    await expect(page.getByText(EMPTY)).toBeVisible();
    await expect(page.getByRole('button', { name: IRON_SWORD })).toBeVisible();
  });

  test('answers a question, streams it, and cites the wiki', async ({ page }) => {
    await skipIfModelQuotaExhausted();
    const body = await ask(page, IRON_SWORD);

    // Only the new question travels: the server rebuilds the history from what it stored.
    expect(body.messages).toBeUndefined();
    expect(body).toMatchObject({
      lang: 'es',
      message: { role: 'user', parts: [{ type: 'text', text: IRON_SWORD }] },
    });

    // The question is echoed straight away.
    await expect(page.getByText(IRON_SWORD).last()).toBeVisible();

    // Retrieval reports what it is doing before the first token.
    await expect(page.getByText(/Interpretando la pregunta|Buscando en la wiki|Redactando/)).toBeVisible({
      timeout: 30_000,
    });

    // Exactly one assistant message: the sources stream inside the same
    // message as the answer, not as a second one.
    const sources = page.getByRole('region', { name: 'Fuentes' });
    await expect(sources).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('article')).toHaveCount(1);

    // The answer is grounded: it names the material the recipe calls for.
    const article = page.locator('article').last();
    await expect(article).toContainText(/hierro|iron/i, { timeout: 60_000 });

    // Retrieval is done, so anything failing from here is the model call.
    await skipIfGenerationFailed(page);

    // And it carries at least one citation marker tied to a source.
    await expect(article.locator('.rune-chip').first()).toBeVisible();

    // Once the answer is under way the address names the conversation, so a
    // reload, a bookmark or Back finds the thread again.
    await expect(page).toHaveURL(naming(body.conversationId));
  });

  test('a citation opens the article inside the app, and Back returns to the thread', async ({ page }) => {
    await skipIfModelQuotaExhausted();
    const { conversationId } = await ask(page, IRON_SWORD);

    const sources = page.getByRole('region', { name: 'Fuentes' });
    await expect(sources).toHaveCount(1, { timeout: 90_000 });

    // Citations lead to the in-app reader rather than out to Fandom: that is
    // the point of the two halves being one app.
    const firstLink = sources.getByRole('link').first();
    await expect(firstLink).toHaveAttribute('href', /^\/wiki\/a\//);

    await firstLink.click();
    await expect(page).toHaveURL(/\/wiki\/a\//);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The original is still one tap away, for anyone who wants to check it.
    await expect(page.getByRole('link', { name: /Ver en la wiki original/ })).toHaveAttribute(
      'href',
      /valheim\.fandom\.com/,
    );

    // Back is the same conversation, not an empty chat, so a follow-up keeps its context.
    await page.goBack();
    await expect(page).toHaveURL(naming(conversationId));
    await expect(page.getByText(IRON_SWORD).last()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Fuentes' })).toHaveCount(1);
  });

  test('keeps the conversation in the sidebar, reopens it, and deletes it', async ({ page }) => {
    await skipIfModelQuotaExhausted();
    const { conversationId } = await ask(page, BONEMASS);
    await expect(page.getByRole('region', { name: 'Fuentes' })).toBeVisible({ timeout: 90_000 });
    await skipIfGenerationFailed(page);

    // This run's row: earlier runs may have left threads with the same title.
    const list = page.getByRole('navigation', { name: 'Consultas' });
    const row = list.getByRole('listitem').filter({ has: page.locator(`[id="conversation-open-${conversationId}"]`) });
    const thread = row.getByRole('button', { name: /Cómo invoco a Bonemass/ });
    await expect(thread).toBeVisible({ timeout: 20_000 });

    // Start a new thread, then reopen the old one: history must come back.
    await page.getByRole('button', { name: 'Nueva consulta' }).click();
    await expect(page.getByText(EMPTY)).toBeVisible();
    await expect(page).toHaveURL(NO_CONVERSATION);

    await thread.click();
    await expect(page.getByText(BONEMASS).last()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Fuentes' })).toBeVisible();
    await expect(page).toHaveURL(naming(conversationId));

    // The address alone opens it again.
    await page.reload();
    await expect(page.getByText(BONEMASS).last()).toBeVisible();

    // Deleted, it leaves the list, and the chat it was on starts afresh.
    const remove = row.getByRole('button', { name: 'Borrar consulta' });
    await waitForHydration(remove);
    page.once('dialog', (dialog) => void dialog.accept());
    await remove.click();
    await expect(row).toHaveCount(0);
    await expect(page.getByText(EMPTY)).toBeVisible();
    await expect(page).toHaveURL(NO_CONVERSATION);
  });

  test('switches the answer language', async ({ page }) => {
    await page.getByRole('group', { name: 'Idioma' }).getByRole('button', { name: 'English' }).click();
    await expect(page.getByPlaceholder('Ask about Valheim…')).toBeVisible();
    await expect(page.getByText('Ask anything about Valheim.')).toBeVisible();

    // The choice survives a reload, because it is stored in a cookie the
    // server reads during render.
    await page.reload();
    await expect(page.getByPlaceholder('Ask about Valheim…')).toBeVisible();
  });

  test('reports index size and freshness in the sidebar', async ({ page }) => {
    // The counts come from the database, so real numbers also prove the page
    // rendered against a populated index rather than an empty one.
    const panel = page.getByRole('region', { name: 'Índice' });
    // Reading order is term then definition ("páginas 1027"); the number is
    // only shown first visually, via CSS order.
    await expect(panel).toContainText(/páginas\s*\d{3,}/);
    await expect(panel).toContainText(/fragmentos\s*\d{3,}/);
    await expect(panel).toContainText(/Actualizado/);
    await expect(panel.getByRole('button', { name: /Actualizar índice/ })).toBeVisible();
  });

  test('explains that re-indexing is not wired up in this environment', async ({ page }) => {
    // Answered in the browser as a server without the GitHub dispatch answers:
    // where it is set up, the button really starts an ingest on the operator's
    // accounts, which no test should do.
    await page.route('**/api/ingest', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: 'not_configured' }) })
        : route.continue(),
    );
    await page.getByRole('button', { name: /Actualizar índice/ }).click();
    await expect(page.locator('main').getByRole('status')).toContainText('pnpm ingest', { timeout: 20_000 });
  });

  test.describe('when a question is refused', () => {
    test('says how long to wait, and holds the retry until then', async ({ page }) => {
      await page.route('**/api/chat', (route) =>
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'Retry-After': '41' },
          body: JSON.stringify({ error: 'rate_limited', bucket: 'chat:minute', retryAfter: 41 }),
        }),
      );
      await ask(page, IRON_SWORD);

      await expect(chatErrorBar(page)).toHaveText(
        /^Hiciste muchas consultas seguidas\. Esperá \d+ segundos y volvé a preguntar\.$/,
      );
      await expect(page.locator('main').getByRole('button', { name: /^Reintentar en \d+ s$/ })).toBeDisabled();
      // The server's own words never reach the page.
      await expect(page.locator('main')).not.toContainText('rate_limited');
    });

    test('sends an ended session to sign in again, back to this thread', async ({ page }) => {
      await page.route('**/api/chat', (route) =>
        route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) }),
      );
      const { conversationId } = await ask(page, IRON_SWORD);

      await expect(chatErrorBar(page)).toHaveText(
        'Tu sesión terminó. Volvé a conectarte para seguir con esta consulta.',
      );
      const signIn = page.locator('main').getByRole('link', { name: 'Conectarme de nuevo' });
      await expect(signIn).toHaveAttribute('href', `/login?next=${encodeURIComponent(`/?c=${conversationId}`)}`);
      // Asking again would only be refused again.
      await expect(page.locator('main').getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
      await expect(page.locator('main')).not.toContainText('unauthorized');
    });
  });
});

test.describe('accessibility and layout', () => {
  test('reaches the composer by keyboard alone', async ({ page }) => {
    await openApp(page);
    // The first stop skips straight to the question field.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Ir a la pregunta' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByPlaceholder(COMPOSER)).toBeFocused();
  });

  test('does not scroll horizontally on a phone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('opens the sidebar as a drawer on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);

    const menu = page.getByRole('button', { name: 'Consultas', exact: true });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.click();

    // A modal dialog, with focus inside it.
    const drawer = page.getByRole('dialog', { name: 'Consultas' });
    await expect(drawer).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(drawer.getByRole('button', { name: 'Cerrar la lista de consultas' })).toBeFocused();
    await expect(drawer.getByRole('button', { name: 'Nueva consulta' })).toBeVisible();

    // Escape closes it, and focus goes back to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(menu).toBeFocused();
  });
});
