import { expect, test, type Page } from '@playwright/test';

/**
 * Route stylesheets in the browser.
 *
 * globals.css (Tailwind and the shell) is every route's; the component CSS in
 * `src/app/styles/` is imported by the routes that draw it (route-css.test.ts
 * checks which). Two things only a browser can show: that a route's own rules
 * apply, on a first load and after a client-side navigation into it; and that
 * they rank where they should. Tailwind's stylesheet declares the cascade
 * layers, and only while it comes first do a route sheet's `@layer components`
 * rules land between Tailwind's base and its utilities. A route sheet that
 * came first would rank `components` below the preflight, and every list,
 * heading and table it styles would lose to it.
 *
 * Each probe is a computed value that only the route's own stylesheet sets.
 * Nothing here reaches a model, Puter or a translator.
 */

type Probe = { selector: string; property: string; value: string };

const ARTICLE: Probe[] = [
  { selector: '.article-body', property: 'overflow-wrap', value: 'break-word' }, // prose.css
  { selector: '.crumb', property: 'display', value: 'inline-flex' }, // prose.css
  { selector: '.stat-list', property: 'border-top-left-radius', value: '6px' }, // tables.css
  { selector: '.data-scroller', property: 'overflow-x', value: 'auto' }, // tables.css, from 640px
];
const GUIDE: Probe[] = [{ selector: '.g-page', property: 'padding-bottom', value: '40px' }];
const COMPARE: Probe[] = [{ selector: '.compare-scroller', property: 'overflow-x', value: 'auto' }];
const CHAT: Probe[] = [
  { selector: '.chat-answer', property: 'overflow-wrap', value: 'break-word' }, // prose.css, chat.css
  { selector: '.rune-chip', property: 'display', value: 'inline-flex' }, // chat.css
  { selector: '.answer-table', property: 'overflow-x', value: 'auto' }, // tables.css
];

const CONVERSATION_ID = 'e2e-route-css';
const CONVERSATION = {
  conversation: { id: CONVERSATION_ID, title: 'Espada de hierro', lang: 'es' },
  truncated: false,
  messages: [
    { id: `${CONVERSATION_ID}:q`, role: 'user', parts: [{ type: 'text', text: '¿Cuánto hierro lleva?' }], citations: [] },
    {
      id: `${CONVERSATION_ID}:q:a`,
      role: 'assistant',
      parts: [{ type: 'text', text: 'Se fabrica en la forja [1].\n\n| Nivel | Hierro |\n| --- | --- |\n| 1 | 20 |\n| 2 | 30 |' }],
      citations: [
        {
          n: 1,
          title: 'Iron sword',
          url: 'https://valheim.fandom.com/wiki/Iron_sword',
          sectionPath: '',
          source: 'fandom',
          score: 1,
          slug: 'iron-sword',
          image: null,
        },
      ],
      outcome: 'complete',
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/chat**', (route) => route.abort('blockedbyclient'));
  await page.route('**/api/wiki/translate**', (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"translation_disabled"}' }),
  );
  await page.route(/puter\.com/, (route) => route.abort('blockedbyclient'));
  await page.route(/\/api\/conversations(\/[^?]*)?(\?|$)/, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') return route.abort('blockedbyclient');
    if (path === '/api/conversations') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          conversations: [{ id: CONVERSATION_ID, title: 'Espada de hierro', lang: 'es', updatedAt: new Date().toISOString() }],
        }),
      });
    }
    if (path === `/api/conversations/${CONVERSATION_ID}`) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONVERSATION) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
  });
});

/** Tailwind's four layers, in the order the document ranks them. */
async function tailwindLayerOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const order: string[] = [];
    const note = (name: string) => {
      if (!order.includes(name)) order.push(name);
    };
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSLayerStatementRule) rule.nameList.forEach(note);
        else if (rule instanceof CSSLayerBlockRule) note(rule.name);
        else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) walk(rule.cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {
        // A sheet from another origin cannot be read; none of ours is.
      }
    }
    return order.filter((name) => ['theme', 'base', 'components', 'utilities'].includes(name));
  });
}

async function expectStyled(page: Page, probes: Probe[]): Promise<void> {
  for (const { selector, property, value } of probes) {
    const element = page.locator(selector).first();
    await expect(element).toBeAttached();
    // Polled: after a client-side navigation the route's stylesheet may still be arriving.
    await expect
      .poll(() => element.evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property), { message: `${selector} ${property}` })
      .toBe(value);
  }
  expect(await tailwindLayerOrder(page)).toEqual(['theme', 'base', 'components', 'utilities']);
}

test('each route brings its own stylesheet, ranked after the global one', async ({ page }) => {
  for (const [path, ready, probes] of [
    ['/wiki', 'h1', []],
    ['/wiki/browse', 'h1', []],
    ['/wiki/c/Weapons', 'h1', []],
    ['/wiki/c/Weapons?view=compare', '.compare-scroller', COMPARE],
    ['/wiki/a/iron-sword', '[data-testid="article-body"]', ARTICLE],
    ['/wiki/guide', '.g-page', GUIDE],
    [`/?c=${CONVERSATION_ID}`, '.rune-chip', CHAT],
  ] as const) {
    await test.step(path, async () => {
      await page.goto(path);
      await page.locator(ready).first().waitFor();
      await expectStyled(page, [...probes]);
    });
  }
});

type Marked = Window & { sameDocument?: boolean };

/**
 * Where a click or Back led, checked to be the same document: the point is a
 * client-side navigation, and a full load would bring every stylesheet anyway.
 */
async function arrived(page: Page, url: RegExp | ((url: URL) => boolean)): Promise<void> {
  await expect(page).toHaveURL(url);
  expect(await page.evaluate(() => (window as Marked).sameDocument === true), 'a client-side navigation, not a page load').toBe(true);
}

test('a client-side navigation brings each route its stylesheet, and Back keeps it', async ({ page }) => {
  await page.goto('/wiki/guide');
  await expectStyled(page, GUIDE);
  await page.evaluate(() => ((window as Marked).sameDocument = true));

  await page.locator('.g-page a.g-item[href^="/wiki/a/"]').first().click();
  await arrived(page, /\/wiki\/a\//);
  await page.locator('[data-testid="article-body"]').waitFor();
  await expectStyled(page, [ARTICLE[0]!, ARTICLE[1]!]);

  await page.locator('nav a[href="/wiki/browse"]').first().click();
  await arrived(page, /\/wiki\/browse$/);
  await page.locator('main a[href="/wiki/c/Weapons"]').first().click();
  await arrived(page, /\/wiki\/c\/Weapons$/);
  await page.locator('main a[href*="view=compare"]').first().click();
  await arrived(page, /view=compare/);
  await expectStyled(page, COMPARE);

  await page.locator('.compare-table a[href="/wiki/a/iron-sword"]').first().click();
  await arrived(page, /\/wiki\/a\/iron-sword$/);
  await expectStyled(page, ARTICLE);

  await page.locator('nav a[href="/"]').first().click();
  await arrived(page, (url) => url.pathname === '/');
  // The mocked conversation's own button (`conversation-open-<id>`, sidebar.tsx).
  await page.locator(`[id="conversation-open-${CONVERSATION_ID}"]`).click();
  await expectStyled(page, CHAT);

  await page.goBack();
  await arrived(page, /\/wiki\/a\/iron-sword$/);
  await expectStyled(page, ARTICLE);
  await page.goBack();
  await arrived(page, /view=compare/);
  await expectStyled(page, COMPARE);
});
