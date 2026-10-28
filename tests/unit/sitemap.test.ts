import { afterEach, describe, expect, it, vi } from 'vitest';
import { SITE_URL } from '@/lib/site';
import { SOURCES } from '@/lib/wiki/sources';

/*
 * Which pages the sitemap asks search engines to index. The database is
 * replaced by a fixed corpus: what is pinned here is the choice of pages,
 * not the queries behind it.
 */

vi.mock('server-only', () => ({}));
// The sections once the planner ships; `craft-gate.test.ts` pins them while the gate is shut.
vi.mock('@/lib/craft/feature', () => ({ CRAFT_PLANNER_LIVE: true }));

const state = { dbFails: false };
vi.mock('@/lib/db/client', () => ({
  getDb: async () => {
    if (state.dbFails) throw new Error('database unavailable');
    return {};
  },
}));

vi.mock('@/lib/db/wiki-repo', async () => {
  const { SOURCES: sources } = await import('@/lib/wiki/sources');
  const bookkeeping = sources.flatMap((source) => source.maintenanceCategories ?? []);
  return {
    getTitleIndex: async () => [{ s: 'iron-sword', t: 'Iron sword', c: ['Weapons'] }],
    listCategories: async () => [
      { name: 'Weapons', count: 40, icon: null },
      { name: 'Stacks & Piles', count: 3, icon: null },
      // Every bookkeeping category the ingest knows, one in another case, as an older ingest stored them.
      ...bookkeeping.map((name, i) => ({ name: i === 0 ? name.toLowerCase() : name, count: 3, icon: null })),
    ],
  };
});

const { default: sitemap } = await import('@/app/sitemap');

afterEach(() => {
  state.dbFails = false;
  vi.restoreAllMocks();
});

describe('sitemap', () => {
  it('lists the sections, the categories a reader can browse and every article', async () => {
    expect((await sitemap()).map((entry) => entry.url)).toEqual([
      `${SITE_URL}/wiki`,
      `${SITE_URL}/wiki/browse`,
      `${SITE_URL}/wiki/craft`,
      `${SITE_URL}/wiki/guide`,
      `${SITE_URL}/wiki/c/Weapons`,
      `${SITE_URL}/wiki/c/Stacks%20%26%20Piles`,
      `${SITE_URL}/wiki/a/iron-sword`,
    ]);
  });

  it('leaves out the wiki’s bookkeeping categories, which the reader hides everywhere', async () => {
    const urls = (await sitemap()).map((entry) => decodeURIComponent(entry.url).toLowerCase());
    const bookkeeping = SOURCES.flatMap((source) => source.maintenanceCategories ?? []);
    expect(bookkeeping.length).toBeGreaterThan(0);
    for (const name of bookkeeping) {
      expect(urls, name).not.toContain(`${SITE_URL}/wiki/c/${name}`.toLowerCase());
    }
  });

  it('still lists the sections when the database cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.dbFails = true;
    expect((await sitemap()).map((entry) => entry.url)).toEqual([
      `${SITE_URL}/wiki`,
      `${SITE_URL}/wiki/browse`,
      `${SITE_URL}/wiki/craft`,
      `${SITE_URL}/wiki/guide`,
    ]);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
