import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db/create-db';
import { createTestDb } from '../helpers/db';
import { seedSearchCorpus } from '../helpers/search-seed';

/**
 * The data loaders under the real `unstable_cache`, which the other data
 * tests replace with a pass-through. Two of its behaviours decide what the
 * loaders may do, and a pass-through has neither:
 *
 *   - inside an `unstable_cache` callback, another `unstable_cache` skips its
 *     read and runs every time (the store says "unstable-cache");
 *   - a stale entry is served while it refills in the background, and keeps
 *     its old value when the refill rejects — which is what `NotStored` does
 *     when the thing the entry describes is gone.
 *
 * Each call runs as a request does on a dynamic page: a work store and a
 * "request" work-unit store, with Next's pending cache writes awaited after.
 * The incremental cache is a recording stand-in kept in memory; ages are
 * moved by hand, and the loaders' own ten-minute lists by moving `Date.now`.
 */

const state = vi.hoisted(() => {
  // Next's request stores are AsyncLocalStorage where the runtime provides it
  // globally, as `next start` does; otherwise `run` throws.
  const { AsyncLocalStorage } = process.getBuiltinModule('node:async_hooks');
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
  return { db: null as unknown, statements: [] as string[], clock: 0 };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db/client', () => ({ getDb: async () => state.db }));

const nextRequire = createRequire(import.meta.url);
const { workAsyncStorage } = nextRequire('next/dist/server/app-render/work-async-storage.external') as {
  workAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
};
const { workUnitAsyncStorage } = nextRequire('next/dist/server/app-render/work-unit-async-storage.external') as {
  workUnitAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
};

type Entry = { value: { kind: string; data: { body: string }; revalidate: number }; lastModified: number };

/** The part of Next's incremental cache `unstable_cache` uses, recording each read and write by loader. */
class RecordingCache {
  readonly entries = new Map<string, Entry>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly isOnDemandRevalidate = false;
  private readonly names = new Map<string, string>();

  async generateSimpleCacheKey(invocationKey: string): Promise<string> {
    const hash = createHash('sha256').update(invocationKey).digest('hex');
    // `<function source>-<key parts>-<arguments as JSON>`: the loader's key part names it.
    const parts = [...invocationKey.matchAll(/-(wiki-[a-z-]+)-\[/g)];
    this.names.set(hash, parts.at(-1)?.[1] ?? 'other');
    return hash;
  }

  async get(key: string, ctx: { revalidate?: number }) {
    this.reads.push(this.names.get(key)!);
    const entry = this.entries.get(key);
    if (!entry) return null;
    const revalidate = ctx.revalidate || entry.value.revalidate;
    return {
      isStale: (Date.now() - entry.lastModified) / 1000 > revalidate,
      value: { ...entry.value, revalidate },
    };
  }

  async set(key: string, value: Entry['value']): Promise<void> {
    this.writes.push(this.names.get(key)!);
    this.entries.set(key, { value, lastModified: Date.now() });
  }

  /** Makes every entry `seconds` older. */
  age(seconds: number): void {
    for (const entry of this.entries.values()) entry.lastModified -= seconds * 1000;
  }

  count(list: readonly string[], name: string): number {
    return list.filter((n) => n === name).length;
  }
}

const incremental = new RecordingCache();

/** One request to a dynamic page, then the cache writes Next would await before finishing it. */
async function inRequest<T>(load: () => Promise<T>, pathname = '/wiki'): Promise<T> {
  const workStore: { pendingRevalidates?: Record<string, Promise<unknown>> } & Record<string, unknown> = {
    incrementalCache: incremental,
    nextFetchId: 1,
    pendingRevalidates: undefined,
    fetchCache: undefined,
    forceDynamic: true,
    isOnDemandRevalidate: false,
    isDraftMode: false,
    route: pathname,
  };
  const requestStore = {
    type: 'request',
    phase: 'render',
    url: { pathname, search: '' },
    implicitTags: { tags: [], expirationsByCacheKind: new Map() },
  };
  const result = await workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, load));
  // Background refills can queue writes of their own while they run.
  const settled = new Set<Promise<unknown>>();
  for (;;) {
    const pending = Object.values(workStore.pendingRevalidates ?? {}).filter((p) => !settled.has(p));
    if (pending.length === 0) break;
    await Promise.all(pending);
    for (const p of pending) settled.add(p);
  }
  return result;
}

const realNow = Date.now.bind(Date);
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + state.clock);

/** Past the ten minutes the slug list and the filter values are held. */
const reloadHeldLists = () => {
  state.clock += 11 * 60 * 1000;
};

const data = await import('@/lib/wiki/data');

/** Statements that read every article's biome evidence (`listBiomeEvidence`). */
const biomeReads = () => state.statements.filter((s) => /AS craftable/.test(s)).length;

