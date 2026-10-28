import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db/create-db';
import { upsertArticle } from '@/lib/db/wiki-repo';
import { extractArticle } from '@/lib/wiki/article';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import { slugify } from '@/lib/wiki/slug';
import { createTestDb } from '../helpers/db';
import { SEED, seedSearchCorpus } from '../helpers/search-seed';

/**
 * The cached loaders, against PGlite. `unstable_cache` is replaced by a
 * recorder that runs the function, so these tests see what each loader asks
 * the cache for (keys, tags, lifetime, arguments), what it would store — as
 * the real one does, only what resolves — and what it returns.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  cached: [] as { keyParts: string[]; options: { tags?: string[]; revalidate?: number | false } }[],
  calls: [] as { keyParts: string[]; args: unknown[] }[],
  stored: new Map<string, unknown>(),
  /** The SQL of every statement the loaders sent, in order. */
  statements: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keyParts: string[],
    options: { tags?: string[]; revalidate?: number | false },
  ) => {
    state.cached.push({ keyParts, options });
    return async (...args: unknown[]) => {
      state.calls.push({ keyParts, args });
      // What the data cache does to every value: a JSON round trip. A
      // rejection propagates before anything is stored, as in Next.
      const value = JSON.parse(JSON.stringify(await fn(...args))) as unknown;
      state.stored.set(`${keyParts.join(',')} ${JSON.stringify(args)}`, value);
      return value;
    };
  },
}));

/** The arguments each call to one loader's cache was made with. */
const argsOf = (keyPart: string) => state.calls.filter((c) => c.keyParts[0] === keyPart).map((c) => c.args);

/** Whether the cache stored anything for one loader. */
const storedFor = (keyPart: string) => [...state.stored.keys()].filter((k) => k.startsWith(`${keyPart} `));
vi.mock('@/lib/db/client', () => ({ getDb: async () => state.db }));

const data = await import('@/lib/wiki/data');
const known = await import('@/app/wiki/c/[category]/known-categories');

/** The caches the module set up as it loaded, before any test cleared the record. */
const registered = [...state.cached];

