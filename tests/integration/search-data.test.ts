import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db/create-db';
import { cachedSlugs } from '@/lib/db/link-index';
import {
  articleExists,
  buildCompareTable,
  ensureSearchIndexes,
  getArticleWithTranslation,
  getLinkIndex,
  getSearchIndex,
  getSearchVocabulary,
  getTitleIndex,
  listArticles,
  listBiomeEvidence,
  listCompareTabs,
  listFacetValues,
  listFilterValues,
  searchContent,
  upsertArticle,
} from '@/lib/db/wiki-repo';
import { accentIndex, type AccentIndex } from '@/lib/rag/tsquery';
import { articleBiome, mainStations } from '@/lib/wiki/browse-groups';
import { createTestDb } from '../helpers/db';
import { SEED, seedSearchCorpus } from '../helpers/search-seed';

describe('search and browse over a bilingual corpus', () => {
  let handle: DbHandle;
  let accents: AccentIndex;

  beforeAll(async () => {
    handle = await createTestDb();
    await seedSearchCorpus(handle.db);
    accents = accentIndex(await getSearchVocabulary(handle.db));
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
  });

  describe('search index', () => {
    it('carries the Spanish name without its English gloss', async () => {
      const index = await getSearchIndex(handle.db);
      const sword = index.find((e) => e.s === 'iron-sword')!;
      expect(sword.t).toBe('Iron Sword');
      expect(sword.e).toBe('Espada de hierro');
      expect(index.find((e) => e.s === 'fishing-skill')!.e).toBe('Pesca (habilidad)');
    });

    it('names an untranslated hub page from the vocabulary, with its other names', async () => {
      const index = await getSearchIndex(handle.db);
      const workbench = index.find((e) => e.s === 'workbench')!;
      expect(workbench.e).toBe('Banco de trabajo');
      expect(workbench.a).toEqual(['Mesa de trabajo']);
    });

    it('omits a Spanish name that would repeat the English one', async () => {
      const index = await getSearchIndex(handle.db);
      expect(index.find((e) => e.s === 'jormundling')!.e).toBeUndefined();
      expect(index.find((e) => e.s === 'eikthyr')!.e).toBeUndefined();
    });

    it('sends icons as paths and only the categories a row shows', async () => {
      const index = await getSearchIndex(handle.db);
      const sword = index.find((e) => e.s === 'iron-sword')!;
      expect(sword.i).toBe('a/a1/Iron_Sword.png?cb=20210215131319');
      expect(sword.c).toEqual(['Weapons', 'Swords', 'Forge recipes']);
      expect(index.every((e) => e.c.length <= 3)).toBe(true);
    });

    it('keeps the original index shape for the previous build', async () => {
      const legacy = await getTitleIndex(handle.db);
      const sword = legacy.find((e) => e.s === 'iron-sword')!;
      expect(sword.i).toMatch(/^https:\/\/static\.wikia\.nocookie\.net\//);
      expect(sword.e).toBeUndefined();
    });

    it("skips the wiki's bookkeeping before cutting to three categories", async () => {
      const index = await getSearchIndex(handle.db);
      expect(index.find((e) => e.s === 'abandoned-house')!.c).toEqual(['Points of interest', 'Structures', 'Meadows locations']);
    });
  });

  describe('content search', () => {
    const slugs = async (q: string, lang: 'es' | 'en' = 'es') =>
      (await searchContent(handle.db, q, 20, { lang, accents })).map((h) => h.slug);

    it('finds the article from a Spanish word through the glossary', async () => {
      const hits = await searchContent(handle.db, 'hierro', 20, { lang: 'es', accents });
      expect(hits[0]!.slug).toBe('iron');
      expect(hits[0]!.name).toBe('Hierro');
      expect(hits[0]!.snippet).toMatch(/«[^»]+»/);
    });

    it('ranks the article whose name covers every word first', async () => {
      expect((await slugs('espada de hierro'))[0]).toBe('iron-sword');
      expect((await slugs('nucleo de surtling'))[0]).toBe('surtling-core');
      expect((await slugs('núcleo de surtling'))[0]).toBe('surtling-core');
    });

    it('ORs the words, so a question does not need every word in the article', async () => {
      // The article says "summoned", never "summon": an AND of the words missed it.
      expect(await slugs('how to summon eikthyr', 'en')).toContain('eikthyr');
      expect(await slugs('cómo invocar a eikthyr')).toContain('eikthyr');
    });

    it('folds accents against the accented words the index holds, and still marks them as written', async () => {
      const hits = await searchContent(handle.db, 'jormundling', 20, { lang: 'en', accents });
      expect(hits.map((h) => h.slug)).toContain('jormundling');
      expect(hits.find((h) => h.slug === 'jormundling')!.snippet).toContain('«Jörmundling»');
      // Without the word list the folded query has nothing to match.
      expect(await searchContent(handle.db, 'jormundling', 20, { lang: 'en' })).toEqual([]);
    });

    it('reads the Spanish translations in a Spanish search, and says which language the snippet is in', async () => {
      const hits = await searchContent(handle.db, 'cardo', 20, { lang: 'es', accents });
      expect(hits.map((h) => h.slug)).toEqual(['thistle']);
      expect(hits[0]!.snippetLang).toBe('es');
      expect(hits[0]!.snippet).toContain('«cardo»');
      expect(await slugs('cardo', 'en')).toEqual([]);
    });

    it("quotes the Spanish lead when it has a searched word, though the English passage ranked the article", async () => {
      // The English title is the shorter one, so the English passage ranks
      // both articles; their Spanish leads both say "hierro".
      const hits = await searchContent(handle.db, 'espada de hierro', 20, { lang: 'es', accents });
      for (const slug of ['iron-sword', 'iron']) {
        const hit = hits.find((h) => h.slug === slug)!;
        expect(hit.snippetLang).toBe('es');
        expect(hit.snippet).toMatch(/«hierro»/);
        expect(hit.sectionPath).toBe('');
      }
      expect(hits.find((h) => h.slug === 'iron-sword')!.snippet).toMatch(/«espada» de «hierro» es la segunda/);
      // An English search never reads a translation.
      const english = await searchContent(handle.db, 'iron sword', 20, { lang: 'en', accents });
      expect(english.find((h) => h.slug === 'iron-sword')!.snippet).toMatch(/«Iron» «Sword»/);
    });

    it('keeps the English passage when the Spanish lead is empty or says none of the words', async () => {
      const lead = async (slug: string, text: string) =>
        handle.db.execute(sql`
          UPDATE article_translations SET lead = ${text}
          WHERE lang = 'es' AND page_key = (SELECT page_key FROM articles WHERE slug = ${slug})`);
      try {
        await lead('iron-sword', '');
        // A tab label stored as a lead, as some translations have.
        await lead('iron', 'CabezaPechoPiernas');
        const hits = await searchContent(handle.db, 'espada de hierro', 20, { lang: 'es', accents });
        for (const slug of ['iron-sword', 'iron']) {
          const hit = hits.find((h) => h.slug === slug)!;
          expect(hit.snippetLang).toBe('en');
          expect(hit.snippet).toMatch(/«Iron»/);
        }
      } finally {
        await lead('iron-sword', 'La espada de hierro es la segunda espada.');
        await lead('iron', 'El hierro es un metal que se funde a partir de chatarra.');
      }
    });

    it('returns one hit per article', async () => {
      const found = await slugs('iron');
      expect(new Set(found).size).toBe(found.length);
    });

    it('returns nothing for stop words alone', async () => {
      expect(await slugs('de la')).toEqual([]);
      expect(await slugs('   ')).toEqual([]);
    });

    it('never fails on operators, quotes or control characters in the query', async () => {
      for (const q of ["it's & | ! ( ) : * \\ ' \"", '\u0000hierro', "'; DROP TABLE articles; --", '<b>«»</b>']) {
        await expect(searchContent(handle.db, q, 20, { lang: 'es', accents })).resolves.toBeInstanceOf(Array);
      }
    });

    it('answers a query of many common words, reading only the first five', async () => {
      const hits = await searchContent(handle.db, 'iron sword shield metal arrow troll eikthyr thistle', 20, { lang: 'es', accents });
      expect(hits.map((h) => h.slug)).toEqual(expect.arrayContaining(['iron-sword', 'iron', 'black-metal-shield']));
      // "troll", "eikthyr" and "thistle" are past the fifth group.
      expect(hits.map((h) => h.slug)).not.toContain('thistle');
    });

    it('reads the translations through the index drizzle/0007 creates, and can recreate it', async () => {
      const present = async () =>
        (await handle.db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'article_translations_search_idx'`)) as unknown as {
          rows: unknown[];
        };
      expect((await present()).rows).toHaveLength(1);
      expect(await ensureSearchIndexes(handle.db)).toBe(false);
      await handle.db.execute(sql`DROP INDEX article_translations_search_idx`);
      // Without it the search is still right, only slower.
      expect(await slugs('cardo')).toEqual(['thistle']);
      expect(await ensureSearchIndexes(handle.db)).toBe(true);
      expect((await present()).rows).toHaveLength(1);
      expect(await slugs('cardo')).toEqual(['thistle']);
    });
  });

  describe('content search over more articles than it ranks in full', () => {
    // Seventy articles that only mention the word, and two named for it: the
    // cheap signals must carry the named ones past the cut into the results.
    let big: DbHandle;

    beforeAll(async () => {
      big = await createTestDb();
      const article = async (i: number, title: string, body: string) => {
        const key = `fandom:${5000 + i}`;
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        await big.db.execute(sql`INSERT INTO pages (key, source, page_id, title, url, revid)
                                 VALUES (${key}, 'fandom', ${5000 + i}, ${title}, ${`https://example.test/${slug}`}, 1)`);
        for (let c = 0; c < 8; c += 1) {
          await big.db.execute(sql`
            INSERT INTO chunks (id, page_key, source, title, url, section_path, kind, content, token_count, content_hash)
            VALUES (${`${key}:prose:${c}`}, ${key}, 'fandom', ${title}, ${`https://example.test/${slug}`}, ${c === 0 ? '' : `Part ${c}`},
                    'prose', ${`${title}\n${body} (part ${c})`}, 10, ${`h-${key}-${c}`})`);
        }
        await upsertArticle(big.db, {
          pageKey: key, source: 'fandom', title, slug, url: `https://example.test/${slug}`, categories: [],
          doc: { lead: body, blocks: [], infobox: null, images: [], facets: {} },
        });
      };
      for (let i = 0; i < 70; i += 1) await article(i, `Place ${i}`, `A place where frostbloom grows, frostbloom everywhere ${i}.`);
      await article(70, 'Frostbloom', 'Frostbloom is a flower.');
      await article(71, 'Frostbloom Tea', 'A tea of frostbloom.');
    }, 180_000);

    afterAll(async () => {
      await big?.close();
    });

    it('puts the articles named for the word first, one hit each, the page full', async () => {
      const hits = await searchContent(big.db, 'frostbloom', 20, { lang: 'en' });
      expect(hits.slice(0, 2).map((h) => h.slug)).toEqual(['frostbloom', 'frostbloom-tea']);
      expect(hits).toHaveLength(20);
      expect(new Set(hits.map((h) => h.slug)).size).toBe(20);
      expect(hits.every((h) => /«frostbloom»/i.test(h.snippet))).toBe(true);
    });
  });

  describe('browse in Spanish', () => {
    it('lists Spanish names and leads, sorted as shown, with the English kept alongside', async () => {
      const weapons = await listArticles(handle.db, { category: 'Weapons' }, 500, { lang: 'es' });
      expect(weapons.map((a) => a.title)).toEqual(['Escudo de metal negro', 'Espada de hierro', 'Fire Arrow']);
      const sword = weapons.find((a) => a.slug === 'iron-sword')!;
      expect(sword.englishTitle).toBe('Iron Sword');
      expect(sword.lead).toBe('La espada de hierro es la segunda espada.');
      expect(sword.translated).toBe(true);
      // No translation: the English lead, marked as such.
      expect(weapons.find((a) => a.slug === 'fire-arrow')!.translated).toBe(false);
    });

    it('is unchanged in English', async () => {
      const weapons = await listArticles(handle.db, { category: 'Weapons' });
      expect(weapons.map((a) => a.title)).toEqual(['Black Metal Shield', 'Fire Arrow', 'Iron Sword']);
      expect(weapons.every((a) => a.englishTitle === undefined)).toBe(true);
    });

    it('narrows to a list of articles computed outside SQL', async () => {
      const only = await listArticles(handle.db, {}, 500, { only: ['troll', 'iron'] });
      expect(only.map((a) => a.slug)).toEqual(['iron', 'troll']);
    });
  });

  describe('stations, by bench whatever the level', () => {
    it('counts a levelled recipe under its bench', async () => {
      const stations = await listFacetValues(handle.db, 'station');
      expect(stations.find((s) => s.name === 'Cauldron')!.count).toBe(2);
      expect(stations.some((s) => s.name.includes('level'))).toBe(false);
    });

    it('lists a levelled recipe under its bench', async () => {
      const cauldron = await listArticles(handle.db, { station: 'Cauldron' });
      expect(cauldron.map((a) => a.slug).sort()).toEqual(['carrot-soup', 'wolf-jerky']);
    });

    it('keeps a trader an older parser stored as a station off the bench tiles', async () => {
      // Before parser version 2, "Source: Hildir" or "Source: Haldor" became the station of
      // anything that stated a repair level or "Crafting Materials: N/A".
      const traders = ['Hildir', 'Haldor'];
      const keys = traders.map((_, i) => `fandom:${7200 + i}`);
      for (const [i, trader] of traders.entries()) {
        const slug = `sold-by-${trader.toLowerCase()}`;
        await handle.db.execute(sql`INSERT INTO pages (key, source, page_id, title, url, revid)
                                    VALUES (${keys[i]}, 'fandom', ${7200 + i}, ${`Sold by ${trader}`}, ${`https://example.test/${slug}`}, 1)`);
        await upsertArticle(handle.db, {
          pageKey: keys[i]!,
          source: 'fandom',
          title: `Sold by ${trader}`,
          slug,
          url: `https://example.test/${slug}`,
          categories: ['Armor'],
          doc: { lead: '', blocks: [], infobox: null, images: [], facets: { station: trader } },
        });
      }
      try {
        const stations = await listFacetValues(handle.db, 'station');
        expect(stations.map((s) => s.name)).toEqual(expect.arrayContaining(traders));
        const tiles = mainStations(stations).map((s) => s.name);
        expect(tiles).toEqual(expect.arrayContaining(['Cauldron', 'Forge', 'Workbench']));
        expect(tiles).not.toContain('Hildir');
        expect(tiles).not.toContain('Haldor');
      } finally {
        for (const key of keys) await handle.db.execute(sql`DELETE FROM pages WHERE key = ${key}`);
      }
    });
  });

  describe('biome evidence', () => {
    it('reads the Location and Source rows and whether the article is craftable', async () => {
      const evidence = await listBiomeEvidence(handle.db);
      const house = evidence.find((e) => e.slug === 'abandoned-house')!;
      expect(house.location).toBe('Meadows');
      expect(articleBiome(house)).toBe('Meadows');
      expect(evidence.find((e) => e.slug === 'iron-sword')!.craftable).toBe(true);
      expect(articleBiome(evidence.find((e) => e.slug === 'troll')!)).toBe('Black Forest');
    });

    it('counts as craftable only a recipe that states something, as the station facet does', async () => {
      // Rows are [label, value]; `level` ones sit in the infobox's first level tab.
      const shapes: { title: string; common: [string, string][]; level: [string, string][] }[] = [
        // Repairable, as anything worn is, and found rather than made: its Source is a place.
        { title: 'Shoreline Shawl', common: [['Source', 'Swamp']], level: [['Repair Level', '1'], ['Repair Station', 'Workbench']] },
        // Sold by a trader, with a recipe row that says there is none.
        { title: 'Trader Circlet', common: [['Source', 'Haldor']], level: [['Crafting Materials', 'N/A']] },
        { title: 'Spark Toy', common: [['Source', 'Hildir']], level: [['Crafting Level', 'nil'], ['Repair Level', 'nil']] },
        // Made at a bench: a crafting level that is a number, or materials that name something.
        { title: 'Forged Cap', common: [['Source', 'Forge']], level: [['Crafting Level', '2']] },
        { title: 'Plains Loaf', common: [['Source', 'Plains'], ['Crafting Materials', 'Barley flour x4']], level: [] },
      ];
      const rows = (pairs: [string, string][]) => pairs.map(([label, value]) => ({ label, value }));
      const keys = shapes.map((_, i) => `fandom:${7000 + i}`);
      for (const [i, { title, common, level }] of shapes.entries()) {
        const slug = title.toLowerCase().replace(/ /g, '-');
        await handle.db.execute(sql`INSERT INTO pages (key, source, page_id, title, url, revid)
                                    VALUES (${keys[i]}, 'fandom', ${7000 + i}, ${title}, ${`https://example.test/${slug}`}, 1)`);
        await upsertArticle(handle.db, {
          pageKey: keys[i]!,
          source: 'fandom',
          title,
          slug,
          url: `https://example.test/${slug}`,
          categories: ['Recipe shapes'],
          doc: {
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
          },
        });
      }
      try {
        const evidence = await listBiomeEvidence(handle.db);
        const of = (slug: string) => evidence.find((e) => e.slug === slug)!;
        expect(of('shoreline-shawl').craftable).toBe(false);
        expect(articleBiome(of('shoreline-shawl'))).toBe('Swamp');
        expect(of('trader-circlet').craftable).toBe(false);
        expect(of('spark-toy').craftable).toBe(false);
        expect(of('forged-cap').craftable).toBe(true);
        // Craftable, so its Source is a bench, here one named like a biome: no rung.
        expect(of('plains-loaf').craftable).toBe(true);
        expect(articleBiome(of('plains-loaf'))).toBeNull();
      } finally {
        for (const key of keys) await handle.db.execute(sql`DELETE FROM pages WHERE key = ${key}`);
      }
    });
  });

  describe('compare table', () => {
    it('reads the first level unless asked for another', async () => {
      const base = await buildCompareTable(handle.db, { category: 'Weapons' });
      expect(base.rows.find((r) => r.slug === 'iron-sword')!.values['Durability']).toBe('200');
      expect(base.rows.every((r) => r.shownTab === undefined)).toBe(true);
    });

    it('never shows a lower level under a higher one without saying so', async () => {
      const level4 = await buildCompareTable(handle.db, { category: 'Weapons' }, { tab: '4' });
      expect(level4.rows.find((r) => r.slug === 'iron-sword')!.values['Durability']).toBe('350');
      // The shield stops at level 3: its level-3 stats, marked, never its level-1 ones.
      const shield = level4.rows.find((r) => r.slug === 'black-metal-shield')!;
      expect(shield.values['Durability']).toBe('300');
      expect(shield.shownTab).toBe('3');
      // One tab: the same at every level, shown as it is.
      const arrow = level4.rows.find((r) => r.slug === 'fire-arrow')!;
      expect(arrow.values['Pierce']).toBe('22');
      expect(arrow.shownTab).toBeUndefined();
    });

    it('leaves the per-level cells empty when no level can stand in', async () => {
      // A second creature tabbed by stars: a set of one has no column to compare, and no table.
      const key = 'fandom:7100';
      await handle.db.execute(sql`INSERT INTO pages (key, source, page_id, title, url, revid)
                                  VALUES (${key}, 'fandom', 7100, 'Greydwarf', 'https://example.test/greydwarf', 1)`);
      await upsertArticle(handle.db, {
        pageKey: key,
        source: 'fandom',
        title: 'Greydwarf',
        slug: 'greydwarf',
        url: 'https://example.test/greydwarf',
        categories: ['Creatures'],
        doc: {
          lead: '',
          blocks: [],
          images: [],
          facets: {},
          infobox: {
            title: 'Greydwarf',
            image: null,
            common: [{ label: '', rows: [{ label: 'Type', value: 'Monster' }, { label: 'Main biome', value: 'Black Forest' }] }],
            tabs: ['0★', '1★'].map((label, i) => ({ label, groups: [{ label: '', rows: [{ label: 'Durability', value: String(40 * (i + 1)) }] }] })),
          },
        },
      });
      try {
        const creatures = await buildCompareTable(handle.db, { category: 'Creatures' }, { tab: '4' });
        const troll = creatures.rows.find((r) => r.slug === 'troll')!;
        expect(troll.values['Durability']).toBeUndefined();
        expect(troll.values['Type']).toBe('Boss');
      } finally {
        await handle.db.execute(sql`DELETE FROM pages WHERE key = ${key}`);
      }
    });

    it('translates titles, labels and values in Spanish, where the translation is current', async () => {
      const table = await buildCompareTable(handle.db, { category: 'Weapons' }, { tab: '4', lang: 'es' });
      expect(table.columns).toContain('Durability');
      expect(table.columnLabels!['Durability']).toBe('Durabilidad');
      const sword = table.rows.find((r) => r.slug === 'iron-sword')!;
      expect(sword.title).toBe('Espada de hierro');
      expect(sword.englishTitle).toBe('Iron Sword');
      expect(sword.values['Durability']).toBe('350');
      expect(sword.values['Type']).toBe('Espada');
      // The gloss is dropped from a translated value that carries one.
      expect(sword.values['Source']).toBe('Forja');
      // A stale translation is not trusted for values: the English stays.
      expect(table.rows.find((r) => r.slug === 'black-metal-shield')!.values['Type']).toBe('Shield');
    });

    it("says whether a row's values are the translation's, so English cells can be marked", async () => {
      const table = await buildCompareTable(handle.db, { category: 'Weapons' }, { tab: '4', lang: 'es' });
      const row = (slug: string) => table.rows.find((r) => r.slug === slug)!;
      expect(row('iron-sword').valuesTranslated).toBe(true);
      // A Spanish title over English values: stale translation, and none at all.
      expect(row('black-metal-shield').title).toBe('Escudo de metal negro');
      expect(row('black-metal-shield').valuesTranslated).toBe(false);
      expect(row('fire-arrow').valuesTranslated).toBe(false);
      // An English table says nothing about it.
      const english = await buildCompareTable(handle.db, { category: 'Weapons' }, { tab: '4' });
      expect(english.rows.every((r) => r.valuesTranslated === undefined)).toBe(true);
    });

    it('offers the levels the set has', async () => {
      expect(await listCompareTabs(handle.db, { category: 'Weapons' })).toEqual(expect.arrayContaining(['1', '2', '3', '4']));
    });
  });

  describe('article with its translation, in one query', () => {
    it('returns both, and whether the translation is stale', async () => {
      const found = (await getArticleWithTranslation(handle.db, 'iron-sword', 'es'))!;
      expect(found.article.title).toBe('Iron Sword');
      expect(found.translation!.title).toBe('Espada de hierro (Iron Sword)');
      expect(found.translation!.stale).toBe(false);
      expect(found.translation!.doc.facets).toEqual({});
      expect((await getArticleWithTranslation(handle.db, 'black-metal-shield', 'es'))!.translation!.stale).toBe(true);
    });

    it('has no translation in English, and nothing for an unknown slug', async () => {
      expect((await getArticleWithTranslation(handle.db, 'iron-sword', 'en'))!.translation).toBeNull();
      expect(await getArticleWithTranslation(handle.db, 'no-such-article', 'es')).toBeNull();
    });
  });

  describe('link index', () => {
    it('marks translated names with the English title they stand for', async () => {
      const index = await getLinkIndex(handle.db, 'es');
      expect(index.filter((t) => t.slug === 'iron-sword')).toEqual([
        { match: 'Iron Sword', slug: 'iron-sword', title: 'Espada de hierro' },
        { match: 'Espada de hierro', slug: 'iron-sword', title: 'Espada de hierro', english: 'Iron Sword' },
      ]);
      expect(index.find((t) => t.slug === 'fishing-skill' && t.english)!.match).toBe('Pesca (habilidad)');
    });

    it("holds every article's slug, collected once per load of the index", async () => {
      const slugs = await cachedSlugs(handle.db);
      expect(slugs.size).toBe(SEED.length);
      expect(slugs.has('iron-sword')).toBe(true);
      expect(slugs.has('no-such-article')).toBe(false);
      expect(cachedSlugs(handle.db)).toBe(cachedSlugs(handle.db));
    });
  });

  describe('what a URL may name', () => {
    it('says whether an article has a slug', async () => {
      expect(await articleExists(handle.db, 'iron')).toBe(true);
      expect(await articleExists(handle.db, 'no-such-article')).toBe(false);
    });

    it('lists every category, bench and type some article has, as the filters match them', async () => {
      const values = await listFilterValues(handle.db);
      expect(values.categories).toEqual(expect.arrayContaining(['Weapons', 'Trinket', 'Cooking recipes']));
      // Every category an article carries, the wiki's bookkeeping too: which
      // of them a page shows is not this list's to decide, only what exists.
      expect(values.categories).toContain('Unfinished');
      // Benches by their base name, as the station filter compares them.
      expect(values.stations).toEqual(expect.arrayContaining(['Cauldron', 'Forge', 'Workbench']));
      expect(values.stations).not.toContain('Cauldron (level 3)');
      expect(values.types).toEqual(expect.arrayContaining(['Sword', 'Shield', 'Point of interest']));
      expect(new Set(values.categories).size).toBe(values.categories.length);
    });
  });

  it('lists the accented words the search folds against', async () => {
    const words = await getSearchVocabulary(handle.db);
    expect(words).toEqual(expect.arrayContaining(['jörmundling', 'núcleos']));
    expect(words.every((w) => /[^\x01-\x7f]/.test(w))).toBe(true);
  });
});
