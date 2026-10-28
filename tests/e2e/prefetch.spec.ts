import { expect, test, type CDPSession, type Locator, type Page, type Request } from '@playwright/test';
import { refuseTranslations, waitForHydration } from './helpers';

/**
 * Intent prefetching in a production build (`IntentPrefetch`,
 * src/components/wiki/article/intent-prefetch.tsx): what the browser asks for
 * when a reader rests a pointer on a link, touches it or tabs to it, and what
 * the tap that follows still has to ask for.
 *
 * Reader links are rendered with `prefetch={false}`; the wrapper asks the
 * router for a full prefetch on intent. A full prefetch is the request a tap
 * makes (`RSC: 1`, no `Next-Router-Prefetch` header), so the two are told
 * apart by when they happen: before the tap, or after it. A route-tree
 * request (`Next-Router-Segment-Prefetch: /_tree`) may come first, for a kind
 * of page the router has not seen yet: it renders nothing on the server.
 * A page is asked for once while the router keeps it: again after a refresh
 * (a language switch) drops it, or once its five minutes are up.
 *
 * `next dev` prefetches nothing, so every test here skips against it (its CSP,
 * alone, allows `eval`). The service worker is blocked, as it fetches pages
 * of its own, except in the one test about what it fetches. Nothing here
 * reaches a model, Puter or a translator.
 */

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ context }) => {
  await refuseTranslations(context);
});

const ROWS = 'main ul li a[href^="/wiki/a/"]';

type Kind = 'tree' | 'prefetch' | 'full';
type Seen = { page: string; kind: Kind; at: number };

/** Every RSC request the page makes, by the page it is for (path and query, without `_rsc`). */
function recordRsc(page: Page): Seen[] {
  const seen: Seen[] = [];
  page.on('request', (request) => {
    const headers = request.headers();
    if (headers['rsc'] !== '1') return;
    seen.push({ page: pageOf(request.url()), kind: kindOf(headers), at: Date.now() });
  });
  return seen;
}

function pageOf(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('_rsc');
  return parsed.pathname + parsed.search;
}

function kindOf(headers: Record<string, string>): Kind {
  if (headers['next-router-segment-prefetch']) return 'tree';
  return headers['next-router-prefetch'] ? 'prefetch' : 'full';
}

const fullFor = (seen: Seen[], page: string, since = 0): Seen[] =>
  seen.filter((s) => s.page === page && s.kind === 'full' && s.at >= since);

/**
 * Resolves once the full prefetch of `page` has settled: its request
 * finished, or failed. Listening from before the pointer moves, so a request
 * that settles at once is not missed. Not `response.finished()`: on these
 * streamed responses it never resolved, though the request finished within
 * a fraction of a second, and each test waited out its whole timeout.
 */
function fullSettled(on: Page, page: string): Promise<void> {
  return new Promise((resolve) => {
    const settle = (request: Request): void => {
      const headers = request.headers();
      if (headers['rsc'] !== '1' || kindOf(headers) !== 'full' || pageOf(request.url()) !== page) return;
      on.off('requestfinished', settle);
      on.off('requestfailed', settle);
      resolve();
    };
    on.on('requestfinished', settle);
    on.on('requestfailed', settle);
  });
}

/** Opens a reader page and waits until the wrapper listens; skips against `next dev`. */
async function openReader(page: Page, path: string, wrapper: string): Promise<void> {
  const response = await page.goto(path);
  const devServer = /'unsafe-eval'/.test(response?.headers()['content-security-policy'] ?? '');
  test.skip(devServer, 'next dev prefetches nothing: run this file against a production build.');
  await waitForHydration(page.locator(wrapper).first());
  // The router is handed to the wrapper in an effect after hydration.
  await page.waitForTimeout(300);
}

async function hrefOf(link: Locator): Promise<string> {
  const href = await link.getAttribute('href');
  if (!href) throw new Error('link without an href');
  return href;
}

