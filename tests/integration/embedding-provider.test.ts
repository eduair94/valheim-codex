import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db/create-db';
import { rawQuery } from '@/lib/db/create-db';
import { EMBEDDING_PROVIDER_KEY, getSetting } from '@/lib/db/repo';
import { EmbeddingProviderMismatchError, IngestConfigError, planVectors, runIngest } from '@/lib/ingest/run';
import { toVectorLiteral } from '@/lib/rag/embed-types';
import { MediaWikiClient, type FetchLike } from '@/lib/wiki/mediawiki';
import { createTestDb } from '../helpers/db';
import { fakeEmbed } from '../helpers/fake-embed';

const fakeEmbedMany = async (texts: string[]): Promise<number[][]> => texts.map(fakeEmbed);

type FixtureWiki = {
  fetchImpl: FetchLike;
  parses: () => number;
  /** Makes the page listing fail, as when Fandom refuses or the network is down. */
  setDown: (down: boolean) => void;
};

async function fixtureWiki(): Promise<FixtureWiki> {
  const pages = await Promise.all(
    [
      { pageid: 1, title: 'Iron', fixture: 'Iron' },
      { pageid: 2, title: 'Forge', fixture: 'Forge' },
    ].map(async (p) => {
      const raw = await readFile(`tests/fixtures/${p.fixture}.json`, 'utf8');
      return { ...p, html: (JSON.parse(raw) as { parse: { text: string } }).parse.text };
    }),
  );
  let parses = 0;
  let down = false;

  const fetchImpl: FetchLike = async (url: string) => {
    const params = new URL(url).searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

    // The recipe graph a run assembles asks where the titles its recipes name
    // lead. None of these is a redirect, and none is a page fetch either: were
    // it counted as one, a run would seem to read pages it never read.
    if (params.get('redirects') === '1') return json({ query: {} });
    if (params.get('list') === 'allpages') {
      if (down) return new Response('Service Unavailable', { status: 503 });
      return json({ query: { allpages: pages.map((p) => ({ pageid: p.pageid, title: p.title })) } });
    }
    if (params.get('prop') === 'revisions') {
      return json({ query: { pages: pages.map((p) => ({ pageid: p.pageid, revisions: [{ revid: 7 }] })) } });
    }
    parses += 1;
    const page = pages.find((p) => p.pageid === Number(params.get('pageid')))!;
    return json({ parse: { title: page.title, pageid: page.pageid, revid: 7, text: page.html, categories: [] } });
  };

  return { fetchImpl, parses: () => parses, setDown: (value) => (down = value) };
}

