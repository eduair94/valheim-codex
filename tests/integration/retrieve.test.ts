import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db/create-db';
import { retrieve } from '@/lib/rag/retrieve';
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
});