/** A pointer crossing `rows` on its way somewhere else, `ms` on each, in the page so the timing is exact. */
async function sweep(page: Page, selector: string, from: number, count: number, ms: number): Promise<string[]> {
  return page.evaluate(
    async ({ selector, from, count, ms }) => {
      const rows = [...document.querySelectorAll(selector)].slice(from, from + count);
      const fire = (type: string, el: Element, related: Element | null) =>
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, pointerType: 'mouse', relatedTarget: related }));
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        fire('pointerover', row, rows[i - 1] ?? document.body);
        await new Promise((resolve) => setTimeout(resolve, ms));
        fire('pointerout', row, rows[i + 1] ?? document.body);
      }
      return rows.map((row) => row.getAttribute('href') ?? '');
    },
    { selector, from, count, ms },
  );
}

test.describe('with a pointer', () => {
  test('a pointer resting on a row fetches its article, and the click that follows asks for nothing', async ({ page }) => {
    const seen = recordRsc(page);
    await openReader(page, '/wiki/c/Weapons', 'main > div');
    const row = page.locator(ROWS).nth(3);
    const href = await hrefOf(row);

    const prefetched = fullSettled(page, href);
    await row.hover();
    await prefetched;
    expect(fullFor(seen, href), 'one full prefetch for the row').toHaveLength(1);
    expect(seen.filter((s) => s.page === href && s.kind === 'tree').length).toBeLessThanOrEqual(1);

    const clickedAt = Date.now();
    await row.click();
    await page.waitForURL((url) => url.pathname === href);
    await expect(page.locator('main article h1')).toBeVisible();
    const shownIn = Date.now() - clickedAt;
    test.info().annotations.push({ type: 'prefetched click → heading', description: `${shownIn} ms` });
    expect(fullFor(seen, href, clickedAt), 'the click is answered from the prefetch').toEqual([]);
  });

  test('a pointer passing over rows fetches none of them; one that stops fetches that one', async ({ page }) => {
    const seen = recordRsc(page);
    await openReader(page, '/wiki/c/Weapons', 'main > div');

    const crossed = await sweep(page, ROWS, 20, 10, 25);
    await page.waitForTimeout(600);
    for (const href of crossed) expect(fullFor(seen, href), `${href} was only crossed`).toEqual([]);

    const stopped = page.locator(ROWS).nth(40);
    const href = await hrefOf(stopped);
    await stopped.hover();
    await expect.poll(() => fullFor(seen, href).length).toBe(1);
  });

  test('the same row is fetched once while the router keeps it, however often it is pointed at', async ({ page }) => {
    const seen = recordRsc(page);
    await openReader(page, '/wiki/c/Weapons', 'main > div');
    const row = page.locator(ROWS).nth(5);
    const href = await hrefOf(row);
    for (let i = 0; i < 3; i++) {
      await row.hover();
      await page.waitForTimeout(250);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(100);
    }
    expect(fullFor(seen, href)).toHaveLength(1);
  });

  test('a language switch drops what the router fetched, and the row pointed at again is fetched again', async ({ page }) => {
    const seen = recordRsc(page);
    await openReader(page, '/wiki/c/Weapons', 'main > div');
    // By its address: the list is in the reader's language, and its order may change with it.
    const href = await hrefOf(page.locator(ROWS).nth(5));
    const row = page.locator(`main ul li a[href="${href}"]`);
    await row.hover();
    await expect.poll(() => fullFor(seen, href).length).toBe(1);
    await page.mouse.move(2, 2);

    const from = await page.locator('html').getAttribute('lang');
    const to = from === 'en' ? 'es' : 'en';
    const switchedAt = Date.now();
    // The reader's switch sets the cookie and refreshes the router, which drops every prefetched page.
    await page.locator(`nav button[lang="${to}"]`).first().click();
    await expect(page.locator('html')).toHaveAttribute('lang', to);
    await row.hover();
    await expect.poll(() => fullFor(seen, href, switchedAt).length, { message: 'fetched again after the switch' }).toBe(1);
  });

  test('a row pointed at again after five minutes on the list is fetched again', async ({ page }) => {
    // The page's clock, which the router's own reckoning of five minutes reads too.
    await page.clock.install();
    const seen = recordRsc(page);
    await openReader(page, '/wiki/c/Weapons', 'main > div');
    const row = page.locator(ROWS).nth(6);
    const href = await hrefOf(row);
    await row.hover();
    await expect.poll(() => fullFor(seen, href).length).toBe(1);
    await page.mouse.move(2, 2);

    // A minute in: the router's copy is fresh, and asking for it again sends nothing.
    await page.clock.fastForward('01:00');
    await row.hover();
    await page.waitForTimeout(400);
    await page.mouse.move(2, 2);
    expect(fullFor(seen, href), 'the copy from a minute ago is used').toHaveLength(1);

    // Over five minutes in (`staleTimes.static`): it has gone stale, and is fetched anew.
    await page.clock.fastForward('04:30');
    const since = Date.now();
    await row.hover();
    await expect.poll(() => fullFor(seen, href, since).length, { message: 'fetched again once stale' }).toBe(1);
  });

  test('a click that is not a prefetched one waits for the server: the baseline', async ({ page }) => {
    const seen = recordRsc(page);
    await openReader(page, '/wiki/c/Weapons', 'main > div');
    const row = page.locator(ROWS).nth(7);
    const href = await hrefOf(row);
    // Focused and activated in one go, inside the 65 ms the focus must rest: the click drops
    // the wait, and the navigation fetches the page itself.
    const pressedAt = Date.now();
    await row.evaluate((link: HTMLElement) => {
      link.focus();
      link.click();
    });
    await page.waitForURL((url) => url.pathname === href);
    await expect(page.locator('main article h1')).toBeVisible();
    test.info().annotations.push({ type: 'unprefetched click → heading', description: `${Date.now() - pressedAt} ms` });
    expect(fullFor(seen, href), 'one request, the navigation’s own').toHaveLength(1);
  });

  test('the keyboard focus resting on a row fetches it', async ({ page }) => {
    const seen = recordRsc(page);
    await openReader(page, '/wiki/c/Weapons', 'main > div');
    const row = page.locator(ROWS).nth(9);
    const href = await hrefOf(row);
    await row.focus();
    await expect.poll(() => fullFor(seen, href).length).toBe(1);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function touch(cdp: CDPSession, link: Locator, type: 'touchStart' | 'touchCancel'): Promise<void> {
    await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox();
    if (!box) throw new Error('row not on screen');
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchStart' ? [point] : [] });
  }

  test('a finger landing on a row fetches it at once, and a tap uses the fetch on its way', async ({ page, context }) => {
    const seen = recordRsc(page);
    await openReader(page, '/wiki/c/Weapons', 'main > div');
    const cdp = await context.newCDPSession(page);

    // A finger that lands and lifts off without a tap (a scroll would): fetched, nothing opened.
    const first = page.locator(ROWS).nth(2);
    const firstHref = await hrefOf(first);
    const touchedAt = Date.now();
    await touch(cdp, first, 'touchStart');
    await expect.poll(() => fullFor(seen, firstHref).length, { timeout: 5_000 }).toBe(1);
    test.info().annotations.push({ type: 'touchstart → request', description: `${fullFor(seen, firstHref)[0]!.at - touchedAt} ms` });
    await touch(cdp, first, 'touchCancel');

    // A tap: the touch fetches the page and the click comes right after, while it is on its way.
    // The router knows this kind of page by now, so the click waits for that fetch instead of
    // asking again.
    const tapped = page.locator(ROWS).nth(6);
    const tappedHref = await hrefOf(tapped);
    const tappedAt = Date.now();
    await tapped.tap();
    await page.waitForURL((url) => url.pathname === tappedHref);
    await expect(page.locator('main article h1')).toBeVisible();
    test.info().annotations.push({ type: 'tap → heading', description: `${Date.now() - tappedAt} ms` });
    expect(fullFor(seen, tappedHref), 'one request for the tapped page: the touch prefetch').toHaveLength(1);
  });
});

test.describe('where the reader pays for every byte', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const network of [{ saveData: true, effectiveType: '4g' }, { saveData: false, effectiveType: '2g' }]) {
    test(`nothing is prefetched on ${JSON.stringify(network)}`, async ({ page }) => {
      await page.addInitScript((hints) => {
        Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => hints });
      }, network);
      const seen = recordRsc(page);
      await openReader(page, '/wiki/c/Weapons', 'main > div');
      const row = page.locator(ROWS).nth(4);
      const href = await hrefOf(row);
      await row.hover();
      await row.focus();
      await page.waitForTimeout(600);
      expect(fullFor(seen, href)).toEqual([]);
    });
  }
});

