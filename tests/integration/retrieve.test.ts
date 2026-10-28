import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db/create-db';
import type { TitleIndexEntry } from '@/lib/db/wiki-repo';
import { titleLinker } from '@/lib/rag/intent';
import { fetchPinnedSections, retrieve } from '@/lib/rag/retrieve';
import { deterministicQueries } from '@/lib/rag/rewrite';
import { contextTokens, fetchFamilies, familyKey, STITCHED_KIND } from '@/lib/rag/stitch';
import { createTestDb } from '../helpers/db';
import { fakeEmbedAsync } from '../helpers/fake-embed';
import { seedChunks } from '../helpers/seed';

describe('retrieve (hybrid vector + full-text)', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
    await seedChunks(handle.db, [
      {
        id: 'sword-recipe',
        title: 'Iron Sword',
        sectionPath: 'Level 1',
        kind: 'infobox',
        content: 'Iron Sword › Level 1: Crafting Materials: Wood x2; Iron x20; Leather scraps x3',
      },
      {
        id: 'sword-lead',
        title: 'Iron Sword',
        content: 'Iron Sword\nThe iron sword is a one-handed weapon forged at the forge.',
      },
      {
        id: 'yagluth',
        title: 'Yagluth',
        content: 'Yagluth is the fifth boss of Valheim and is summoned in the Plains biome.',
      },
      {
        id: 'smelter',
        title: 'Smelter',
        content: 'The Smelter turns scrap iron and iron ore into iron bars using coal.',
      },
      {
        id: 'unrelated',
        title: 'Cooking',
        content: 'A cooking station roasts meat over a campfire.',
      },
    ]);
  });

  afterAll(async () => {
    await handle?.close();
  });

  const search = (queries: string[], overrides = {}) =>
    retrieve(handle.db, { queries, embedFn: fakeEmbedAsync, ...overrides });

  it('finds the chunk that answers a recipe question', async () => {
    const results = await search(['Iron Sword crafting materials']);
    expect(results[0]!.id).toBe('sword-recipe');
  });

  it('finds a rare proper noun through full-text even when the vector misses', async () => {
    // The fake embedder is bag-of-words, so a misspelt-context query has no
    // vector signal; only the lexical retriever can rescue this.
    const results = await search(['Yagluth']);
    expect(results.map((r) => r.id)).toContain('yagluth');
  });

  it('reports which retrievers found each chunk', async () => {
    const results = await search(['Iron Sword crafting materials']);
    const top = results[0]!;
    expect(Object.keys(top.ranks).length).toBeGreaterThan(0);
    expect(Object.keys(top.ranks).some((k) => k.startsWith('vector'))).toBe(true);
  });

  it('merges several rewritten queries into one ranking', async () => {
    const results = await search(['Iron Sword materials', 'Smelter iron bars']);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('sword-recipe');
    expect(ids).toContain('smelter');
  });

  it('respects topK', async () => {
    const results = await search(['iron'], { topK: 2 });
    expect(results).toHaveLength(2);
  });

  it('returns nothing for an empty query list', async () => {
    expect(await search([])).toEqual([]);
    expect(await search(['   '])).toEqual([]);
  });

  it('does not fail when every query word is a stop word', async () => {
    // buildTsQuery yields '' here; the full-text branch must be skipped, not
    // sent to Postgres as an empty tsquery.
    const results = await search(['how much do I need']);
    expect(Array.isArray(results)).toBe(true);
  });

  it('prefers the higher-ranked source when content is otherwise equal', async () => {
    const local = await createTestDb();
    try {
      const content = 'Bonemass is the third boss and lives in the Swamp.';
      await seedChunks(local.db, [
        { id: 'preferred', title: 'Bonemass', content, source: 'fandom', sourceRank: 0 },
        { id: 'secondary', title: 'Bonemass', content, source: 'mirror', sourceRank: 1 },
      ]);
      const results = await retrieve(local.db, {
        queries: ['Bonemass swamp boss'],
        embedFn: fakeEmbedAsync,
      });
      expect(results[0]!.id).toBe('preferred');
    } finally {
      await local.close();
    }
  });

  it('ignores chunks that have no embedding yet', async () => {
    const local = await createTestDb();
    try {
      await seedChunks(local.db, [{ id: 'has-vector', title: 'A', content: 'troll cave loot' }]);
      await local.db.execute(sql`
        INSERT INTO chunks (id, page_key, source, title, url, kind, content, token_count, content_hash)
        VALUES ('no-vector', 'fandom:1', 'fandom', 'A', 'https://example.test/A', 'prose',
                'troll cave loot pending embedding', 6, 'h')
      `);
      const results = await retrieve(local.db, {
        queries: ['troll cave'],
        embedFn: fakeEmbedAsync,
      });
      const vectorFound = results.filter((r) => Object.keys(r.ranks).some((k) => k.startsWith('vector')));
      expect(vectorFound.map((r) => r.id)).not.toContain('no-vector');
    } finally {
      await local.close();
    }
  });

  it('keeps the context within its token budget', async () => {
    const results = await search(['iron'], { maxContextTokens: 40, topK: 8 });
    const total = results.reduce((s, r) => s + Math.ceil(r.content.length / 4), 0);
    // The first chunk is always admitted, so the budget can only be exceeded by
    // that one chunk.
    expect(total).toBeLessThanOrEqual(40 + Math.ceil(results[0]!.content.length / 4));
  });

  /*
   * The lead image used to be a second query after retrieval — another Neon
   * round trip before the sources could go out. The retrieval query already
   * joins the article, so it reads the picture too.
   */
  it('reads each chunk’s lead image in the same query, infobox first', async () => {
    const local = await createTestDb();
    try {
      await seedChunks(local.db, [
        { id: 'bonemass', title: 'Bonemass', content: 'Bonemass is the boss of the Swamp.' },
        { id: 'troll', title: 'Troll', content: 'Trolls roam the Black Forest swamp edges.' },
        { id: 'moder', title: 'Moder', content: 'Moder lives in the Mountains.' },
      ]);
      await local.db.execute(sql`
        INSERT INTO articles (page_key, source, title, slug, url, infobox, images)
        SELECT key, 'fandom', title, lower(title), url,
               CASE WHEN title = 'Bonemass'
                    THEN '{"image": {"url": "https://img.test/bonemass.png", "alt": "Bonemass"}}'::jsonb END,
               CASE WHEN title = 'Troll'
                    THEN '[{"url": "https://img.test/troll.png", "alt": "A troll"}]'::jsonb
                    ELSE '[]'::jsonb END
        FROM pages
      `);

      const results = await retrieve(local.db, { queries: ['swamp boss Bonemass troll Moder'], embedFn: fakeEmbedAsync });
      const byId = new Map(results.map((r) => [r.id, r]));
      expect(byId.get('bonemass')?.image).toEqual({ url: 'https://img.test/bonemass.png', alt: 'Bonemass' });
      expect(byId.get('troll')?.image).toEqual({ url: 'https://img.test/troll.png', alt: 'A troll' });
      expect(byId.get('moder')?.image).toBeNull();
    } finally {
      await local.close();
    }
  });

  it('runs every query, its glossary variant included, and fuses them deterministically', async () => {
    const twice = await Promise.all([
      search(['espada de hierro materiales', 'Smelter iron bars']),
      search(['espada de hierro materiales', 'Smelter iron bars']),
    ]);
    expect(twice[0].map((r) => r.id)).toEqual(twice[1].map((r) => r.id));
    expect(twice[0].map((r) => r.id)).toContain('smelter');
  });

  it('caps a huge query before it reaches the embedder', async () => {
    const seen: number[] = [];
    await retrieve(handle.db, {
      queries: ['iron '.repeat(5_000)],
      embedFn: async (text) => {
        seen.push(text.length);
        return fakeEmbedAsync(text);
      },
    });
    expect(Math.max(...seen)).toBeLessThanOrEqual(2_000);
  });
});