describe('wiki data loaders', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
    await seedSearchCorpus(handle.db);
    // The loaders' database, recording the SQL of each statement it is sent.
    const real = handle.db as unknown as {
      execute: (query: unknown) => Promise<unknown>;
      dialect: { sqlToQuery: (query: unknown) => { sql: string } };
    };
    state.db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== 'execute') return Reflect.get(target, prop, receiver);
        return (query: unknown) => {
          state.statements.push(target.dialect.sqlToQuery(query).sql);
          return target.execute(query);
        };
      },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
  });

  let pageIds = 9000;

  /** What an ingest does for a new page, with one category. */
  async function addArticle(title: string, category: string): Promise<void> {
    const pageKey = `fandom:new:${slugify(title)}`;
    const url = `https://valheim.fandom.com/wiki/${title.replace(/ /g, '_')}`;
    pageIds += 1;
    await handle.db.execute(sql`
      INSERT INTO pages (key, source, page_id, title, url, revid)
      VALUES (${pageKey}, 'fandom', ${pageIds}, ${title}, ${url}, 1)`);
    await upsertArticle(handle.db, {
      pageKey,
      source: 'fandom',
      title,
      slug: slugify(title),
      url,
      categories: [category],
      doc: { lead: 'Just ingested.', blocks: [], infobox: null, images: [], facets: {} },
    });
  }

  /** What an ingest does for a page the wiki no longer has: the article goes with it. */
  async function removeArticle(title: string): Promise<void> {
    await handle.db.execute(sql`DELETE FROM pages WHERE key = ${`fandom:new:${slugify(title)}`}`);
  }

  describe('getArticlePage', () => {
    it('returns the page in Spanish, JSON-safe, with the English article alongside', async () => {
      const page = (await data.getArticlePage('iron-sword', 'es'))!;
      expect(typeof page.article.updatedAt).toBe('string');
      expect(new Date(page.article.updatedAt).toISOString()).toBe(page.article.updatedAt);
      expect(page.article.title).toBe('Iron Sword');
      expect(page.translation).toEqual({
        title: 'Espada de hierro (Iron Sword)',
        stale: false,
        partial: false,
        retryable: false,
      });
      expect(page.title).toBe('Espada de hierro (Iron Sword)');
      expect(page.doc.lead).toBe('La espada de hierro es la segunda espada.');
      // Facets and images stay the English ones; only text is translated.
      expect(page.doc.facets).toEqual({ type: 'Sword', station: 'Forge' });
    });

    it('resolves the recipe from the English rows and pairs the translated ones with them', async () => {
      const page = (await data.getArticlePage('iron-sword', 'es'))!;
      expect(page.ingredientTargets['iron']).toEqual(expect.objectContaining({ slug: 'iron', title: 'Iron' }));
      expect(page.recipeSources).toEqual({ 'Hierro (Iron) x20': 'Iron x20' });
    });

    it("works out the page's links, its own name included so it is never linked to itself", async () => {
      const page = (await data.getArticlePage('iron-sword', 'es'))!;
      expect(page.links.some((l) => l.slug === 'iron-sword')).toBe(true);
    });

    it("reports a partial translation's progress and shows its translated captions", async () => {
      const url = 'https://static.wikia.nocookie.net/valheim/images/f/f0/Thistle_field.png';
      await handle.db.execute(sql`
        UPDATE articles SET images = ${JSON.stringify([{ url, alt: 'Thistle', caption: 'A thistle field' }])}::jsonb
        WHERE slug = 'thistle'`);
      await handle.db.execute(sql`
        UPDATE article_translations SET captions = ${JSON.stringify({ [url]: 'Un campo de cardos' })}::jsonb
        WHERE lang = 'es' AND page_key = (SELECT page_key FROM articles WHERE slug = 'thistle')`);
      // Three strings still in English, one of which has failed too often for
      // a public request to try it again: a request could still finish two.
      await handle.db.execute(sql`
        INSERT INTO article_translation_memory (page_key, lang, entries, failures, pending)
        SELECT page_key, 'es', '{}'::jsonb, '{"Stubborn": 2}'::jsonb, 3 FROM articles WHERE slug = 'thistle'`);

      const page = (await data.getArticlePage('thistle', 'es'))!;
      expect(page.translation).toEqual(expect.objectContaining({ partial: true, retryable: true }));
      expect(page.doc.images).toEqual([{ url, alt: 'Thistle', caption: 'Un campo de cardos' }]);

      // English readers get the English caption.
      const english = (await data.getArticlePage('thistle', 'en'))!;
      expect(english.doc.images).toEqual([{ url, alt: 'Thistle', caption: 'A thistle field' }]);
    });

    it('is English, with no translation, in English', async () => {
      const page = (await data.getArticlePage('iron-sword', 'en'))!;
      expect(page.translation).toBeNull();
      expect(page.title).toBe('Iron Sword');
      expect(page.recipeSources).toEqual({});
    });

    it('is null for an unknown article, and leaves nothing in the cache', async () => {
      state.stored.clear();
      expect(await data.getArticlePage('no-such-article', 'es')).toBeNull();
      expect(storedFor('wiki-article-page')).toEqual([]);
      // A real one is stored.
      await data.getArticlePage('iron', 'es');
      expect(storedFor('wiki-article-page')).toEqual(['wiki-article-page ["iron","es"]']);
    });

    it('answers a slug no article has with one index lookup, and never asks the cache', async () => {
      await data.getArticlePage('iron', 'es'); // the slug list is held from here on
      state.calls.length = 0;
      state.statements.length = 0;
      expect(await data.getArticlePage('no-such-article', 'es')).toBeNull();
      expect(argsOf('wiki-article-page')).toEqual([]);
      expect(state.statements).toHaveLength(1);
      expect(state.statements[0]).toMatch(/^SELECT 1 AS found FROM articles WHERE slug = \$1/);
    });

    it('reads a Spanish translation once per fill, the article without it', async () => {
      await data.getArticlePage('iron', 'es'); // the slug list and link index are held from here on
      state.statements.length = 0;
      await data.getArticlePage('iron-sword', 'es');
      // The translation's text travels once, with its progress and captions.
      expect(state.statements.filter((s) => /\bt\.blocks\b/.test(s))).toHaveLength(1);
      expect(state.statements.filter((s) => /article_translation_memory/.test(s))).toHaveLength(1);
      // The article, the translation and the recipe's ingredients.
      expect(state.statements).toHaveLength(3);
    });

    it('finds an article added after the slug list was loaded, on the next request', async () => {
      await data.getArticlePage('iron', 'en'); // the slug list is held from here on, without the newcomer
      await addArticle('Fresh Arrival', 'Brand new things');
      try {
        expect((await data.getArticlePage('fresh-arrival', 'en'))?.article.title).toBe('Fresh Arrival');
      } finally {
        await removeArticle('Fresh Arrival');
      }
    });

    it('answers a slug slugify could not have produced without asking the cache', async () => {
      state.calls.length = 0;
      for (const slug of ['Iron Sword', '../../etc/passwd', 'iron--sword', '-iron', 'a'.repeat(81), '']) {
        expect(await data.getArticlePage(slug, 'es')).toBeNull();
      }
      expect(argsOf('wiki-article-page')).toEqual([]);
    });

    it('is cached per article, tagged so a translation can refresh that one page', async () => {
      state.cached.length = 0;
      await data.getArticlePage('thistle', 'es');
      expect(state.cached).toContainEqual({
        keyParts: ['wiki-article-page'],
        options: { tags: ['corpus', 'article:thistle'], revalidate: 3600 },
      });
      expect(data.articleTag('thistle')).toBe('article:thistle');
      expect(data.CORPUS_TAG).toBe('corpus');
    });
  });

  describe('getBrowseAxes', () => {
    it('counts each biome by every article that names it, and labels the axes in Spanish', async () => {
      const axes = await data.getBrowseAxes('es');
      expect(axes.total).toBe(SEED.length);
      const meadows = axes.biomes.find((b) => b.name === 'Meadows')!;
      // The abandoned house names its biome only in its Location row.
      expect(meadows.count).toBe(1);
      expect(meadows.label).toBe('Praderas');
      expect(axes.biomes.find((b) => b.name === 'Black Forest')!.label).toBe('Bosque negro');
      const cauldron = axes.stations.find((s) => s.name === 'Cauldron')!;
      expect(cauldron).toEqual(expect.objectContaining({ count: 2, label: 'Caldero' }));
    });

    it('keeps English labels in English', async () => {
      const axes = await data.getBrowseAxes('en');
      expect(axes.stations.find((s) => s.name === 'Cauldron')!.label).toBe('Cauldron');
    });
  });

  describe('getCategoryListing', () => {
    it('filters a biome by every article on that rung, and names the filter in Spanish', async () => {
      const listing = await data.getCategoryListing({ biome: 'Meadows' }, 'es');
      expect(listing.articles.map((a) => a.slug)).toEqual(['abandoned-house']);
      expect(listing.heading).toEqual({ biome: 'Praderas' });
    });

    it('lists Spanish titles and leads, and keeps leads to one line of bytes', async () => {
      const listing = await data.getCategoryListing({ category: 'Weapons' }, 'es');
      expect(listing.articles.map((a) => a.title)).toEqual(['Escudo de metal negro', 'Espada de hierro', 'Fire Arrow']);
      expect(listing.articles.every((a) => a.lead.length <= 181)).toBe(true);
      expect(listing.heading).toEqual({ category: 'Armas' });
    });

    it('caches one entry per filter, whatever order the filter was written in', async () => {
      state.calls.length = 0;
      await data.getCategoryListing({ type: 'Food', station: 'Cauldron' }, 'es');
      await data.getCategoryListing({ station: 'Cauldron', type: 'Food' }, 'es');
      expect(registered).toContainEqual({
        keyParts: ['wiki-category-listing'],
        options: { tags: ['corpus'], revalidate: 3600 },
      });
      // The same arguments both times — a string, so React's cache() (which
      // compares objects by identity) can share one call between the page
      // and its metadata too. No biome, so no list of its articles.
      const [first, second] = argsOf('wiki-category-listing');
      expect(first).toEqual(['{"station":"Cauldron","type":"Food"}', null, 'es']);
      expect(second).toEqual(first);
    });

    it("keys a biome's listing by the articles on its rung, so new members make a new entry", async () => {
      state.calls.length = 0;
      await data.getCategoryListing({ biome: 'Meadows' }, 'es');
      expect(argsOf('wiki-category-listing')).toEqual([['{"biome":"Meadows"}', '["abandoned-house"]', 'es']]);
    });

    it('answers a filter that matches nothing without storing it, or even asking the cache', async () => {
      state.stored.clear();
      state.calls.length = 0;
      const none = await data.getCategoryListing({ category: 'No such category' }, 'es');
      expect(none.articles).toEqual([]);
      expect(await data.getCategoryListing({ category: 'Weapons', biome: 'constructor' }, 'es')).toEqual(
        expect.objectContaining({ articles: [] }),
      );
      expect(await data.getCategoryListing({ category: 'Weapons', type: 'No such type' }, 'es')).toEqual(
        expect.objectContaining({ articles: [] }),
      );
      expect(storedFor('wiki-category-listing')).toEqual([]);
      expect(argsOf('wiki-category-listing')).toEqual([]);
      // Longer than any name: not even a query.
      state.statements.length = 0;
      expect((await data.getCategoryListing({ category: 'x'.repeat(500) }, 'es')).articles).toEqual([]);
      expect(state.statements).toEqual([]);
    });

    it('reads a category newer than the values it holds from the database, and stores nothing for it', async () => {
      await data.getCategoryListing({ category: 'Weapons' }, 'en'); // the values are held from here on
      await addArticle('Brand New Find', 'Brand new things');
      try {
        state.calls.length = 0;
        const listing = await data.getCategoryListing({ category: 'Brand new things' }, 'en');
        expect(listing.articles.map((a) => a.slug)).toEqual(['brand-new-find']);
        expect(argsOf('wiki-category-listing')).toEqual([]);
      } finally {
        await removeArticle('Brand New Find');
      }
    });
  });

  describe('getCompareView', () => {
    it('returns the table and its levels without the article list', async () => {
      const view = await data.getCompareView({ category: 'Weapons' }, '4', 'es');
      expect(view.table.rows).toHaveLength(3);
      expect(view.table.columnLabels?.['Durability']).toBe('Durabilidad');
      expect(view.tabs).toEqual(expect.arrayContaining(['1', '2', '3', '4']));
      expect(view.heading).toEqual({ category: 'Armas' });
      expect(view.table.rows.find((r) => r.slug === 'black-metal-shield')!.shownTab).toBe('3');
    });

    it('reads a level no item has as no level, so ?tab= cannot add entries of its own', async () => {
      state.calls.length = 0;
      const typed = await data.getCompareView({ category: 'Weapons' }, 'zzz', 'es');
      const none = await data.getCompareView({ category: 'Weapons' }, undefined, 'es');
      expect(typed).toEqual(none);
      expect(argsOf('wiki-compare-table')).toEqual([
        ['{"category":"Weapons"}', null, null, 'es'],
        ['{"category":"Weapons"}', null, null, 'es'],
      ]);
    });

    it('answers a filter that matches nothing without storing it', async () => {
      state.stored.clear();
      state.calls.length = 0;
      const view = await data.getCompareView({ category: 'No such category' }, '4', 'es');
      expect(view.table.rows).toEqual([]);
      expect(view.tabs).toEqual([]);
      expect(storedFor('wiki-compare-set')).toEqual([]);
      expect(argsOf('wiki-compare-set')).toEqual([]);
      expect(argsOf('wiki-compare-table')).toEqual([]);
    });

    it("compares a biome's rung, keyed by its articles", async () => {
      state.calls.length = 0;
      const view = await data.getCompareView({ biome: 'Meadows' }, undefined, 'es');
      // The rung's one article shares its stats with no other: no column, so no table.
      expect(view.table).toEqual({ columns: [], rows: [] });
      expect(argsOf('wiki-compare-set')).toEqual([['{"biome":"Meadows"}', '["abandoned-house"]']]);
      expect(argsOf('wiki-compare-table')).toEqual([['{"biome":"Meadows"}', '["abandoned-house"]', null, 'es']]);
    });

    /** Stores articles in one category, with the documents given, as an ingest would. */
    async function storeArticles(category: string, articles: { title: string; doc: ArticleDoc }[]): Promise<void> {
      for (const { title, doc } of articles) {
        const pageKey = `fandom:${slugify(category)}:${slugify(title)}`;
        const url = `https://example.test/${slugify(title)}`;
        pageIds += 1;
        await handle.db.execute(sql`
          INSERT INTO pages (key, source, page_id, title, url, revid)
          VALUES (${pageKey}, 'fandom', ${pageIds}, ${title}, ${url}, 1)`);
        await upsertArticle(handle.db, { pageKey, source: 'fandom', title, slug: slugify(title), url, categories: [category], doc });
      }
    }

    /** A document whose infobox has these shared rows and, optionally, these level-1 rows. */
    const statsDoc = (title: string, common: [string, string][], level: [string, string][] = []): ArticleDoc => {
      const rows = (pairs: [string, string][]) => pairs.map(([label, value]) => ({ label, value }));
      return {
        lead: '',
        blocks: [],
        images: [],
        facets: {},
        infobox: {
          title,
          image: null,
          common: [{ label: '', rows: rows(common) }],
          tabs: level.length > 0 ? [{ label: '1', groups: [{ label: '', rows: rows(level) }] }] : [],
        },
      };
    };

    it('leaves out the internal ID however few the rows, and a value every row shares', async () => {
      // A biome's three creatures, whose IDs are their names: nothing in the values says identifier.
      await storeArticles('Meadow beasts', [
        { title: 'Boar', doc: statsDoc('Boar', [['Internal ID', 'Boar'], ['Stagger limit', '50%'], ['Main biome', 'Meadows']]) },
        { title: 'Deer', doc: statsDoc('Deer', [['Internal ID', 'Deer'], ['Stagger limit', '40%'], ['Main biome', 'Meadows']]) },
        { title: 'Neck', doc: statsDoc('Neck', [['Internal ID', 'Neck'], ['Stagger limit', '30%'], ['Main biome', 'Meadows']]) },
      ]);
      for (const lang of ['en', 'es'] as const) {
        const view = await data.getCompareView({ category: 'Meadow beasts' }, undefined, lang);
        expect(view.table.rows).toHaveLength(3);
        expect(view.table.columns).toEqual(['Stagger limit']);
      }
    });

    it('has no rows when no column is left, so the page describes the set by its list', async () => {
      // Skills share one row, their description: prose, which no table compares.
      await storeArticles('Crafts of old', [
        { title: 'Woodcutting', doc: statsDoc('Woodcutting', [['Description', 'Increases the damage you deal to trees with an axe.']]) },
        { title: 'Swimming', doc: statsDoc('Swimming', [['Description', 'Reduces the stamina you use while you swim in deep water.']]) },
        { title: 'Sneaking', doc: statsDoc('Sneaking', [['Description', 'Lowers the noise you make while you crouch and move.']]) },
      ]);
      for (const lang of ['en', 'es'] as const) {
        expect((await data.getCompareView({ category: 'Crafts of old' }, undefined, lang)).table).toEqual({ columns: [], rows: [] });
      }
      // The list still has all three.
      expect((await data.getCategoryListing({ category: 'Crafts of old' }, 'en')).articles).toHaveLength(3);
    });

    it("leaves out a set's page, whose infobox is its first piece's, and keeps a page whose first is its own", async () => {
      const fixture = async (name: string): Promise<ArticleDoc> =>
        extractArticle((JSON.parse(await readFile(`tests/fixtures/${name}.json`, 'utf8')) as { parse: { text: string } }).parse.text);

      // The Bronze Armor page's infobox is the Bronze helmet's, with its four levels.
      const set = await fixture('Bronze_Armor');
      expect(set.infobox!.title).toBe('Bronze helmet');
      await storeArticles('Bronze pieces', [
        { title: 'Bronze Armor', doc: set },
        { title: 'Bronze Helmet', doc: statsDoc('Bronze helmet', [['Type', 'Head']], [['Armor', '8'], ['Weight', '3.0']]) },
        { title: 'Bronze Plate Cuirass', doc: statsDoc('Bronze plate cuirass', [['Type', 'Chest']], [['Armor', '8'], ['Weight', '15.0']]) },
        { title: 'Bronze Plate Leggings', doc: statsDoc('Bronze plate leggings', [['Type', 'Legs']], [['Armor', '8'], ['Weight', '15.0']]) },
      ]);
      const pieces = (await data.getCompareView({ category: 'Bronze pieces' }, '1', 'en')).table;
      // The helmet's "Armor: 8" and "Weight: 3.0" are the helmet's row, not the set's.
      expect(pieces.rows.map((r) => r.slug)).toEqual(['bronze-helmet', 'bronze-plate-cuirass', 'bronze-plate-leggings']);
      expect(pieces.columns).toContain('Weight');

      // The Frosted Sweetbread page's first infobox (of "Baked" and "Unbaked") is the sweetbread.
      await storeArticles('Sweet breads', [
        { title: 'Frosted Sweetbread', doc: await fixture('Frosted_Sweetbread') },
        { title: 'Honey Bread', doc: statsDoc('Honey bread', [['Max Health', '30'], ['Weight', '1.0']]) },
      ]);
      const breads = (await data.getCompareView({ category: 'Sweet breads' }, undefined, 'en')).table;
      expect(breads.rows.map((r) => r.slug)).toEqual(['frosted-sweetbread', 'honey-bread']);
      expect(breads.rows[0]!.values['Max Health']).toBe('43');
    });

    it('keeps the stats and leaves out identifiers, descriptions and lists', async () => {
      // Twelve items shaped like the wiki's food: every one has all five rows.
      const titles = Array.from({ length: 12 }, (_, i) => `Relic ${String.fromCharCode(65 + i)}`);
      for (const [i, title] of titles.entries()) {
        const pageKey = `fandom:relic:${i}`;
        pageIds += 1;
        await handle.db.execute(sql`
          INSERT INTO pages (key, source, page_id, title, url, revid)
          VALUES (${pageKey}, 'fandom', ${pageIds}, ${title}, ${`https://example.test/${slugify(title)}`}, 1)`);
        await upsertArticle(handle.db, {
          pageKey,
          source: 'fandom',
          title,
          slug: slugify(title),
          url: `https://example.test/${slugify(title)}`,
          categories: ['Relics'],
          doc: {
            lead: '',
            blocks: [],
            images: [],
            facets: {},
            infobox: {
              title,
              image: null,
              common: [
                {
                  label: '',
                  rows: [
                    { label: 'Description', value: `A relic of the ${i + 1}th age, still warm.` },
                    { label: 'Internal ID', value: `Relic${String.fromCharCode(65 + i)}Old` },
                    { label: 'Drops', value: `Coins\nRelic shard x${i + 1}` },
                    { label: 'Weight', value: String(i + 1) },
                    { label: 'Type', value: i % 2 ? 'Trinket' : 'Material' },
                  ],
                },
              ],
              tabs: [],
            },
          },
        });
      }

      const view = await data.getCompareView({ category: 'Relics' }, undefined, 'en');
      expect(view.table.rows).toHaveLength(12);
      expect(view.table.columns).toEqual(['Weight', 'Type']);
    });
  });

  describe('search data', () => {
    it('serves the bilingual index and the accent list', async () => {
      const index = await data.getSearchIndexData();
      expect(index.find((e) => e.s === 'thistle')!.e).toBe('Cardo');
      expect((await data.getLegacyTitleIndex()).find((e) => e.s === 'thistle')!.e).toBeUndefined();
      expect(await data.getSearchVocabularyData()).toContain('jörmundling');
    });

    it('serves the link targets of a language', async () => {
      const targets = await data.getLinkTargets('es');
      expect(targets).toContainEqual({ match: 'Cardo', slug: 'thistle', title: 'Cardo', english: 'Thistle' });
    });
  });

  describe("the category route's known categories", () => {
    it('are the categories the filters are checked against: the layout costs no query of its own', async () => {
      await data.getCategoryListing({ category: 'Weapons' }, 'en'); // the values are held from here on
      state.statements.length = 0;
      const names = await data.heldCategoryNames();
      expect(names.has('Weapons')).toBe(true);
      // What the layout asks (known-categories.ts) is the same list, not a copy read again.
      expect(await known.heldCategories()).toBe(names);
      expect(state.statements).toEqual([]);
    });

    it('leave a category newer than the list to the database, which still finds it', async () => {
      await data.heldCategoryNames();
      await addArticle('Brand New Relic', 'Relics of tomorrow');
      try {
        expect((await known.heldCategories()).has('Relics of tomorrow')).toBe(false);
        expect(await known.categoryExists('Relics of tomorrow')).toBe(true);
        expect(await known.categoryExists('Relics of yesterday')).toBe(false);
      } finally {
        await removeArticle('Brand New Relic');
      }
    });
  });
});
