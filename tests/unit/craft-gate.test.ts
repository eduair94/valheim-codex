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
vi.mock('next/navigation', () => ({
  usePathname: () => '/wiki',
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

  it('keeps the four tabs the reader knows', () => {
    const $ = load(renderToString(withLang('es', createElement(TabBar, { lang: 'es', signedIn: false }))));
    const hrefs = $('nav ul > li > a')
      .toArray()
      .map((a) => $(a).attr('href'));
    expect(hrefs).toEqual(['/wiki', '/wiki/browse', '/wiki/guide', '/login?next=/']);
    expect($('a[href="/wiki/craft"]')).toHaveLength(0);
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