test.describe('other reader pages', () => {
  test('browse: a biome tile, a category named under the tiles, the guide card', async ({ page }) => {
    const seen = recordRsc(page);
    await openReader(page, '/wiki/browse', 'main > div');
    const links = [
      page.locator('main a[href^="/wiki/c/all?biome="]').first(),
      page.locator('main ul.flex-wrap a[href^="/wiki/c/"]').first(),
      page.locator('main a[href="/wiki/guide"]').first(),
    ];
    for (const link of links) {
      const href = await hrefOf(link);
      await link.hover();
      await expect.poll(() => fullFor(seen, href).length, { message: href }).toBe(1);
    }
  });

  test('the comparison: a name in the table, and a level other than the one on screen', async ({ page }) => {
    const seen = recordRsc(page);
    await openReader(page, '/wiki/c/Weapons?view=compare', 'main > div');
    const name = page.locator('.compare-table tbody th a[href^="/wiki/a/"]').nth(2);
    const nameHref = await hrefOf(name);
    await name.hover();
    await expect.poll(() => fullFor(seen, nameHref).length).toBe(1);

    const current = page.locator('main a[href*="tab="][aria-current="page"]').first();
    const currentHref = await hrefOf(current);
    await current.hover();
    await page.waitForTimeout(400);
    expect(fullFor(seen, currentHref), 'the level on screen, under another address').toEqual([]);
  });

  test('the guide: an item chip with an article, not one that opens the original wiki', async ({ page }) => {
    const seen = recordRsc(page);
    await openReader(page, '/wiki/guide', 'article.g-body');
    const chip = page.locator('article.g-body a.g-item[href^="/wiki/a/"]').first();
    const href = await hrefOf(chip);
    await chip.hover();
    await expect.poll(() => fullFor(seen, href).length).toBe(1);
  });

  test('an article: a mention is fetched; the chat is never', async ({ page }) => {
    const seen = recordRsc(page);
    await openReader(page, '/wiki/a/iron-sword', 'main > article');
    const mention = page.locator('main article a.text-link[href^="/wiki/a/"]').first();
    const href = await hrefOf(mention);
    await mention.hover();
    await expect.poll(() => fullFor(seen, href).length).toBe(1);

    // Only full prefetches count: the tab bar's own chat link may have its route tree fetched on sight.
    const ask = page.locator('main article a[href^="/?about="], main article a[href^="/login"]').first();
    await ask.hover();
    await page.waitForTimeout(400);
    const chat = seen.filter((s) => s.kind === 'full' && (s.page === '/' || s.page.startsWith('/?') || s.page.startsWith('/login')));
    expect(chat).toEqual([]);
  });
});

