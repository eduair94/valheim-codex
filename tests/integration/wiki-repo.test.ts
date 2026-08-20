import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@/lib/db/create-db';
import {
  buildCompareTable,
  countArticles,
  getArticleBySlug,
  getSlugForTitle,
  getTitleIndex,
  listArticles,
  listCategories,
  listCompareTabs,
  listFacetValues,
  searchContent,
  upsertArticle,
} from '@/lib/db/wiki-repo';
import { runIngest } from '@/lib/ingest/run';
import { MediaWikiClient, type FetchLike } from '@/lib/wiki/mediawiki';
import { extractArticle } from '@/lib/wiki/article';
import { slugify } from '@/lib/wiki/slug';
import { createTestDb } from '../helpers/db';
import { fakeEmbed } from '../helpers/fake-embed';

const fakeEmbedMany = async (texts: string[]): Promise<number[][]> => texts.map(fakeEmbed);

const PAGES = [
  { pageid: 1, title: 'Iron Sword', fixture: 'Iron_Sword', categories: ['Weapons', 'Swords'] },
  { pageid: 2, title: 'Bonemass', fixture: 'Bonemass', categories: ['Creatures', 'Bosses'] },
  { pageid: 3, title: 'Iron', fixture: 'Iron', categories: ['Materials', 'Metals'] },
  { pageid: 4, title: 'Deathsquito', fixture: 'Deathsquito', categories: ['Creatures'] },
  { pageid: 5, title: 'Swords', fixture: 'Swords', categories: ['Weapons'] },
];

function wiki(): FetchLike {
  return async (url: string) => {
    const params = new URL(url).searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

    if (params.get('list') === 'allpages') {
      return json({ query: { allpages: PAGES.map((p) => ({ pageid: p.pageid, title: p.title })) } });
    }
    if (params.get('prop') === 'revisions') {
      const ids = params.get('pageids')!.split('|').map(Number);
      return json({
        query: {
          pages: PAGES.filter((p) => ids.includes(p.pageid)).map((p) => ({
            pageid: p.pageid,
            revisions: [{ revid: p.pageid * 10 }],
          })),
        },
      });
    }

    const page = PAGES.find((p) => p.pageid === Number(params.get('pageid')));
    if (!page) return json({ error: { code: 'missingtitle', info: 'gone' } });
    const raw = await readFile(`tests/fixtures/${page.fixture}.json`, 'utf8');
    const parsed = JSON.parse(raw) as { parse: { text: string } };
    return json({
      parse: {
        title: page.title,
        pageid: page.pageid,
        revid: page.pageid * 10,
        text: parsed.parse.text,
        categories: page.categories.map((c) => ({ category: c })),
      },
    });
  };
}

