import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db/create-db';
import { rawQuery } from '@/lib/db/create-db';
import { EMBEDDING_PROVIDER_KEY, getSetting } from '@/lib/db/repo';
import { runIngest } from '@/lib/ingest/run';
import { MediaWikiClient, type FetchLike } from '@/lib/wiki/mediawiki';
import { createTestDb } from '../helpers/db';
import { fakeEmbed } from '../helpers/fake-embed';

const fakeEmbedMany = async (texts: string[]): Promise<number[][]> => texts.map(fakeEmbed);

async function fixtureWiki(): Promise<FetchLike> {
  const raw = await readFile('tests/fixtures/Iron.json', 'utf8');
  const html = (JSON.parse(raw) as { parse: { text: string } }).parse.text;

  return async (url: string) => {
    const params = new URL(url).searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

    if (params.get('list') === 'allpages') {
      return json({ query: { allpages: [{ pageid: 1, title: 'Iron' }] } });
    }
    if (params.get('prop') === 'revisions') {
      return json({ query: { pages: [{ pageid: 1, revisions: [{ revid: 7 }] }] } });
    }
    return json({ parse: { title: 'Iron', pageid: 1, revid: 7, text: html, categories: [] } });
  };
}

describe('embedding provider guard', () => {
  let handle: DbHandle;
  let fetchImpl: FetchLike;

  beforeEach(async () => {
    handle = await createTestDb();
    fetchImpl = await fixtureWiki();
  });

  afterEach(async () => {
    await handle?.close();
  });

  const ingest = (overrides = {}) =>
    runIngest({
      db: handle.db,
      client: new MediaWikiClient({ contact: 't@example.com', fetchImpl, sleep: async () => {} }),
      embedFn: fakeEmbedMany,
      embeddingProviderId: 'alpha',
      runId: `run-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    });

  it('records the provider that built the index', async () => {
    await ingest();
    expect(await getSetting(handle.db, EMBEDDING_PROVIDER_KEY)).toBe('alpha');
  });

  it('re-embeds everything when the provider changes', async () => {
    await ingest();

    // Same revision, so nothing would normally be re-parsed or re-embedded —
    // but vectors from a different model cannot be mixed with the stored ones.
    const embedSpy = vi.fn(fakeEmbedMany);
    const events: string[] = [];
    const second = await ingest({
      embeddingProviderId: 'beta',
      embedFn: embedSpy,
      full: true,
      onProgress: (e: { type: string }) => events.push(e.type),
    });

    expect(events).toContain('reembed');
    expect(second.embeddingsComputed).toBeGreaterThan(0);
    expect(embedSpy).toHaveBeenCalled();
    expect(await getSetting(handle.db, EMBEDDING_PROVIDER_KEY)).toBe('beta');
  });

  it('leaves no chunk carrying a vector from the previous provider', async () => {
    await ingest();
    await ingest({ embeddingProviderId: 'beta', full: true });

    const rows = await rawQuery<{ missing: string }>(
      handle.db,
      sql`SELECT count(*)::text AS missing FROM chunks WHERE embedding IS NULL`,
    );
    expect(Number(rows[0]!.missing)).toBe(0);
  });

  it('reuses embeddings when the provider is unchanged', async () => {
    await ingest();
    const embedSpy = vi.fn(fakeEmbedMany);
    const second = await ingest({ embedFn: embedSpy, full: true });

    expect(second.embeddingsComputed).toBe(0);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('re-embeds on request even without a provider change', async () => {
    await ingest();
    const second = await ingest({ full: true, reembed: true });
    expect(second.embeddingsComputed).toBeGreaterThan(0);
  });
});