test.describe('with the service worker in control', () => {
  test.use({ serviceWorkers: 'allow' });

  /*
   * A full prefetch is the request a tap makes, so public/sw.js copies a page
   * for offline reading only once the page says it is shown (`keepShown`,
   * `ShownPages`), never on the router's request for it. Copying on that
   * request rendered and downloaded every page pointed at a second time, and
   * saved it over pages the reader did read; this keeps that from coming back.
   */
  test('the worker does not download a page the reader only pointed at', async ({ page, context }) => {
    const fromWorker: { page: string; html: boolean }[] = [];
    context.on('request', (request) => {
      if (!request.serviceWorker()) return;
      fromWorker.push({ page: pageOf(request.url()), html: (request.headers()['accept'] ?? '').includes('text/html') });
    });
    await openReader(page, '/wiki/c/Weapons', 'main > div');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
    // Its install fetches the offline page: the worker's own requests can be seen, so none below means none.
    await expect.poll(() => fromWorker.length, { message: 'the worker’s requests are observable' }).toBeGreaterThan(0);

    const row = page.locator(ROWS).nth(11);
    const href = await hrefOf(row);
    const prefetched = fullSettled(page, href);
    await row.hover();
    await prefetched;
    await page.waitForTimeout(3_000);
    expect(
      fromWorker.filter((request) => request.page === href && request.html),
      'the worker downloaded a page that was only prefetched',
    ).toEqual([]);
  });
});