describe('wiki reading layer', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
    await runIngest({
      db: handle.db,
      client: new MediaWikiClient({ contact: 't@example.com', fetchImpl: wiki(), sleep: async () => {} }),
      embedFn: fakeEmbedMany,
      embeddingProviderId: 'test',
      runId: 'wiki-repo-test',
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
  });

  it('writes an article for every ingested page', async () => {
    expect(await countArticles(handle.db)).toBe(PAGES.length);
  });

  it('round-trips an article through Postgres unchanged', async () => {
    const stored = await getArticleBySlug(handle.db, 'iron-sword');
    expect(stored).not.toBeNull();

    const raw = await readFile('tests/fixtures/Iron_Sword.json', 'utf8');
    const expected = await extractArticle((JSON.parse(raw) as { parse: { text: string } }).parse.text);

    expect(stored!.doc.lead).toBe(expected.lead);
    expect(stored!.doc.blocks).toEqual(expected.blocks);
    expect(stored!.doc.infobox).toEqual(expected.infobox);
    expect(stored!.doc.facets).toEqual(expected.facets);
  });

  it('resolves a wiki title to a slug, so a citation can link inward', async () => {
    expect(await getSlugForTitle(handle.db, 'Iron Sword')).toBe('iron-sword');
    expect(await getSlugForTitle(handle.db, 'iron sword')).toBe('iron-sword');
    expect(await getSlugForTitle(handle.db, 'Nonexistent')).toBeNull();
  });

  it('returns nothing for an unknown slug rather than throwing', async () => {
    expect(await getArticleBySlug(handle.db, 'no-such-article')).toBeNull();
  });

  describe('title index', () => {
    it('covers every article and stays small', async () => {
      const index = await getTitleIndex(handle.db);
      expect(index).toHaveLength(PAGES.length);
      // The payload is downloaded on every cold load; a per-entry blow-up
      // would be felt on a phone.
      const bytes = JSON.stringify(index).length;
      expect(bytes / index.length).toBeLessThan(300);
    });

    it('carries what the search list needs to render a row', async () => {
      const index = await getTitleIndex(handle.db);
      const sword = index.find((e) => e.s === 'iron-sword')!;
      expect(sword.t).toBe('Iron Sword');
      expect(sword.c).toContain('Weapons');
      expect(sword.y).toBe('Sword');
      expect(sword.i).toMatch(/^https:\/\/static\.wikia\.nocookie\.net\//);
    });
  });

  describe('browsing', () => {
    it('lists categories by size', async () => {
      const categories = await listCategories(handle.db, 1);
      const names = categories.map((c) => c.name);
      expect(names).toContain('Weapons');
      expect(names).toContain('Creatures');
      expect(categories.find((c) => c.name === 'Weapons')!.count).toBe(2);
      // Sorted largest first.
      expect(categories[0]!.count).toBeGreaterThanOrEqual(categories.at(-1)!.count);
    });

    it('hides categories below the minimum, so the list stays scannable', async () => {
      const categories = await listCategories(handle.db, 2);
      expect(categories.map((c) => c.name)).not.toContain('Metals');
    });

    it('lists articles in a category, alphabetically', async () => {
      const found = await listArticles(handle.db, { category: 'Creatures' });
      expect(found.map((a) => a.title)).toEqual(['Bonemass', 'Deathsquito']);
    });

    it('filters by a facet lifted from the infobox', async () => {
      const plains = await listArticles(handle.db, { biome: 'Plains' });
      expect(plains.map((a) => a.title)).toEqual(['Deathsquito']);

      const forge = await listArticles(handle.db, { station: 'Forge' });
      expect(forge.map((a) => a.title)).toEqual(['Iron Sword']);
    });

    it('combines a category with a facet', async () => {
      const swamp = await listArticles(handle.db, { category: 'Creatures', biome: 'Swamp' });
      expect(swamp.map((a) => a.title)).toEqual(['Bonemass']);
    });

    it('returns an empty list for a filter nothing matches', async () => {
      expect(await listArticles(handle.db, { biome: 'Atlantis' })).toEqual([]);
    });

    it('lists facet values with counts', async () => {
      const biomes = await listFacetValues(handle.db, 'biome');
      expect(biomes.map((b) => b.name).sort()).toEqual(['Plains', 'Swamp']);
    });

    it('carries an icon so a browse list is recognisable at a glance', async () => {
      const creatures = await listArticles(handle.db, { category: 'Creatures' });
      expect(creatures.every((c) => c.icon?.startsWith('https://'))).toBe(true);
    });
  });

  describe('comparison', () => {
    it('builds columns from labels the category actually shares', async () => {
      const table = await buildCompareTable(handle.db, { category: 'Creatures' });
      expect(table.rows.map((r) => r.title)).toEqual(['Bonemass', 'Deathsquito']);
      expect(table.columns.length).toBeGreaterThan(0);
      // Both creatures state these, so both must be columns.
      expect(table.columns).toContain('Main biome');
      expect(table.columns).toContain('Internal ID');
    });

    it('reads values from the first upgrade level unless told otherwise', async () => {
      const base = await buildCompareTable(handle.db, { category: 'Weapons' });
      const sword = base.rows.find((r) => r.title === 'Iron Sword')!;
      expect(sword.values['Durability']).toBe('200');

      const level4 = await buildCompareTable(handle.db, { category: 'Weapons' }, { tab: '4' });
      expect(level4.rows.find((r) => r.title === 'Iron Sword')!.values['Durability']).toBe('350');
    });

    it('excludes articles with no infobox to compare', async () => {
      const table = await buildCompareTable(handle.db, { category: 'Weapons' });
      // "Swords" is a list page: nothing to put in a stat row.
      expect(table.rows.map((r) => r.title)).not.toContain('Swords');
    });

    it('offers the upgrade levels present in the set', async () => {
      const tabs = await listCompareTabs(handle.db, { category: 'Weapons' });
      expect(tabs).toEqual(expect.arrayContaining(['1', '2', '3', '4']));
    });
  });

  describe('content search', () => {
    it('finds an article by words in its body', async () => {
      const hits = await searchContent(handle.db, 'withered bones altar');
      expect(hits.map((h) => h.slug)).toContain('bonemass');
    });

    it('returns one hit per article rather than five sections of one page', async () => {
      const hits = await searchContent(handle.db, 'iron');
      expect(new Set(hits.map((h) => h.slug)).size).toBe(hits.length);
    });

    it('marks the matched words in the snippet', async () => {
      const hits = await searchContent(handle.db, 'Bonemass');
      expect(hits[0]!.snippet).toMatch(/«.+»/);
    });

    it('returns nothing for an empty or unmatched query', async () => {
      expect(await searchContent(handle.db, '   ')).toEqual([]);
      expect(await searchContent(handle.db, 'zzzznotaword')).toEqual([]);
    });
  });

  it('replaces an article rather than duplicating it on re-ingest', async () => {
    const before = await countArticles(handle.db);
    await upsertArticle(handle.db, {
      pageKey: 'fandom:1',
      source: 'fandom',
      title: 'Iron Sword',
      slug: slugify('Iron Sword'),
      url: 'https://valheim.fandom.com/wiki/Iron_Sword',
      categories: ['Weapons'],
      doc: { lead: 'changed', blocks: [], infobox: null, images: [], facets: {} },
    });

    expect(await countArticles(handle.db)).toBe(before);
    expect((await getArticleBySlug(handle.db, 'iron-sword'))!.doc.lead).toBe('changed');
  });
});

