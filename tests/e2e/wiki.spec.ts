import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { refuseTranslations, waitForHydration } from './helpers';

/**
 * The wiki reader, exercised the way it is used: on a phone, one hand, with the
 * network sometimes gone, and in Spanish, the interface's default.
 *
 * Signed in with the session global setup saved, unless a block says
 * otherwise. No test lets the server translate an article: the page's own
 * request for one is answered in the browser (`refuseTranslations`).
 */

const PHONE = { width: 390, height: 844 };
/** The narrowest desktop layout: the infobox beside or above the text, tables kept as tables. */
const DESKTOP = { width: 1024, height: 768 };
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/**
 * Iron Sword as a Spanish reader sees it: the heading is its Spanish name, and
 * "ask about this" names it with the wiki's English name alongside.
 */
const IRON_SWORD = 'Espada de hierro';
const IRON_SWORD_QUESTION = 'Espada de hierro (Iron Sword)';

test.beforeEach(async ({ context }) => {
  await refuseTranslations(context);
});

async function openWiki(page: Page): Promise<void> {
  await page.goto('/wiki');
  const input = page.getByPlaceholder(/Buscá un objeto/);
  await expect(input).toBeVisible();
  // Typed into before the page hydrates, the field keeps the text and never searches it.
  await waitForHydration(input);
}