/*
 * Whole sections (`stitch.ts`) and pinned ones (`intent.ts`), against real
 * Postgres: ids are `source:page:kind:ordinal` as the chunker writes them, and
 * pages get their keys in the order they are seeded (fandom:1, fandom:2, …).
 */
describe('retrieve: sections', () => {
  let handle: DbHandle;

  /** The title index the chat links names through, as `getSearchIndex` gives it. */
  const INDEX: TitleIndexEntry[] = [
    { s: 'bronze', t: 'Bronze', c: [], e: 'Bronce' },
    { s: 'tin', t: 'Tin', c: [], e: 'Estaño' },
  ];
  const linker = () => titleLinker(async () => INDEX);

  beforeAll(async () => {
    handle = await createTestDb();
    await seedChunks(handle.db, [
      // Tin: fandom:1
      { id: 'fandom:1:infobox:0', title: 'Tin', kind: 'infobox', content: 'Tin\nType: Material; Source: Smelter' },
      {
        id: 'fandom:1:prose:1',
        title: 'Tin',
        content: `Tin\nTin is a crafting material smelted from Tin ore in a Smelter. ${'It is found near water. '.repeat(6)}`,
      },
      { id: 'fandom:1:prose:2', title: 'Tin', sectionPath: 'Usage > Building', content: 'Tin › Usage › Building\nCauldron\nMead ketill' },
      { id: 'fandom:1:prose:3', title: 'Tin', sectionPath: 'Usage > Crafting', content: 'Tin › Usage › Crafting\nBronze\nButcher knife' },
      { id: 'fandom:1:prose:4', title: 'Tin', sectionPath: 'Notes', content: 'Tin › Notes\nLike other metals, Tin cannot be teleported.' },
      // Bronze: fandom:2
      { id: 'fandom:2:prose:1', title: 'Bronze', content: 'Bronze\nBronze is an alloy of two Copper and one Tin, made at the Forge.' },
      { id: 'fandom:2:prose:2', title: 'Bronze', sectionPath: 'Usage', content: 'Bronze › Usage\nBuilding:\nAnvils\nForge\n\nCrafting:\nBronze sword\nBronze nails' },
      // Odd: fandom:3. Ordinals out of insertion and text order, headings that only start like Usage.
      { id: 'fandom:3:prose:10', title: 'Odd', sectionPath: 'Usage', content: 'Odd › Usage\nUsed for odd things' },
      { id: 'fandom:3:prose:3', title: 'Odd', sectionPath: 'Usage > Crafting', content: 'Odd › Usage › Crafting\nOdd hammer' },
      { id: 'fandom:3:prose:2', title: 'Odd', sectionPath: 'Usage > Building', content: 'Odd › Usage › Building\nOdd hut' },
      { id: 'fandom:3:prose:4', title: 'Odd', sectionPath: 'Usage tips', content: 'Odd › Usage tips\nUse it carefully' },
      { id: 'fandom:3:prose:5', title: 'Odd', sectionPath: 'Usages', content: 'Odd › Usages\nOther usages' },
      { id: 'fandom:3:infobox:6', title: 'Odd', sectionPath: 'Usage > Building', kind: 'infobox', content: 'Odd › Usage › Building\nNot a member' },
      // Other: fandom:4, a different page with the same section.
      { id: 'fandom:4:prose:2', title: 'Other', sectionPath: 'Usage > Building', content: 'Other › Usage › Building\nOther hut' },
    ]);
    await handle.db.execute(sql`
      INSERT INTO articles (page_key, source, title, slug, url)
      SELECT key, 'fandom', title, lower(title), url FROM pages
    `);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('reads a section’s chunks in document order, on its page only, whole headings only', async () => {
    const families = await fetchFamilies(handle.db, [
      { pageKey: 'fandom:3', anchor: 'Usage' },
      { pageKey: 'fandom:4', anchor: 'Usage' },
    ]);
    // Numerically ordered (2, 3, 10, not "10" before "2"); no "Usage tips", no
    // "Usages", no infobox; Other's Usage stays Other's.
    expect(families.get(familyKey('fandom:3', 'Usage'))?.map((m) => m.id)).toEqual([
      'fandom:3:prose:2',
      'fandom:3:prose:3',
      'fandom:3:prose:10',
    ]);
    expect(families.get(familyKey('fandom:4', 'Usage'))?.map((m) => m.id)).toEqual(['fandom:4:prose:2']);
  });

  it('reads a subsection as a family of its own', async () => {
    const families = await fetchFamilies(handle.db, [{ pageKey: 'fandom:3', anchor: 'Usage > Building' }]);
    expect(families.get(familyKey('fandom:3', 'Usage > Building'))?.map((m) => m.id)).toEqual(['fandom:3:prose:2']);
  });

  it('reads pinned sections in the order the articles were named, then in document order', async () => {
    const ids = (sections: { id: string }[][]) => sections.map((rows) => rows.map((r) => r.id));
    expect(ids(await fetchPinnedSections(handle.db, ['bronze', 'tin'], 'uses'))).toEqual([
      ['fandom:2:prose:2'],
      ['fandom:1:prose:2', 'fandom:1:prose:3'],
    ]);
    const tinFirst = await fetchPinnedSections(handle.db, ['tin', 'odd', 'bronze'], 'uses');
    expect(ids(tinFirst)).toEqual([
      ['fandom:1:prose:2', 'fandom:1:prose:3'],
      ['fandom:3:prose:2', 'fandom:3:prose:3', 'fandom:3:prose:10'],
      ['fandom:2:prose:2'],
    ]);
    expect(tinFirst[0]![0]).toMatchObject({ slug: 'tin', pageKey: 'fandom:1', tokenCount: 11 });
  });

  it('leaves out an article without the section, and reads a where answer from the lead prose only', async () => {
    // Odd has neither a lead nor an Availability section, no article is
    // "nowhere", and Tin's lead infobox is not read.
    const where = await fetchPinnedSections(handle.db, ['odd', 'tin', 'nowhere'], 'where');
    expect(where.map((rows) => rows.map((r) => r.id))).toEqual([['fandom:1:prose:1']]);
  });

  it('pins the Usage section a uses question asks for, whole, at the head of the context', async () => {
    const question = '¿Qué puedo hacer con el estaño?';
    const results = await retrieve(handle.db, { queries: [question], question, linker: linker(), embedFn: fakeEmbedAsync });

    expect(results[0]).toMatchObject({
      title: 'Tin',
      sectionPath: 'Usage',
      kind: STITCHED_KIND,
      ids: ['fandom:1:prose:2', 'fandom:1:prose:3'],
      ranks: { pinned: 1 },
    });
    expect(results[0]!.content).toBe('Tin › Usage\nBuilding: Cauldron, Mead ketill\nCrafting: Bronze, Butcher knife');
    // Each chunk once: the pinned ones are not ranked in again.
    const ids = results.flatMap((r) => r.ids ?? [r.id]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pins every thing a question names, in its order', async () => {
    const question = '¿Qué puedo hacer con el bronce y el estaño?';
    const results = await retrieve(handle.db, { queries: [question], question, linker: linker(), embedFn: fakeEmbedAsync });
    expect(results.slice(0, 2).map((r) => [r.title, r.ranks.pinned])).toEqual([
      ['Bronze', 1],
      ['Tin', 2],
    ]);
  });

  /*
   * A Puter reader's follow-up, or any reader's under CHAT_REWRITE=off: the
   * previous question is folded into the second query, and what it named is
   * not what is asked now. Pinned, its list sat ahead of everything ranking
   * found.
   */
  it('pins only what the question names when its queries are its own, a follow-up’s included', async () => {
    const question = 'What can I make with tin?';
    const queries = deterministicQueries(question, [
      { role: 'user', text: 'What can I make with bronze?' },
      { role: 'assistant', text: 'Anvils and a Forge [1].' },
    ]);
    expect(queries[1]).toContain('bronze');
    const results = await retrieve(handle.db, { queries, question, linker: linker(), embedFn: fakeEmbedAsync });
    expect(results.filter((r) => 'pinned' in r.ranks).map((r) => r.title)).toEqual(['Tin']);
  });

  it('pins what a model’s queries name that the question does not', async () => {
    // "Zinn" is no name in the index; the rewrite names Tin.
    const question = 'Was kann ich mit Zinn herstellen?';
    const pinned = async (rewritten?: boolean) => {
      const results = await retrieve(handle.db, {
        queries: ['Tin used for'],
        rewritten,
        question,
        linker: linker(),
        embedFn: fakeEmbedAsync,
      });
      return results.filter((r) => 'pinned' in r.ranks).map((r) => r.title);
    };
    expect(await pinned(true)).toEqual(['Tin']);
    expect(await pinned()).toEqual([]);
  });

  it('pins nothing without the question, and still completes a selected section', async () => {
    const results = await retrieve(handle.db, { queries: ['Tin Usage Crafting Bronze Butcher knife'], embedFn: fakeEmbedAsync });
    expect(results.some((r) => 'pinned' in r.ranks)).toBe(false);
    const usage = results.find((r) => r.title === 'Tin' && r.sectionPath === 'Usage');
    expect(usage).toMatchObject({ kind: STITCHED_KIND, ids: ['fandom:1:prose:2', 'fandom:1:prose:3'] });
    expect(usage!.ranks).not.toHaveProperty('pinned');
  });

  it('reads the names from the database when no linker is given', async () => {
    const question = 'What can I make with tin?';
    const results = await retrieve(handle.db, { queries: [question], question, embedFn: fakeEmbedAsync });
    expect(results[0]).toMatchObject({ title: 'Tin', sectionPath: 'Usage', ranks: { pinned: 1 } });
  });

  it('never takes the context past its ceiling, pins and sections included', async () => {
    const question = '¿Qué puedo hacer con el estaño?';
    for (const maxContextTokens of [25, 40, 60, 90]) {
      const results = await retrieve(handle.db, {
        queries: [question, 'Tin Smelter Bronze Forge'],
        question,
        linker: linker(),
        maxContextTokens,
        embedFn: fakeEmbedAsync,
      });
      expect(results[0]).toMatchObject({ title: 'Tin', sectionPath: 'Usage' });
      const total = results.reduce((sum, r) => sum + contextTokens(r.content), 0);
      expect(total).toBeLessThanOrEqual(maxContextTokens);
    }
  });

  it('answers from ranking alone when the names cannot be linked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const question = '¿Qué puedo hacer con el estaño?';
      const results = await retrieve(handle.db, {
        queries: [question],
        question,
        linker: titleLinker(async () => {
          throw new Error('index unavailable');
        }),
        embedFn: fakeEmbedAsync,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => 'pinned' in r.ranks)).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
