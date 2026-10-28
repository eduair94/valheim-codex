import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { CRAFT_PLANNER_LIVE } from '@/lib/craft/feature';
import { SITE_URL } from '@/lib/site';
import { withLang } from '../helpers/lang';

/*
 * The planner's gate while it is shut: no way in to a page that does not
 * exist yet. `shell-nav.test.ts` and `sitemap.test.ts` hold it open and pin
 * the shell as it will be once the planner ships; this pins it as it is now.
 * When the planner's route lands and the gate opens, this file goes.
 */

vi.mock('server-only', () => ({}));
const nav = vi.hoisted(() => ({ pathname: '/wiki' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {} }),
}));
vi.mock('@/lib/db/client', () => ({
  getDb: async () => {
    throw new Error('no database in this test');
  },
}));

const { TabBar } = await import('@/components/wiki/tab-bar');
const { default: manifest } = await import('@/app/manifest');
const { default: sitemap } = await import('@/app/sitemap');

describe('the crafting planner while its gate is shut', () => {
  it('is shut', () => {
    expect(CRAFT_PLANNER_LIVE).toBe(false);
  });

  /** The bar for a signed-out Spanish reader on `pathname`, parsed. */
  function bar(pathname = '/wiki') {
    nav.pathname = pathname;
    return load(renderToString(withLang('es', createElement(TabBar, { lang: 'es', signedIn: false }))));
  }

  it('keeps the four tabs the reader knows', () => {
    const $ = bar();
    const hrefs = $('nav ul > li > a')
      .toArray()
      .map((a) => $(a).attr('href'));
    expect(hrefs).toEqual(['/wiki', '/wiki/browse', '/wiki/guide', '/login?next=/']);
    expect($('a[href="/wiki/craft"]')).toHaveLength(0);
  });

  it('leaves the nav search the room the planner’s tab will take, from 640px', () => {
    // Four tabs beside the brand leave the field about 130px at 640px; the
    // fifth would leave it about 65, which is why it waits for 768px then.
    const classes = (bar('/wiki/a/iron-sword')('nav form[role="search"]').attr('class') ?? '').split(/\s+/);
    expect(classes).toContain('sm:block');
    expect(classes).not.toContain('md:block');
  });

  it('caps the nav search at 16rem at every width it shows at', () => {
    // A cap from 768px left it uncapped from 640: about 270px at 767px for a
    // signed-in reader, whose Chat tab has no padlock to take room from it.
    const classes = (bar('/wiki/a/iron-sword')('nav form[role="search"]').attr('class') ?? '').split(/\s+/);
    expect(classes.filter((name) => name.endsWith('max-w-64'))).toEqual(['max-w-64']);
  });

  it('offers no shortcut to the planner', () => {
    expect((manifest().shortcuts ?? []).map((shortcut) => shortcut.url)).not.toContain('/wiki/craft');
  });

  it('asks no search engine to index the planner', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await sitemap()).map((entry) => entry.url)).not.toContain(`${SITE_URL}/wiki/craft`);
    error.mockRestore();
  });
});