test.describe('search', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openWiki(page);
  });

  test('filters titles locally, with no request at all', async ({ page }) => {
    const input = page.getByPlaceholder(/Buscá un objeto/);

    // Let the title index arrive first; the claim under test is about what
    // happens once it has, not about how long it takes to download. The text
    // search for this first query goes out 250 ms after typing, and its
    // answer is awaited too, or it lands among the requests counted below.
    const firstSearch = page.waitForResponse((r) => {
      const url = new URL(r.url());
      return url.pathname === '/api/wiki/search' && url.searchParams.get('q') === 'iron';
    });
    await input.fill('iron');
    await expect(page.getByRole('link', { name: /Iron Sword/ }).first()).toBeVisible({
      timeout: 15_000,
    });
    await firstSearch;

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
    // The Spanish names are searched too, with the accents folded: "Núcleo negro",
    // "Núcleo de Surtling"…
    const results = page.getByRole('region', { name: 'Resultados de la búsqueda' });
    await expect(results.getByRole('link', { name: /Núcleo/ }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('reaches an article in one tap', async ({ page }) => {
    await page.getByPlaceholder(/Buscá un objeto/).fill('iron sword');
    await page.getByRole('link', { name: /Iron Sword/ }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: IRON_SWORD })).toBeVisible();
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

  const ARTICLE = '/wiki/a/iron-sword';
  const result = (page: Page, href = ARTICLE) => page.locator(`a[data-result][href="${href}"]`).first();

  /** Holds back the router's requests for `pathname` (`?_rsc=`), prefetches included. */
  async function holdBack(page: Page, pathname: string, ms: number): Promise<void> {
    await page.route(
      (url) => url.pathname === pathname && url.searchParams.has('_rsc'),
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        await route.continue().catch(() => {
          // The page moved on; nothing is waiting for this answer any more.
        });
      },
    );
  }

  /** How much of the progress bar shows: 0 while it is not there or out of sight. */
  const barOpacity = (page: Page): Promise<number> =>
    page.evaluate(() => {
      const bar = document.querySelector('.nav-progress');
      const style = bar ? getComputedStyle(bar) : null;
      return style && style.visibility === 'visible' ? Number(style.opacity) : 0;
    });

  test('keeps a result followed before the address has caught up', async ({ page }) => {
    // The address takes the query 300 ms after typing stops; a tap sooner
    // writes it first. That write once read as the address changing, put
    // the query before it back, and made Next drop the tapped page.
    const input = page.getByPlaceholder(/Buscá un objeto/);
    await input.fill('iron swor');
    await expect(result(page)).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/wiki\?q=iron\+swor$/);
    await holdBack(page, ARTICLE, 1500);

    await input.fill('iron sword');
    await result(page).click();
    await expect(page.getByRole('heading', { level: 1, name: IRON_SWORD })).toBeVisible();
    await expect(page).toHaveURL(/\/wiki\/a\/iron-sword$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/wiki\?q=iron\+sword$/);
    await expect(page.getByPlaceholder(/Buscá un objeto/)).toHaveValue('iron sword');
    await expect(result(page)).toBeVisible();
  });

  test('opens the first result on Enter, with the progress bar while it comes', async ({ page }) => {
    const input = page.getByPlaceholder(/Buscá un objeto/);
    await input.fill('iron sword');
    await expect(result(page)).toBeVisible({ timeout: 15_000 });
    await holdBack(page, ARTICLE, 1500);

    await input.press('Enter');
    await expect.poll(() => barOpacity(page)).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { level: 1, name: IRON_SWORD })).toBeVisible();
    await expect(page.locator('.nav-progress')).toHaveCount(0);

    await page.goBack();
    await expect(page.getByPlaceholder(/Buscá un objeto/)).toHaveValue('iron sword');
  });

  test('the search tab clears a search, and Back brings it back', async ({ page }) => {
    // The tabs along the top: on a phone-sized page `next dev` draws its
    // own badge over the first tab at the bottom.
    await page.setViewportSize(DESKTOP);
    const input = page.getByPlaceholder(/Buscá un objeto/);
    await input.fill('troll');
    await expect(result(page, '/wiki/a/troll')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/wiki\?q=troll$/);

    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('link', { name: 'Buscar', exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(page).toHaveURL(/\/wiki$/);
    await expect(page.getByRole('link', { name: /^Armas \d+ artículos$/ })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/wiki\?q=troll$/);
    await expect(input).toHaveValue('troll');
    await expect(result(page, '/wiki/a/troll')).toBeVisible();
  });

  test('the search tab, tapped while a result opened by Enter is on its way, clears the search', async ({ page }) => {
    // Enter sent with the query just typed writes it to the address past the
    // router, which never sees it: for the router the tab then leads to the
    // page it already shows. The page once took no notice either, kept the
    // query, and went on writing past the router for the rest of its life.
    await page.setViewportSize(DESKTOP);
    const input = page.getByPlaceholder(/Buscá un objeto/);
    const tab = page.getByRole('navigation', { name: 'Wiki' }).getByRole('link', { name: 'Buscar', exact: true });
    /**
     * The address shows a write at once, and the router takes it in a render
     * later. A tap in between reaches the page the router still shows (as
     * search-view.tsx's `linkToRouterPage` reads it); a reader's comes later.
     */
    const settled = async (address: RegExp): Promise<void> => {
      await expect(page).toHaveURL(address);
      await page.waitForTimeout(400);
    };
    /** The router's requests for `pathname` (`?_rsc=`) from now on: how many went out, how many are unanswered. */
    const requestsFor = (pathname: string): { sent: number; out: number } => {
      const count = { sent: 0, out: 0 };
      const ours = (request: { url(): string }): boolean => {
        const url = new URL(request.url());
        return url.pathname === pathname && url.searchParams.has('_rsc');
      };
      page.on('request', (request) => {
        if (!ours(request)) return;
        count.sent += 1;
        count.out += 1;
      });
      const answered = (request: { url(): string }): void => {
        if (ours(request)) count.out -= 1;
      };
      page.on('requestfinished', answered);
      page.on('requestfailed', answered);
      return count;
    };
    // The titles first, so Enter has its first result the moment the query is typed.
    await input.fill('iron');
    await expect(result(page)).toBeVisible({ timeout: 15_000 });
    await input.fill('');
    await settled(/\/wiki$/);
    await holdBack(page, ARTICLE, 3000);
    const article = requestsFor(ARTICLE);
    const search = requestsFor('/wiki');
    await page.evaluate(() => {
      const w = window as Window & { addressAtEnter?: string };
      w.addEventListener('submit', () => (w.addressAtEnter = location.search), { capture: true, once: true });
    });

    await input.fill('iron sword');
    await input.press('Enter');
    // Sent before the address had caught up, or this would test nothing.
    expect(await page.evaluate(() => (window as Window & { addressAtEnter?: string }).addressAtEnter)).toBe('');
    await expect(page).toHaveURL(/\/wiki\?q=iron\+sword$/);

    await tab.click();
    await expect(input).toHaveValue('');
    await expect(page).toHaveURL(/\/wiki$/);
    await expect(page.getByRole('link', { name: /^Armas \d+ artículos$/ })).toBeVisible();
    // The article it abandoned never comes, not even once its data has. The
    // search's own data, which the tab asked for again, is in by then too, and
    // the router is free for what follows (half a second without a request).
    let quietSince = 0;
    await expect
      .poll(
        () => {
          const busy = article.sent === 0 || search.sent === 0 || article.out + search.out > 0;
          quietSince = busy ? 0 : quietSince || Date.now();
          return quietSince > 0 && Date.now() - quietSince >= 500;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(page).toHaveURL(/\/wiki$/);
    await expect(page.getByRole('heading', { level: 1, name: IRON_SWORD })).toHaveCount(0);

    // And the address goes through the router again: the next search is an
    // entry of its own, which the tab leaves and Back returns to.
    await input.fill('troll');
    await expect(result(page, '/wiki/a/troll')).toBeVisible({ timeout: 15_000 });
    await settled(/\/wiki\?q=troll$/);
    await tab.click();
    await expect(input).toHaveValue('');
    await expect(page).toHaveURL(/\/wiki$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/wiki\?q=troll$/);
    await expect(input).toHaveValue('troll');
  });

  test('searches the address’s query on a copy of the page made without one', async ({ page }) => {
    // Offline, the service worker answers /wiki?q=… with the /wiki it saved.
    // Hydration has to draw what that HTML holds, or React throws the page
    // away and draws it again; the query from the address follows.
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route(
      (url) => url.pathname === '/wiki' && url.searchParams.get('q') === 'troll' && !url.searchParams.has('_rsc'),
      (route) =>
        route.request().resourceType() === 'document'
          ? route.continue({ url: new URL('/wiki', route.request().url()).href })
          : route.continue(),
    );
    await page.goto('/wiki?q=troll');
    const input = page.getByPlaceholder(/Buscá un objeto/);
    await waitForHydration(input);
    await expect(input).toHaveValue('troll');
    await expect(result(page, '/wiki/a/troll')).toBeVisible({ timeout: 15_000 });
    expect(errors.filter((error) => /hydrat|Minified React error #4(18|19|21|22|23|25)\b/i.test(error))).toEqual([]);
  });

  test('a tile and a result fetch their page once a pointer rests on them', async ({ page }) => {
    // A full prefetch is the request a tap makes: `RSC: 1`, with neither of
    // the router's prefetch headers (tests/e2e/prefetch.spec.ts has more).
    const fetched: string[] = [];
    page.on('request', (request) => {
      const headers = request.headers();
      if (headers['rsc'] !== '1' || headers['next-router-prefetch'] || headers['next-router-segment-prefetch']) return;
      const url = new URL(request.url());
      url.searchParams.delete('_rsc');
      fetched.push(url.pathname + url.search);
    });
    const response = await page.goto('/wiki');
    // `next dev` prefetches nothing; its policy, alone, allows `eval`.
    test.skip(/'unsafe-eval'/.test(response?.headers()['content-security-policy'] ?? ''), 'next dev prefetches nothing.');
    const input = page.getByPlaceholder(/Buscá un objeto/);
    await waitForHydration(input);
    // The router is handed to the wrappers in an effect after hydration.
    await page.waitForTimeout(300);

    const tile = page.locator('main a[href^="/wiki/c/all?biome="]').first();
    const tileHref = (await tile.getAttribute('href')) ?? '';
    await tile.hover();
    await expect.poll(() => fetched.filter((p) => p === tileHref).length, { message: tileHref }).toBe(1);

    await input.fill('troll');
    await expect(result(page, '/wiki/a/troll')).toBeVisible({ timeout: 15_000 });
    await result(page, '/wiki/a/troll').hover();
    await expect.poll(() => fetched.filter((p) => p === '/wiki/a/troll').length).toBe(1);
  });

  test('sends the ways in once, and before any script the field searches by GET', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: PHONE });
    const page = await context.newPage();
    await page.goto('/wiki');
    // Once in the document, and nothing React sent later to swap in: the
    // search used to arrive as a fallback copy, then again, hidden.
    await expect(page.locator('a[href="/wiki/c/Weapons"]')).toHaveCount(1);
    await expect(page.locator('#wiki-search')).toHaveCount(1);
    await expect(page.locator('body > [hidden][id^="S:"]')).toHaveCount(0);

    const input = page.getByPlaceholder(/Buscá un objeto/);
    await input.fill('iron');
    await input.press('Enter');
    await expect(page).toHaveURL(/\/wiki\?q=iron$/);
    await expect(page.getByPlaceholder(/Buscá un objeto/)).toHaveValue('iron');
    await context.close();
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
    // text rather than by role name. The labels are the article's own text:
    // Spanish where the article is translated, English where it is not.
    const weight = page.getByRole('term').filter({ hasText: /^(Peso|Weight)$/ });
    const durability = page.getByRole('term').filter({ hasText: /^(Durabilidad|Durability)$/ });

    await expect(weight).toBeVisible();
    await expect(durability).toBeVisible();

    // The value must be the one next to its own label, not merely present.
    await expect(durability.locator('..')).toContainText('200');
    await expect(weight.locator('..')).toContainText('0.8');
  });

  test('switches upgrade level, and the numbers change with it', async ({ page }) => {
    const durability = page
      .getByRole('term')
      .filter({ hasText: /^(Durabilidad|Durability)$/ })
      .locator('..');
    await expect(durability).toContainText('200');

    const level4 = page.getByRole('tab', { name: /Nivel 4/ });
    await waitForHydration(level4);
    await level4.click();
    await expect(durability).toContainText('350');
  });

  test('never scrolls the page sideways, however wide the tables', async ({ page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('links out to the original wiki', async ({ page }) => {
    const link = page.getByRole('link', { name: /Ver en la wiki original/ });
    await expect(link).toHaveAttribute('href', /valheim\.fandom\.com/);
  });

  test('offers to ask the chat about the article', async ({ page }) => {
    // The floating button: the end of the article says "Preguntarle al chat sobre…".
    const ask = page.getByRole('link', { name: /Preguntar sobre esto/ });
    await expect(ask).toHaveCount(1);
    await ask.click();

    // The question names the article as the reader sees it, with the wiki's name alongside.
    await expect(page).toHaveURL(/\/\?about=/);
    expect(new URL(page.url()).searchParams.get('about')).toBe(IRON_SWORD_QUESTION);
    await expect(page.getByPlaceholder('Preguntá sobre Valheim…')).toHaveValue(`${IRON_SWORD_QUESTION}: `);
  });

  test('reports an unknown article rather than erroring', async ({ page }) => {
    const response = await page.goto('/wiki/a/definitely-not-an-article');
    expect(response?.status()).toBe(404);
  });
});

test.describe('article on a desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  test('scrolls a wide table inside its own box', async ({ page }) => {
    // From 640px tables stay tables; Food's is wider than any column it gets.
    // Below that every table is a stack of cards, with nothing to scroll.
    await page.goto('/wiki/a/food');
    const scroller = page.getByTestId('table-scroller').first();
    await expect(scroller).toBeVisible();

    const scrollable = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(scrollable).toBe(true);
    // And a keyboard can reach the columns past the edge: a box that scrolls
    // becomes a named stop once its script has measured it.
    await expect(scroller).toHaveAttribute('role', 'region');
    await expect(scroller).toHaveAttribute('tabindex', '0');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('puts the level switch above the stats it changes', async ({ page }) => {
    // Spread over three columns above the text, the switch must not end up
    // beside or under the first column's groups.
    await page.goto('/wiki/a/huntsman-bow');
    await expect(page.getByRole('tablist')).toBeVisible();

    const layout = await page.evaluate(() => {
      const tablist = document.querySelector('[role="tablist"]');
      const panel = Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"]')).find(
        (el) => el.offsetParent !== null,
      );
      return {
        tablistBottom: tablist ? tablist.getBoundingClientRect().bottom : null,
        groupTops: panel
          ? Array.from(panel.querySelectorAll('.stat-group'), (group) => group.getBoundingClientRect().top)
          : [],
      };
    });
    expect(layout.tablistBottom).not.toBeNull();
    expect(layout.groupTops.length).toBeGreaterThan(0);
    for (const top of layout.groupTops) expect(top).toBeGreaterThanOrEqual(layout.tablistBottom!);
  });
});

test.describe('translation of an untranslated article', () => {
  // Troll has no Spanish translation in the corpus.
  const NOTE = 'Todavía no hay traducción de este artículo: se muestra en inglés.';
  const isTranslateRequest = (method: string, url: string): boolean =>
    method === 'POST' && new URL(url).pathname === '/api/wiki/translate';

  test('a reader is offered one once the article is on screen', async ({ page }) => {
    // The page asks as soon as it has hydrated and is in view.
    const asked = page.waitForRequest((r) => isTranslateRequest(r.method(), r.url()), { timeout: 30_000 });
    await page.goto('/wiki/a/troll');
    await waitForHydration(page.getByRole('heading', { level: 1 }));
    expect((await asked).postDataJSON()).toEqual({ slug: 'troll', lang: 'es' });

    // Answered in the browser as a spent allowance, which the page then says.
    await expect(page.getByText(/Se agotó el cupo de traducciones/)).toBeVisible();
    await expect(page.getByText(NOTE)).toHaveCount(0);
  });

  test.describe('read by a crawler', () => {
    test.use({ userAgent: GOOGLEBOT });

    test('says it is in English, and asks for nothing', async ({ page }) => {
      const asked: string[] = [];
      page.on('request', (r) => {
        if (isTranslateRequest(r.method(), r.url())) asked.push(r.url());
      });

      await page.goto('/wiki/a/troll');
      await expect(page.getByText(NOTE)).toBeVisible();

      // A reader's page asks as soon as it has hydrated; this one must not.
      await waitForHydration(page.getByRole('heading', { level: 1 }));
      await page.waitForLoadState('networkidle');
      expect(asked).toEqual([]);
    });
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
  });

  /**
   * What React sent later than the first bytes: a part that was not ready
   * arrives in a hidden element after the frame, and only its script moves
   * it into place, so with scripts off it stays hidden for good. These pages
   * render whole before anything is sent, so there must be none.
   */
  const streamedLater = (page: Page) => page.locator('body > [hidden][id^="S:"]');

  test('an article is all there', async ({ page }) => {
    await page.goto('/wiki/a/iron-sword');
    await expect(page.getByRole('heading', { level: 1, name: IRON_SWORD })).toBeVisible();
    const durability = page.getByRole('term').filter({ hasText: /^(Durabilidad|Durability)$/ });
    await expect(durability).toBeVisible();
    await expect(durability.locator('..')).toContainText('200');
    await expect(page.getByTestId('article-body')).toBeVisible();
    await expect(streamedLater(page)).toHaveCount(0);
  });

  test('a category is all there', async ({ page }) => {
    await page.goto('/wiki/c/Weapons');
    await expect(page.getByRole('heading', { level: 1, name: 'Armas' })).toBeVisible();
    await expect(page.getByText(/\d+ artículos/)).toBeVisible();
    await expect(page.getByRole('link', { name: /Iron Sword/ }).first()).toBeVisible();
    await expect(streamedLater(page)).toHaveCount(0);
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('asking about an article goes to the sign-in first, with the question kept', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/wiki/a/iron-sword');

    // One such link: the end of the article says "Preguntarle al chat sobre…".
    const ask = page.getByRole('link', { name: /Preguntar sobre esto/ });
    await expect(ask).toHaveCount(1);
    await ask.click();

    await expect(page).toHaveURL(/\/login\?next=%2F%3Fabout%3D/);
    const next = new URL(page.url()).searchParams.get('next') ?? '';
    expect(new URL(next, page.url()).searchParams.get('about')).toBe(IRON_SWORD_QUESTION);
  });
});

test.describe('browse and compare', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
  });

  test('lists categories, biomes and stations with counts', async ({ page }) => {
    await page.goto('/wiki/browse');
    // Names carry their counts, so these match one link each.
    await expect(page.getByRole('link', { name: /^Armas \d+ artículos$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Llanuras \d+ artículos$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Forja \d+ artículos$/ })).toBeVisible();
  });

  test('opens a category and lists its articles', async ({ page }) => {
    await page.goto('/wiki/c/Weapons');
    await expect(page.getByRole('heading', { level: 1, name: 'Armas' })).toBeVisible();
    await expect(page.getByText(/\d+ artículos/)).toBeVisible();
    await expect(page.getByRole('link', { name: /Sword/ }).first()).toBeVisible();
  });

  test('filters by a biome facet', async ({ page }) => {
    await page.goto('/wiki/c/all?biome=Plains');
    await expect(page.getByRole('heading', { level: 1, name: 'Llanuras' })).toBeVisible();
    await expect(page.getByText(/\d+ artículos/)).toBeVisible();
  });

  test('compares items in a table sorted by a stat', async ({ page }) => {
    await page.goto('/wiki/c/Weapons?view=compare');

    const table = page.getByRole('table');
    await expect(table).toBeVisible();

    const headers = table.getByRole('columnheader');
    expect(await headers.count()).toBeGreaterThan(1);

    // Sorting is a client-side reorder of rows already present.
    const sort = headers.nth(1).getByRole('button');
    await waitForHydration(sort);
    const firstBefore = await table.getByRole('row').nth(1).textContent();
    await sort.click();
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

  // The list/compare switch and the level tabs of a multi-word category used
  // to encode its name a second time (`Can't%2520be…`), into an empty page.
  test('opens the comparison of a multi-word category', async ({ page }) => {
    await page.goto("/wiki/c/Can't%20be%20Teleported");
    await expect(page.getByRole('heading', { level: 1, name: 'No teletransportables' })).toBeVisible();

    await page.getByRole('link', { name: 'Comparar' }).click();
    await expect(page).toHaveURL(/[?&]view=compare(&|$)/);
    expect(page.url()).toContain("/wiki/c/Can't%20be%20Teleported?");
    expect(page.url()).not.toContain('%25');
    await expect(page.getByRole('heading', { level: 1, name: 'No teletransportables' })).toBeVisible();
    await expect(page.getByRole('table').locator('tbody tr').first()).toBeVisible();
  });

  test('switches a multi-word comparison to another level', async ({ page }) => {
    await page.goto('/wiki/c/Forge%20recipes?view=compare');
    const level2 = page
      .getByRole('group', { name: 'Niveles de mejora' })
      .getByRole('link', { name: 'Nivel 2', exact: true });

    await level2.click();
    await expect(page).toHaveURL(/[?&]tab=2(&|$)/);
    expect(page.url()).not.toContain('%25');
    await expect(level2).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('table').locator('tbody tr').first()).toBeVisible();
  });

  test('cuts a long text cell at three lines', async ({ page }) => {
    // Materials, where Resina's "Origen" runs to eleven lines on a phone.
    // Food, which this guarded first, has had no cell longer than three lines
    // since its comparison lost its longest columns.
    await page.goto('/wiki/c/Materials?view=compare');
    await expect(page.getByRole('table')).toBeVisible();

    const cells = await page.locator('td > span.line-clamp-3').evaluateAll((spans) =>
      spans.map((span) => ({
        shown: span.clientHeight,
        full: span.scrollHeight,
        line: Number.parseFloat(getComputedStyle(span).lineHeight),
      })),
    );
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((cell) => Number.isFinite(cell.line))).toBe(true);
    // A clamp that stopped applying (a `block` beside `line-clamp-3` once did
    // that) lets the cell grow to its whole text.
    expect(cells.filter((cell) => cell.shown > 3 * cell.line + 1)).toEqual([]);
    // And some cell really is cut: its text runs on past what it shows.
    expect(cells.some((cell) => cell.full > cell.shown + cell.line / 2)).toBe(true);
  });
});

