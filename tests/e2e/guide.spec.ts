import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The completion guide: twenty phone screens of checklist, read on a phone
 * mid-game, in either language.
 */

const PHONE = { width: 360, height: 740 };

/** How far a place may be off after coming Back: less than a line of text. */
const PLACE_TOLERANCE_PX = 24;

async function openGuide(page: Page, lang: 'es' | 'en'): Promise<void> {
  await page.setViewportSize(PHONE);
  await page.goto('/wiki/guide');
  await page.evaluate((value) => {
    document.cookie = `wv_lang=${value}; path=/`;
  }, lang);
  await page.reload();
  // Hydrated, so the contents sheet closes itself on a choice. Before that it
  // still opens, jumps and closes natively, but only by its own close button.
  await page.waitForLoadState('networkidle');
}

/**
 * Scrolls the way a reader does, a little at a time, until `target` sits in
 * the upper part of the screen, so every chapter on the way is drawn as it
 * comes (they are skipped until they near the screen). Returns its top.
 */
async function readDownTo(page: Page, target: Locator): Promise<number> {
  await page.mouse.move(PHONE.width / 2, PHONE.height / 2);
  for (let i = 0; i < 400; i++) {
    const y = (await target.boundingBox())?.y;
    if (y !== undefined && y > 150 && y < 400) break;
    await page.mouse.wheel(0, y !== undefined && y < 1400 ? (y > 400 ? 120 : -120) : 600);
    await page.waitForTimeout(40);
  }
  // Long enough for the place to be written down (guide-place.tsx).
  await page.waitForTimeout(500);
  const top = (await target.boundingBox())?.y;
  expect(top).toBeDefined();
  return top ?? 0;
}

type Watched = Window & { progressBarShown?: boolean };

/** Notes whether the shell's page-change bar (`NavProgress`) is ever put on the page from now on. */
async function watchForProgressBar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Watched;
    w.progressBarShown = false;
    new MutationObserver(() => {
      if (document.querySelector('.nav-progress')) w.progressBarShown = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
}

async function progressBarShown(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as Watched).progressBarShown === true);
}

/**
 * Leaves the guide through one of the app's own links (the chat tab, signed
 * in or not), then comes Back.
 */
async function leaveAndComeBack(page: Page): Promise<void> {
  await page.getByRole('link', { name: /^Chat/ }).first().click();
  await page.waitForURL((url) => url.pathname !== '/wiki/guide');
  await page.goBack();
  await page.waitForURL(/\/wiki\/guide/);
}

for (const lang of ['es', 'en'] as const) {
  test.describe(`guide (${lang})`, () => {
    test.beforeEach(async ({ page }) => {
      await openGuide(page, lang);
    });

    test('never scrolls sideways on a narrow phone', async ({ page }) => {
      // Every chapter drawn, so a wide run inside one still off screen counts too.
      // One chip run (Staff of Embers / Frost / Protection) once widened the page to 424px.
      await page.addStyleTag({ content: '.g-cv,.g-chapter{content-visibility:visible!important}' });
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    });

    test('keeps every item name in one piece', async ({ page }) => {
      // A name broken over two lines kept a background per half and read as two items.
      await page.addStyleTag({ content: '.g-cv,.g-chapter{content-visibility:visible!important}' });
      const split = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#guide .g-item'))
          .filter((chip) => Array.from(chip.getClientRects()).filter((r) => r.width > 1).length > 1)
          .map((chip) => chip.textContent),
      );
      expect(split).toEqual([]);
    });

    test('is the whole guide, not a notice', async ({ page }) => {
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        lang === 'es' ? 'Guía 100%' : '100% Guide',
      );
      expect(await page.locator('#guide input[type="checkbox"]').count()).toBeGreaterThan(50);
    });

    test('opens the contents from the pill and lands on the chapter', async ({ page }) => {
      await page.locator('.g-toc-pill').click();
      const sheet = page.locator('#guide-toc-sheet');
      await expect(sheet).toBeVisible();
      await watchForProgressBar(page);

      await sheet.locator('a[href="#plains"]').click();
      await expect(sheet).toBeHidden();
      await expect(page).toHaveURL(/#plains$/);
      const top = await page.locator('#plains').evaluate((el) => el.getBoundingClientRect().top);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThan(80);
      // A jump within the page is no page change: nothing to wait for.
      expect(await progressBarShown(page)).toBe(false);
    });

    test('closes the contents when focus moves on past them', async ({ page }) => {
      await page.locator('.g-toc-pill').focus();
      await page.keyboard.press('Enter');
      const sheet = page.locator('#guide-toc-sheet');
      await expect(sheet).toBeVisible();

      const stops = await sheet.locator('a, button').count();
      for (let i = 0; i <= stops; i++) await page.keyboard.press('Tab');
      await expect(sheet).toBeHidden();
      // Whatever has focus now is on the page, in sight, not under a sheet.
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        const box = el?.getBoundingClientRect();
        return { inSheet: !!el?.closest('#guide-toc-sheet'), inGuide: !!el?.closest('#guide'), height: box?.height ?? 0 };
      });
      expect(focused).toMatchObject({ inSheet: false, inGuide: true });
      expect(focused.height).toBeGreaterThan(0);
    });

    test('comes Back to the same place after a trip to another page', async ({ page }) => {
      const chip = page.locator('#mistlands .g-item', { hasText: 'Staff of Embers' });
      const top = await readDownTo(page, chip);
      // Ticked where it is, without the scroll into view a `check()` would make.
      await page.locator('#ml-x1').evaluate((box) => (box as HTMLInputElement).click());

      await leaveAndComeBack(page);
      await expect
        .poll(async () => Math.abs(((await chip.boundingBox())?.y ?? Infinity) - top))
        .toBeLessThanOrEqual(PLACE_TOLERANCE_PX);
      await expect(page.locator('#ml-x1')).toBeChecked();
    });

    test('comes Back to where the reader had read on to after a jump from the contents', async ({ page }) => {
      await page.locator('.g-toc-pill').click();
      await page.locator('#guide-toc-sheet a[href="#plains"]').click();
      await expect(page).toHaveURL(/#plains$/);
      const chapter = page.locator('#plains');
      await page.mouse.move(PHONE.width / 2, PHONE.height / 2);
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(600);
      const top = (await chapter.boundingBox())?.y ?? 0;

      await leaveAndComeBack(page);
      // The guide itself, not the page left behind under the guide's address.
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(lang === 'es' ? 'Guía 100%' : '100% Guide');
      await expect
        .poll(async () => Math.abs(((await chapter.boundingBox())?.y ?? Infinity) - top))
        .toBeLessThanOrEqual(PLACE_TOLERANCE_PX);
    });
  });
}
