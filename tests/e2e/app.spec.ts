import { expect, test, type Page } from '@playwright/test';
import { skipIfModelQuotaExhausted } from './helpers';

/**
 * These tests run with the session saved by global setup, so they open the app
 * signed in. The sign-in flow itself lives in auth.spec.ts.
 */
async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByPlaceholder('Preguntá sobre Valheim…')).toBeVisible();
}

test.describe('chat', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('shows the empty state with runnable examples', async ({ page }) => {
    await expect(page.getByText('Preguntá lo que necesites saber de Valheim.')).toBeVisible();
    await expect(
      page.getByRole('button', { name: '¿Qué necesito para forjar una espada de hierro?' }),
    ).toBeVisible();
  });

  test('answers a question, streams it, and cites the wiki', async ({ page }) => {
    await skipIfModelQuotaExhausted();
    await page.getByPlaceholder('Preguntá sobre Valheim…').fill('¿Qué necesito para forjar una espada de hierro?');
    await page.getByRole('button', { name: 'Preguntar' }).click();

    // The question is echoed straight away.
    await expect(page.getByText('¿Qué necesito para forjar una espada de hierro?').last()).toBeVisible();

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

    // And it carries at least one citation marker tied to a source.
    await expect(article.locator('.rune-chip').first()).toBeVisible();
  });

  test('a citation opens the article inside the app', async ({ page }) => {
    await skipIfModelQuotaExhausted();
    await page.getByPlaceholder('Preguntá sobre Valheim…').fill('¿Qué necesito para forjar una espada de hierro?');
    await page.getByRole('button', { name: 'Preguntar' }).click();

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
  });

  test('keeps the conversation in the sidebar and reopens it', async ({ page }) => {
    await skipIfModelQuotaExhausted();
    await page.getByPlaceholder('Preguntá sobre Valheim…').fill('¿Cómo invoco a Bonemass?');
    await page.getByRole('button', { name: 'Preguntar' }).click();
    await expect(page.getByRole('region', { name: 'Fuentes' })).toBeVisible({ timeout: 90_000 });

    const thread = page.getByRole('navigation', { name: 'Consultas' }).getByRole('button', {
      name: /Cómo invoco a Bonemass/,
    });
    await expect(thread).toBeVisible({ timeout: 20_000 });

    // Start a new thread, then reopen the old one: history must come back.
    await page.getByRole('button', { name: 'Nueva consulta' }).click();
    await expect(page.getByText('Preguntá lo que necesites saber de Valheim.')).toBeVisible();

    await thread.click();
    await expect(page.getByText('¿Cómo invoco a Bonemass?').last()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Fuentes' })).toBeVisible();
  });

  test('switches the answer language', async ({ page }) => {
    await page.getByRole('group', { name: 'Idioma' }).getByRole('button', { name: 'en' }).click();
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
    await page.getByRole('button', { name: /Actualizar índice/ }).click();
    await expect(page.getByRole('status')).toContainText('pnpm ingest', { timeout: 20_000 });
  });
});

test.describe('accessibility and layout', () => {
  test('reaches the composer by keyboard alone', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.tagName ?? '');
    expect(focused).not.toBe('BODY');
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
    await page.getByRole('button', { name: 'Consultas' }).first().click();
    await expect(page.getByRole('button', { name: 'Nueva consulta' })).toBeVisible();
  });
});
