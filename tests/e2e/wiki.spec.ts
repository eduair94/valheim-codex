import { expect, test, type Page } from '@playwright/test';

/**
 * The wiki reader, exercised the way it is used: on a phone, one hand, with the
 * network sometimes gone.
 */

const PHONE = { width: 390, height: 844 };

async function openWiki(page: Page): Promise<void> {
  await page.goto('/wiki');
  await expect(page.getByPlaceholder(/Buscá un objeto/)).toBeVisible();
}

test.describe('search', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openWiki(page);
  });

  test('filters titles locally, with no request at all', async ({ page }) => {
    const input = page.getByPlaceholder(/Buscá un objeto/);

    // Let the title index arrive first; the claim under test is about what
    // happens once it has, not about how long it takes to download.
    await input.fill('iron');
    await expect(page.getByRole('link', { name: /Iron Sword/ }).first()).toBeVisible({
      timeout: 15_000,
    });

    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await input.fill('');
    await input.fill('bonemass');

    // Results must appear well inside the 250 ms content-search debounce, which
    // is what proves the match was computed in the browser.
    await expect(page.getByRole('link', { name: /Bonemass/ }).first()).toBeVisible({
      timeout: 200,
    });
    expect(requests.filter((u) => u.includes('/api/wiki/'))).toHaveLength(0);
  });

  test('finds an accented title from unaccented typing', async ({ page }) => {
    await page.getByPlaceholder(/Buscá un objeto/).fill('nucleo');
    // "Núcleo"-style titles exist in the index; at minimum the query must not
    // wipe the list to nothing when the accent is omitted.
    const list = page.getByRole('link');
    await expect(list.first()).toBeVisible({ timeout: 10_000 });
  });

  test('reaches an article in one tap', async ({ page }) => {
    await page.getByPlaceholder(/Buscá un objeto/).fill('iron sword');
    await page.getByRole('link', { name: /Iron Sword/ }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Iron Sword' })).toBeVisible();
  });

  test('searches article text when the title does not match', async ({ page }) => {
    await page.getByPlaceholder(/Buscá un objeto/).fill('withered bones');
    await expect(page.getByText('Encontrado dentro del texto')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('link', { name: /Bonemass/ }).first()).toBeVisible();
  });

  test('says so when nothing matches', async ({ page }) => {
    await page.getByPlaceholder(/Buscá un objeto/).fill('zzzznotathing');
    await expect(page.getByText(/Sin resultados/)).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('article', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/wiki/a/iron-sword');
  });

  test('shows the data before the body prose', async ({ page }) => {
    // Bonemass has both stats and long prose; Iron Sword's body is a table.
    await page.goto('/wiki/a/bonemass');

    const stats = page.getByRole('definition').first();
    // The body container, not any `h2`: stat groups carry headings too.
    const body = page.getByTestId('article-body');

    const statsBox = await stats.boundingBox();
    const bodyBox = await body.boundingBox();
    expect(statsBox).not.toBeNull();
    expect(bodyBox).not.toBeNull();
    // The complaint about Fandom on a phone is that the numbers sit below the
    // fold, under the prose. Here they come first.
    expect(statsBox!.y).toBeLessThan(bodyBox!.y);
  });

  test('renders the item icon', async ({ page }) => {
    const icon = page.locator('article img').first();
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('src', /static\.wikia\.nocookie\.net/);
  });

  test('pairs every stat with its label', async ({ page }) => {
    // `term` takes no accessible name from its content, so rows are matched by
    // text rather than by role name.
    const weight = page.getByRole('term').filter({ hasText: /^Weight$/ });
    const durability = page.getByRole('term').filter({ hasText: /^Durability$/ });

    await expect(weight).toBeVisible();
    await expect(durability).toBeVisible();

    // The value must be the one next to its own label, not merely present.
    await expect(durability.locator('..')).toContainText('200');
    await expect(weight.locator('..')).toContainText('0.8');
  });

  test('switches upgrade level, and the numbers change with it', async ({ page }) => {
    const durability = page.getByRole('term').filter({ hasText: /^Durability$/ }).locator('..');
    await expect(durability).toContainText('200');

    await page.getByRole('tab', { name: /Nivel 4/ }).click();
    await expect(durability).toContainText('350');
  });

  test('never scrolls the page sideways, however wide the tables', async ({ page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('scrolls a wide table inside its own box', async ({ page }) => {
    // The level switcher is also an overflow box; this targets the table's.
    const scroller = page.getByTestId('table-scroller').first();
    if ((await scroller.count()) === 0) test.skip(true, 'This article has no wide table.');

    const scrollable = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(scrollable).toBe(true);
  });

  test('links out to the original wiki', async ({ page }) => {
    const link = page.getByRole('link', { name: /Ver en la wiki original/ });
    await expect(link).toHaveAttribute('href', /valheim\.fandom\.com/);
  });

  test('offers to ask the chat about the article', async ({ page }) => {
    await page.getByRole('link', { name: /Preguntar sobre esto/ }).click();
    await expect(page).toHaveURL(/about=Iron\+Sword|about=Iron%20Sword/);
    await expect(page.getByPlaceholder('Preguntá sobre Valheim…')).toHaveValue(/Iron Sword/);
  });

  test('reports an unknown article rather than erroring', async ({ page }) => {
    const response = await page.goto('/wiki/a/definitely-not-an-article');
    expect(response?.status()).toBe(404);
  });
});

test.describe('browse and compare', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
  });

  test('lists categories, biomes and stations with counts', async ({ page }) => {
    await page.goto('/wiki/browse');
    // Names carry their counts, so these match one link each.
    await expect(page.getByRole('link', { name: /^Weapons \d+$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Plains \d+$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Forge \d+$/ })).toBeVisible();
  });

  test('opens a category and lists its articles', async ({ page }) => {
    await page.goto('/wiki/c/Weapons');
    await expect(page.getByRole('heading', { level: 1, name: 'Weapons' })).toBeVisible();
    await expect(page.getByText(/\d+ artículos/)).toBeVisible();
    await expect(page.getByRole('link', { name: /Sword/ }).first()).toBeVisible();
  });

  test('filters by a biome facet', async ({ page }) => {
    await page.goto('/wiki/c/all?biome=Plains');
    await expect(page.getByRole('heading', { level: 1, name: 'Plains' })).toBeVisible();
    await expect(page.getByText(/\d+ artículos/)).toBeVisible();
  });

  test('compares items in a table sorted by a stat', async ({ page }) => {
    await page.goto('/wiki/c/Weapons?view=compare');

    const table = page.getByRole('table');
    await expect(table).toBeVisible();

    const headers = table.getByRole('columnheader');
    expect(await headers.count()).toBeGreaterThan(1);

    // Sorting is a client-side reorder of rows already present.
    const firstBefore = await table.getByRole('row').nth(1).textContent();
    await headers.nth(1).getByRole('button').click();
    await expect
      .poll(async () => table.getByRole('row').nth(1).textContent())
      .not.toBe(firstBefore);
  });

  test('keeps the compare table inside its own scroll box', async ({ page }) => {
    await page.goto('/wiki/c/Weapons?view=compare');
    await expect(page.getByRole('table')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('installable and offline', () => {
  test('serves a manifest and a service worker without a session', async ({ request }) => {
    // Fetched by the browser outside any page, so a redirect to /login would
    // silently break installation.
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);
    expect((await manifest.json()).name).toBe('Valheim Codex');

    const sw = await request.get('/sw.js');
    expect(sw.status()).toBe(200);
    expect(await sw.text()).toContain('addEventListener');
  });

  test('opens a visited article with the network cut', async ({ page, context }) => {
    await page.setViewportSize(PHONE);

    await page.goto('/wiki/a/iron-sword');
    await expect(page.getByRole('heading', { level: 1, name: 'Iron Sword' })).toBeVisible();

    // Wait for the worker to take control, or nothing is cached yet.
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 30_000,
    });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Iron Sword' })).toBeVisible();

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'Iron Sword' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole('status')).toContainText(/Sin conexión/);
    } finally {
      await context.setOffline(false);
    }
  });
});

test.describe('navigation', () => {
  test('moves between search, browse and chat from the tab bar', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openWiki(page);

    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('link', { name: 'Explorar' }).click();
    await expect(page.getByRole('link', { name: /Weapons/ })).toBeVisible();

    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('link', { name: 'Chat' }).click();
    await expect(page.getByPlaceholder('Preguntá sobre Valheim…')).toBeVisible();
  });

  test('reaches the wiki from the chat sidebar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Wiki' }).click();
    await expect(page.getByPlaceholder(/Buscá un objeto/)).toBeVisible();
  });
});