describe('embedding provider guard', () => {
  // One database for the file, emptied before every test (see ingest.test.ts).
  let handle: DbHandle;
  let wiki: Awaited<ReturnType<typeof fixtureWiki>>;

  beforeAll(async () => {
    handle = await createTestDb();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.db.execute(sql`TRUNCATE pages, settings, ingest_runs CASCADE`);
    wiki = await fixtureWiki();
  });

  const ingest = (overrides = {}) =>
    runIngest({
      db: handle.db,
      client: new MediaWikiClient({ contact: 't@example.com', fetchImpl: wiki.fetchImpl, sleep: async () => {} }),
      embedFn: fakeEmbedMany,
      embeddingProviderId: 'alpha',
      runId: `run-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    });

  const count = async (where: string): Promise<number> => {
    const rows = await rawQuery<{ n: string }>(handle.db, sql.raw(`SELECT count(*)::text AS n FROM chunks ${where}`));
    return Number(rows[0]!.n);
  };

  /** Every stored vector, so a test can tell whether any of them moved. */
  const vectors = () =>
    rawQuery<{ id: string; v: string | null }>(handle.db, sql`SELECT id, embedding::text AS v FROM chunks ORDER BY id`);

  it('records the provider that built the index', async () => {
    await ingest();
    expect(await getSetting(handle.db, EMBEDDING_PROVIDER_KEY)).toBe('alpha');
  });

  it('refuses a different provider and leaves the index exactly as it was', async () => {
    // The scheduled workflow ran without EMBEDDING_PROVIDER, so it would have
    // embedded with Gemini against the local-built production index — and
    // the old answer to that was to drop every vector.
    await ingest();
    const before = await vectors();
    const embedSpy = vi.fn(fakeEmbedMany);

    await expect(ingest({ embeddingProviderId: 'beta', embedFn: embedSpy, full: true })).rejects.toBeInstanceOf(
      EmbeddingProviderMismatchError,
    );

    expect(embedSpy).not.toHaveBeenCalled();
    expect(await vectors()).toEqual(before);
    expect(await getSetting(handle.db, EMBEDDING_PROVIDER_KEY)).toBe('alpha');

    const runs = await rawQuery<{ status: string; errors: { message: string }[] }>(
      handle.db,
      sql`SELECT status, errors FROM ingest_runs ORDER BY started_at DESC LIMIT 1`,
    );
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.errors[0]!.message).toMatch(/--switch-provider=beta/);
  });

  it('refuses a different provider even with reembed', async () => {
    // `--reembed` used to double as the switch: from a shell without
    // EMBEDDING_PROVIDER, a routine recompute moved the index to Gemini while
    // the app kept embedding questions with the local model.
    await ingest();
    const before = await vectors();
    const embedSpy = vi.fn(fakeEmbedMany);

    await expect(ingest({ embeddingProviderId: 'beta', embedFn: embedSpy, reembed: true })).rejects.toBeInstanceOf(
      EmbeddingProviderMismatchError,
    );

    expect(embedSpy).not.toHaveBeenCalled();
    expect(await vectors()).toEqual(before);
    expect(await getSetting(handle.db, EMBEDDING_PROVIDER_KEY)).toBe('alpha');
  });

  it('refuses a switch to a provider the run is not configured with', async () => {
    await ingest();
    const before = await vectors();

    const run = ingest({ embeddingProviderId: 'beta', switchProvider: 'gamma' });
    await expect(run).rejects.toBeInstanceOf(IngestConfigError);
    await expect(run).rejects.toThrow(/EMBEDDING_PROVIDER=gamma/);

    expect(await vectors()).toEqual(before);
    expect(await getSetting(handle.db, EMBEDDING_PROVIDER_KEY)).toBe('alpha');
  });

  it('switches provider when asked by name, re-embedding every chunk it dropped', async () => {
    await ingest();
    const total = await count('');
    const parsesBefore = wiki.parses();
    const embedSpy = vi.fn(fakeEmbedMany);
    const events: string[] = [];

    // Not `full`: no page changed, so none is re-fetched — yet every vector
    // is rebuilt, from the chunk text the database already holds.
    const second = await ingest({
      embeddingProviderId: 'beta',
      embedFn: embedSpy,
      switchProvider: 'beta',
      onProgress: (e: { type: string }) => events.push(e.type),
    });

    expect(events).toContain('reembed');
    expect(second.pagesChanged).toBe(0);
    expect(wiki.parses()).toBe(parsesBefore);
    expect(second.embeddingsComputed).toBe(total);
    expect(embedSpy.mock.calls.reduce((n, [texts]) => n + texts.length, 0)).toBe(total);
    expect(await count('WHERE embedding IS NULL')).toBe(0);
    expect(await getSetting(handle.db, EMBEDDING_PROVIDER_KEY)).toBe('beta');
  });

  it('finishes an interrupted switch when it is run again, instead of starting over', async () => {
    await ingest();
    const total = await count('');

    // The new provider refuses, as Gemini's free tier does once a day's quota is spent.
    const exhausted = async (): Promise<number[][]> => {
      throw new Error('quota exhausted');
    };
    await expect(ingest({ embeddingProviderId: 'beta', embedFn: exhausted, switchProvider: 'beta' })).rejects.toThrow(
      /quota exhausted/,
    );
    expect(await count('WHERE embedding IS NULL')).toBe(total);
    // Recorded already, so no later run can add the old provider's vectors to the new ones.
    expect(await getSetting(handle.db, EMBEDDING_PROVIDER_KEY)).toBe('beta');
    await expect(ingest()).rejects.toBeInstanceOf(EmbeddingProviderMismatchError);

    // Say a later attempt got five chunks in before it stopped too.
    await handle.db.execute(sql`
      UPDATE chunks SET embedding = ${toVectorLiteral(fakeEmbed('done'))}::vector
      WHERE id IN (SELECT id FROM chunks ORDER BY id LIMIT 5)`);

    const again = await ingest({ embeddingProviderId: 'beta', switchProvider: 'beta' });
    expect(again.embeddingsComputed).toBe(total - 5);
    expect(await count('WHERE embedding IS NULL')).toBe(0);
  });

  it('keeps every vector when a re-embed cannot reach the wiki', async () => {
    // The vectors are rebuilt from stored text before the wiki is read; done
    // after, a refused page listing left the whole index without them.
    await ingest();
    const total = await count('');
    wiki.setDown(true);
    const embedSpy = vi.fn(fakeEmbedMany);

    await expect(ingest({ reembed: true, embedFn: embedSpy })).rejects.toThrow();

    expect(await count('WHERE embedding IS NULL')).toBe(0);
    expect(embedSpy.mock.calls.reduce((n, [texts]) => n + texts.length, 0)).toBe(total);
    const runs = await rawQuery<{ status: string }>(
      handle.db,
      sql`SELECT status FROM ingest_runs ORDER BY started_at DESC LIMIT 1`,
    );
    expect(runs[0]!.status).toBe('failed');
  });

  it('keeps every vector when a provider switch cannot reach the wiki', async () => {
    await ingest();
    wiki.setDown(true);

    await expect(ingest({ embeddingProviderId: 'beta', switchProvider: 'beta' })).rejects.toThrow();

    expect(await count('WHERE embedding IS NULL')).toBe(0);
    expect(await getSetting(handle.db, EMBEDDING_PROVIDER_KEY)).toBe('beta');
  });

  it('re-embeds every chunk on request even without a provider change', async () => {
    await ingest();
    const total = await count('');
    const second = await ingest({ reembed: true });
    expect(second.embeddingsComputed).toBe(total);
    expect(await count('WHERE embedding IS NULL')).toBe(0);
  });

  it('re-embeds every chunk with full and reembed together, exactly once each', async () => {
    await ingest();
    const total = await count('');
    const second = await ingest({ full: true, reembed: true });
    expect(second.embeddingsComputed).toBe(total);
    expect(await count('WHERE embedding IS NULL')).toBe(0);
  });

  it('reuses embeddings when the provider is unchanged', async () => {
    await ingest();
    const embedSpy = vi.fn(fakeEmbedMany);
    const second = await ingest({ embedFn: embedSpy, full: true });

    expect(second.embeddingsComputed).toBe(0);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('gives a vector back to every chunk an earlier run left without one', async () => {
    await ingest();
    await handle.db.execute(sql`UPDATE chunks SET embedding = NULL WHERE id IN (SELECT id FROM chunks ORDER BY id LIMIT 5)`);

    type VectorsEvent = { type: string; embedded?: number; total?: number };
    const events: VectorsEvent[] = [];
    const second = await ingest({ onProgress: (e: VectorsEvent) => events.push(e) });

    expect(second.embeddingsComputed).toBe(5);
    expect(events.filter((e) => e.type === 'vectors').at(-1)).toEqual({ type: 'vectors', embedded: 5, total: 5 });
    expect(await count('WHERE embedding IS NULL')).toBe(0);
  });

  it('fills those holes even when the wiki cannot be reached', async () => {
    await ingest();
    await handle.db.execute(sql`UPDATE chunks SET embedding = NULL WHERE id IN (SELECT id FROM chunks ORDER BY id LIMIT 5)`);
    wiki.setDown(true);

    await expect(ingest()).rejects.toThrow();
    expect(await count('WHERE embedding IS NULL')).toBe(0);
  });

  it('fails the run rather than finish with chunks that have no vector', async () => {
    // A provider that answers with nothing leaves every chunk without a vector.
    await expect(ingest({ embedFn: async () => [] })).rejects.toThrow(/returned 0 vectors/);

    const runs = await rawQuery<{ status: string }>(handle.db, sql`SELECT status FROM ingest_runs`);
    expect(runs.map((r) => r.status)).toEqual(['failed']);

    // The next healthy run repairs it.
    await ingest();
    expect(await count('WHERE embedding IS NULL')).toBe(0);
  });
});

describe('planVectors', () => {
  const plan = (stored: string | null, configured: string, options: { reembed?: boolean; switchProvider?: string } = {}) =>
    planVectors(stored, configured, { reembed: false, ...options });

  it('keeps the vectors of the provider that built the index, or of a new index', () => {
    expect(plan('local', 'local')).toBe('keep');
    expect(plan(null, 'gemini')).toBe('keep');
  });

  it('rebuilds them on request, with the same provider only', () => {
    expect(plan('local', 'local', { reembed: true })).toBe('rebuild');
    expect(() => plan('local', 'gemini', { reembed: true })).toThrow(EmbeddingProviderMismatchError);
  });

  it('switches only to the provider both the configuration and the command name', () => {
    expect(plan('local', 'gemini', { switchProvider: 'gemini' })).toBe('switch');
    expect(() => plan('local', 'gemini', { switchProvider: 'local' })).toThrow(IngestConfigError);
    expect(() => plan('local', 'local', { switchProvider: 'gemini' })).toThrow(IngestConfigError);
    // Already there: nothing to switch, and what an interrupted switch left is filled in.
    expect(plan('gemini', 'gemini', { switchProvider: 'gemini' })).toBe('keep');
    expect(plan('gemini', 'gemini', { switchProvider: 'gemini', reembed: true })).toBe('rebuild');
  });

  it('says how to fix a mismatch, and that the app must follow a switch', () => {
    expect(() => plan('local', 'gemini')).toThrow(/EMBEDDING_PROVIDER=local.*--switch-provider=gemini.*app/s);
  });
});