describe('the data loaders under the real unstable_cache', () => {
  let handle: DbHandle;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    handle = await createTestDb();
    await seedSearchCorpus(handle.db);
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
    // Next reports a failed background refill on the console; the tests count them.
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  }, 180_000);

  afterAll(async () => {
    errors?.mockRestore();
    vi.restoreAllMocks();
    await handle?.close();
  });

  /** Every loader that reads the biome ladder, once each, as separate requests. */
  async function biomeRound(): Promise<void> {
    await inRequest(() => data.getBrowseAxes('es'), '/wiki');
    await inRequest(() => data.getBrowseAxes('en'), '/wiki/browse');
    await inRequest(() => data.getCategoryListing({ biome: 'Meadows' }, 'es'), '/wiki/c/all');
    await inRequest(() => data.getCompareView({ biome: 'Meadows' }, undefined, 'es'), '/wiki/c/all');
  }

  it('reads the biome ladder once for all the loaders that need it, from its own entry', async () => {
    const before = biomeReads();
    const entryReads = incremental.count(incremental.reads, 'wiki-biome-members');
    const entryWrites = incremental.count(incremental.writes, 'wiki-biome-members');
    await biomeRound();
    // Cold: one read of the evidence, then the ladder's entry answers every
    // other loader (a comparison asks twice outside a React request, where
    // `cache()` shares nothing). Nested inside their caches, the evidence was
    // read five times and the entry never.
    expect(biomeReads() - before).toBe(1);
    expect(incremental.count(incremental.writes, 'wiki-biome-members') - entryWrites).toBe(1);
    expect(incremental.count(incremental.reads, 'wiki-biome-members') - entryReads).toBeGreaterThanOrEqual(4);

    const warm = biomeReads();
    await biomeRound();
    expect(biomeReads() - warm).toBe(0);

    // An hour on, everything refills, the ladder once.
    incremental.age(3601);
    const hourly = biomeReads();
    await biomeRound();
    expect(biomeReads() - hourly).toBe(1);
  });

  it('never runs a cached loader inside another, where its own entry would never be read', async () => {
    await inRequest(() => data.getArticlePage('iron-sword', 'es'), '/wiki/a/iron-sword');
    await inRequest(() => data.getCategoryListing({ category: 'Weapons' }, 'es'), '/wiki/c/Weapons');
    await inRequest(() => data.getCompareView({ category: 'Weapons' }, '2', 'es'), '/wiki/c/Weapons');
    await inRequest(() => data.getSearchIndexData(), '/api/wiki/index');
    // A nested cache writes its entry without having looked for it first.
    for (const name of new Set(incremental.writes)) {
      expect(incremental.count(incremental.reads, name), name).toBeGreaterThanOrEqual(
        incremental.count(incremental.writes, name),
      );
    }
  });

  it('answers a slug no article has with one lookup, and neither reads nor writes the cache', async () => {
    await inRequest(() => data.getArticlePage('iron', 'en'), '/wiki/a/iron'); // the slug list is held from here on
    const reads = incremental.count(incremental.reads, 'wiki-article-page');
    const writes = incremental.count(incremental.writes, 'wiki-article-page');
    state.statements.length = 0;
    expect(await inRequest(() => data.getArticlePage('no-such-article', 'es'), '/wiki/a/no-such-article')).toBeNull();
    expect(state.statements).toHaveLength(1);
    expect(incremental.count(incremental.reads, 'wiki-article-page')).toBe(reads);
    expect(incremental.count(incremental.writes, 'wiki-article-page')).toBe(writes);
  });

  it('stops serving a deleted article once the slug list is reloaded, instead of its stale entry forever', async () => {
    const page = '/wiki/a/troll';
    expect((await inRequest(() => data.getArticlePage('troll', 'en'), page))?.title).toBe('Troll');

    // What the ingest does to a page the wiki removed: the article goes with it.
    await handle.db.execute(sql`DELETE FROM pages WHERE key = (SELECT page_key FROM articles WHERE slug = 'troll')`);
    incremental.age(4000);

    // Until the slug list is reloaded the cache still answers, with the page
    // it kept; its refill finds nothing and Next keeps the old value.
    expect((await inRequest(() => data.getArticlePage('troll', 'en'), page))?.title).toBe('Troll');

    reloadHeldLists();
    errors.mockClear();
    const reads = incremental.count(incremental.reads, 'wiki-article-page');
    for (let hit = 0; hit < 3; hit += 1) {
      expect(await inRequest(() => data.getArticlePage('troll', 'en'), page)).toBeNull();
    }
    // Not served, not asked about, and nothing reported per hit.
    expect(incremental.count(incremental.reads, 'wiki-article-page')).toBe(reads);
    expect(errors).not.toHaveBeenCalled();
  });

  it('stops listing a category the wiki emptied once the filter values are reloaded', async () => {
    const page = '/wiki/c/Trinket';
    const listing = await inRequest(() => data.getCategoryListing({ category: 'Trinket' }, 'en'), page);
    expect(listing.articles.map((a) => a.slug)).toEqual(['jormundling']);
    const compare = await inRequest(() => data.getCompareView({ category: 'Trinket' }, undefined, 'en'), page);
    expect(compare.tabs).toEqual([]);

    await handle.db.execute(sql`DELETE FROM pages WHERE key = (SELECT page_key FROM articles WHERE slug = 'jormundling')`);
    incremental.age(4000);
    reloadHeldLists();
    errors.mockClear();
    const reads = incremental.count(incremental.reads, 'wiki-category-listing');
    const setReads = incremental.count(incremental.reads, 'wiki-compare-set');
    for (let hit = 0; hit < 3; hit += 1) {
      expect((await inRequest(() => data.getCategoryListing({ category: 'Trinket' }, 'en'), page)).articles).toEqual([]);
      expect((await inRequest(() => data.getCompareView({ category: 'Trinket' }, undefined, 'en'), page)).table.rows).toEqual([]);
    }
    expect(incremental.count(incremental.reads, 'wiki-category-listing')).toBe(reads);
    expect(incremental.count(incremental.reads, 'wiki-compare-set')).toBe(setReads);
    expect(errors).not.toHaveBeenCalled();
  });
});