test.describe('addresses', () => {
  test('a category that does not exist is a real 404', async ({ page }) => {
    const response = await page.goto('/wiki/c/does-not-exist');
    expect(response?.status()).toBe(404);
  });

  test('a filter that matches nothing is a real 404', async ({ page }) => {
    // The page answers it, not the layout: a real status now that nothing is
    // sent before the page has rendered (it was a 200 marked noindex).
    for (const address of ['/wiki/c/all?biome=Junk', '/wiki/c/Weapons?biome=Junk&view=compare']) {
      const response = await page.goto(address);
      expect(response?.status(), address).toBe(404);
      await expect(page.getByRole('heading', { level: 1, name: 'Esta página no existe' })).toBeVisible();
    }
  });

  test('a category in another letter case moves to its own', async ({ page, request }) => {
    const response = await request.get('/wiki/c/weapons', { maxRedirects: 0 });
    expect(response.status()).toBe(308);

    await page.goto('/wiki/c/weapons');
    await expect(page).toHaveURL(/\/wiki\/c\/Weapons$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Armas' })).toBeVisible();
  });

  test('a category encoded twice moves to its own', async ({ page }) => {
    // What the broken switch linked to. The query goes: a layout is not given it.
    await page.goto('/wiki/c/Points%2520of%2520interest?view=compare');
    await expect(page).toHaveURL(/\/wiki\/c\/Points%20of%20interest$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Puntos de interés' })).toBeVisible();
  });

  test('every article, unfiltered, is the browse page', async ({ page, request }) => {
    // A real 308, from the proxy, before anything renders.
    const response = await request.get('/wiki/c/all', { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers()['location']).toMatch(/^(https?:\/\/[^/]+)?\/wiki\/browse$/);

    await page.goto('/wiki/c/all');
    await expect(page).toHaveURL(/\/wiki\/browse$/);
  });

  test("an article's name as the wiki spells it moves to its address", async ({ request }) => {
    const response = await request.get('/wiki/a/Iron_Sword', { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers()['location']).toMatch(/^(https?:\/\/[^/]+)?\/wiki\/a\/iron-sword$/);
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

  /**
   * Opens Iron Sword until the service worker has kept it, then reloads it
   * with the network cut. `devServer`: the page came from `next dev`, whose
   * policy alone allows `eval` (`contentSecurityPolicy`, proxy-policy.ts).
   */
  async function reloadOffline(page: Page, context: BrowserContext): Promise<{ devServer: boolean }> {
    await page.setViewportSize(PHONE);

    const response = await page.goto('/wiki/a/iron-sword');
    await expect(page.getByRole('heading', { level: 1, name: IRON_SWORD })).toBeVisible();
    const devServer = /'unsafe-eval'/.test(response?.headers()['content-security-policy'] ?? '');

    // Wait for the worker to take control, or nothing is cached yet.
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 30_000,
    });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: IRON_SWORD })).toBeVisible();

    await context.setOffline(true);
    await page.reload();
    return { devServer };
  }

  test('opens a visited article with the network cut', async ({ page, context }) => {
    await reloadOffline(page, context);
    await expect(page.getByRole('heading', { level: 1, name: IRON_SWORD })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('says the article is a saved copy', async ({ page, context }) => {
    const { devServer } = await reloadOffline(page, context);
    // The notice is drawn by script, and `next dev` hydrates no page while its
    // hot-reload socket cannot connect: offline, the saved copy stays inert.
    test.skip(devServer, 'next dev does not hydrate a page offline; a build does.');
    await expect(page.getByRole('status')).toContainText(/Sin conexión/, { timeout: 20_000 });
  });

  /*
   * A page opened through a link in the app never loads its own HTML. The
   * worker copies it once the page says it is shown (`ShownPages`, and
   * `keepShown` in public/sw.js), never for the router's request for it: a
   * prefetch, made when a reader only points at a link, is that same request.
   */
  test('opens with the network cut an article reached through a link', async ({ page, context }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/wiki/a/iron-sword');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 30_000 });

    const mention = page.locator('main article a.text-link[href^="/wiki/a/"]').first();
    await waitForHydration(mention);
    const href = (await mention.getAttribute('href')) ?? '';
    // A page load would be kept by the worker's other rule, as it passes.
    await page.evaluate(() => {
      (window as Window & { sameDocument?: boolean }).sameDocument = true;
    });
    await mention.click();
    await page.waitForURL((url) => url.pathname === href);
    const heading = page.locator('main article h1');
    await expect(heading).toBeVisible();
    const name = ((await heading.textContent()) ?? '').trim();
    expect(await page.evaluate(() => (window as Window & { sameDocument?: boolean }).sameDocument)).toBe(true);

    await expect
      .poll(() => page.evaluate(async (path) => (await caches.match(path)) !== undefined, href), {
        message: 'the worker kept the page it was shown',
        timeout: 60_000,
      })
      .toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 20_000 });
  });

  /*
   * A language switch moves no address, and the router's request for the
   * page in the new language copies nothing. The page says it is shown again
   * once the switch has rendered it (`ShownPages`), and the worker copies it
   * anew: the copy it holds is in the language the reader left.
   */
  test('keeps the page on screen in the language the reader switches to', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/wiki/a/iron-sword');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 30_000 });
    // Through the worker this time, which keeps the page as it passes.
    await page.reload();
    const savedLang = () =>
      page.evaluate(async () => {
        const saved = await caches.match('/wiki/a/iron-sword');
        return saved ? (/<html[^>]*\slang="([a-z]{2})"/.exec(await saved.text())?.[1] ?? null) : null;
      });
    await expect.poll(savedLang, { message: 'the worker kept the page in Spanish' }).toBe('es');

    const english = page.locator('nav button[lang="en"]').first();
    await waitForHydration(english);
    await english.click();
    await expect.poll(savedLang, { message: 'the worker kept the page again, in English', timeout: 60_000 }).toBe('en');
  });
});

test.describe('navigation', () => {
  test('moves between search, browse and chat from the tab bar', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openWiki(page);

    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('link', { name: 'Explorar' }).click();
    // Anchored: "Armas de asta" is a category of its own.
    await expect(page.getByRole('link', { name: /^Armas \d+ artículos$/ })).toBeVisible();

    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('link', { name: 'Chat' }).click();
    await expect(page.getByPlaceholder('Preguntá sobre Valheim…')).toBeVisible();
  });

  test('reaches the wiki from the chat sidebar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Wiki' }).click();
    await expect(page.getByPlaceholder(/Buscá un objeto/)).toBeVisible();
  });
});

/**
 * The bar along the top while a page is on its way (`NavProgress`): the page
 * on screen stays until the next one is ready, and the bar says the tap was
 * heard. The article's own response is held back here, so the change is slow
 * wherever the suite runs.
 */
test.describe('navigation feedback', () => {
  const ARTICLE = '/wiki/a/iron-sword';

  /** Holds back the router's requests for `pathname` (`?_rsc=`), prefetches included. */
  async function holdBack(page: Page, pathname: string, ms: number): Promise<void> {
    await page.route(
      (url) => url.pathname === pathname && url.searchParams.has('_rsc'),
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        await route.continue().catch(() => {
          // The page moved on; nothing is waiting for this answer any more.
        });
      },
    );
  }

  /**
   * How much of the bar shows: 0 while it is not there, or out of sight
   * (hidden during its first moments, faded out at the end).
   */
  const barOpacity = (page: Page): Promise<number> =>
    page.evaluate(() => {
      const bar = document.querySelector('.nav-progress');
      const style = bar ? getComputedStyle(bar) : null;
      return style && style.visibility === 'visible' ? Number(style.opacity) : 0;
    });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
  });

  test('answers a tap on a list, and clears once the article is up', async ({ page }) => {
    await page.goto('/wiki/c/Weapons');
    const link = page.locator(`main a[href="${ARTICLE}"]`).first();
    await waitForHydration(link);
    await holdBack(page, ARTICLE, 1500);

    await link.click();
    await expect.poll(() => barOpacity(page)).toBeGreaterThan(0);
    // A hairline on the top edge (there is no status bar here), while the list stays put.
    const box = await page.locator('.nav-progress').boundingBox();
    expect(box).toMatchObject({ y: 0, height: 2 });
    await expect(page.getByRole('heading', { level: 1, name: 'Armas' })).toBeVisible();

    await expect(page.getByRole('heading', { level: 1, name: IRON_SWORD })).toBeVisible();
    await expect(page.locator('.nav-progress')).toHaveCount(0);
  });

  test('answers a tap on a search result, and clears once the article is up', async ({ page }) => {
    await openWiki(page);
    await page.getByPlaceholder(/Buscá un objeto/).fill('iron sword');
    const result = page.locator(`a[data-result][href="${ARTICLE}"]`).first();
    await expect(result).toBeVisible({ timeout: 15_000 });
    // The query is in the address (`?q=`) by the time the reader taps.
    await expect(page).toHaveURL(/\/wiki\?q=iron\+sword$/);
    await holdBack(page, ARTICLE, 1500);

    await result.click();
    await expect.poll(() => barOpacity(page)).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { level: 1, name: IRON_SWORD })).toBeVisible();
    await expect(page.locator('.nav-progress')).toHaveCount(0);
  });

  /*
   * Next drops a change on its way whenever it starts another navigation or
   * a restore. The bar goes with it, rather than crawling on to its give-up;
   * the page held back here would not come for seconds yet.
   */

  test('goes as soon as the page writes its own address over the change', async ({ page }) => {
    await page.goto('/wiki/c/Weapons');
    const link = page.locator(`main a[href="${ARTICLE}"]`).first();
    await waitForHydration(link);
    await holdBack(page, ARTICLE, 6000);

    await link.click();
    await expect.poll(() => barOpacity(page)).toBeGreaterThan(0);
    // With no state, which Next takes in as a restore, and the restore drops
    // the article on its way. (The search page writes what is typed so, but
    // not once a tap on a link to another page has set it leaving.)
    await page.evaluate(() => window.history.replaceState(null, '', '/wiki/c/Weapons?c=abc'));
    await expect(page.locator('.nav-progress')).toHaveCount(0, { timeout: 3000 });
    await expect(page.getByRole('heading', { level: 1, name: 'Armas' })).toBeVisible();
  });

  test('goes on Back within the page, which Next restores in place of the change', async ({ page }) => {
    await page.goto('/wiki/c/Weapons');
    const link = page.locator(`main a[href="${ARTICLE}"]`).first();
    await waitForHydration(link);
    // A jump within the page first, so Back has an entry of this page to go to.
    await page.getByRole('link', { name: 'Saltar al contenido' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/wiki\/c\/Weapons#main$/);
    await holdBack(page, ARTICLE, 6000);

    await link.click();
    await expect.poll(() => barOpacity(page)).toBeGreaterThan(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/wiki\/c\/Weapons$/);
    await expect(page.locator('.nav-progress')).toHaveCount(0, { timeout: 3000 });
    await expect(page.getByRole('heading', { level: 1, name: 'Armas' })).toBeVisible();
  });

  test('goes when a tap takes the router to the page on screen instead', async ({ page }) => {
    await page.goto('/wiki/browse');
    const list = page.locator('main a[href="/wiki/c/Axes"]').first();
    await waitForHydration(list);
    await holdBack(page, '/wiki/c/Axes', 6000);

    await list.click();
    await expect.poll(() => barOpacity(page)).toBeGreaterThan(0);
    // The tab bar's own tab: a `<Link>` to the page on screen, which Next navigates to.
    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('link', { name: 'Explorar' }).click();
    await expect(page.locator('.nav-progress')).toHaveCount(0, { timeout: 3000 });
    await expect(page.getByRole('heading', { level: 1, name: 'Explorar' })).toBeVisible();
  });
});
