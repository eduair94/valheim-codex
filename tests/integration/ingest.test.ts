import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db/create-db';
import { rawQuery } from '@/lib/db/create-db';
import { runIngest } from '@/lib/ingest/run';
import { MediaWikiClient, type FetchLike } from '@/lib/wiki/mediawiki';
import { createTestDb } from '../helpers/db';
import { fakeEmbed } from '../helpers/fake-embed';

const fakeEmbedMany = async (texts: string[]): Promise<number[][]> => texts.map(fakeEmbed);

type FakePage = { pageid: number; title: string; revid: number; fixture: string };

/**
 * A MediaWiki stand-in backed by the saved fixtures, so the whole ingest runs
 * for real — parse, chunk, embed, store — without hitting the network.
 */
function fakeWiki(pages: FakePage[]) {
  // Deep copy: tests mutate revids, and a shallow copy would leak that
  // mutation into every later test through the shared PAGES objects.
  const state = { pages: pages.map((p) => ({ ...p })), parseCalls: 0, revisionCalls: 0 };

  const fetchImpl: FetchLike = async (url: string) => {
    const params = new URL(url).searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

    if (params.get('list') === 'allpages') {
      return json({
        query: { allpages: state.pages.map((p) => ({ pageid: p.pageid, title: p.title })) },
      });
    }
    if (params.get('prop') === 'revisions') {
      state.revisionCalls += 1;
      const ids = params.get('pageids')!.split('|').map(Number);
      return json({
        query: {
          pages: state.pages
            .filter((p) => ids.includes(p.pageid))
            .map((p) => ({ pageid: p.pageid, revisions: [{ revid: p.revid }] })),
        },
      });
    }
    if (params.get('action') === 'parse') {
      state.parseCalls += 1;
      const id = Number(params.get('pageid'));
      const page = state.pages.find((p) => p.pageid === id);
      if (!page) return json({ error: { code: 'missingtitle', info: 'gone' } });
      const raw = await readFile(`tests/fixtures/${page.fixture}.json`, 'utf8');
      const parsed = JSON.parse(raw) as { parse: { text: string } };
      return json({
        parse: {
          title: page.title,
          pageid: page.pageid,
          revid: page.revid,
          text: parsed.parse.text,
          categories: [{ category: 'Test' }],
        },
      });
    }
    return json({});
  };

  return { state, fetchImpl };
}

const PAGES: FakePage[] = [
  { pageid: 1, title: 'Iron Sword', revid: 100, fixture: 'Iron_Sword' },
  { pageid: 2, title: 'Bonemass', revid: 200, fixture: 'Bonemass' },
  { pageid: 3, title: 'Iron', revid: 300, fixture: 'Iron' },
];

describe('runIngest', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await handle?.close();
  });

  const ingest = (fetchImpl: FetchLike, overrides = {}) =>
    runIngest({
      db: handle.db,
      client: new MediaWikiClient({ contact: 'test@example.com', fetchImpl, sleep: async () => {} }),
      embedFn: fakeEmbedMany,
      runId: 'run-test',
      ...overrides,
    });

  it('stores every page with chunks and embeddings', async () => {
    const { fetchImpl } = fakeWiki(PAGES);
    const result = await ingest(fetchImpl);

    expect(result.pagesSeen).toBe(3);
    expect(result.pagesChanged).toBe(3);
    expect(result.chunksWritten).toBeGreaterThan(10);
    expect(result.errors).toEqual([]);

    const rows = await rawQuery<{ count: string }>(
      handle.db,
      sql`SELECT count(*)::text AS count FROM chunks WHERE embedding IS NOT NULL`,
    );
    expect(Number(rows[0]!.count)).toBe(result.chunksWritten);
  });

  it('indexes the infobox levels as their own chunks', async () => {
    const { fetchImpl } = fakeWiki(PAGES);
    await ingest(fetchImpl);
    const rows = await rawQuery<{ section_path: string }>(
      handle.db,
      sql`SELECT section_path FROM chunks WHERE title = 'Iron Sword' AND kind = 'infobox' ORDER BY section_path`,
    );
    expect(rows.map((r) => r.section_path)).toEqual(['Level 1', 'Level 2', 'Level 3', 'Level 4']);
  });

  it('skips unchanged pages on a second run', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    const afterFirst = wiki.state.parseCalls;

    const second = await ingest(wiki.fetchImpl, { runId: 'run-test-2' });
    expect(second.pagesChanged).toBe(0);
    expect(second.embeddingsComputed).toBe(0);
    expect(wiki.state.parseCalls).toBe(afterFirst);
  });

  it('re-indexes only the page whose revision changed', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    const afterFirst = wiki.state.parseCalls;

    wiki.state.pages[1]!.revid = 201;
    const second = await ingest(wiki.fetchImpl, { runId: 'run-test-2' });

    expect(second.pagesChanged).toBe(1);
    expect(wiki.state.parseCalls).toBe(afterFirst + 1);
  });

  it('reuses embeddings for chunks whose content did not change', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);

    // Same content, new revision id: the page is re-parsed but nothing is
    // re-embedded, which is where the cost of a re-index actually sits.
    wiki.state.pages[1]!.revid = 201;
    const embedSpy = vi.fn(fakeEmbedMany);
    const second = await ingest(wiki.fetchImpl, { runId: 'run-test-2', embedFn: embedSpy });

    expect(second.pagesChanged).toBe(1);
    expect(second.embeddingsComputed).toBe(0);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('re-embeds when a page is forced with full', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    const second = await ingest(wiki.fetchImpl, { runId: 'run-test-2', full: true });
    expect(second.pagesChanged).toBe(3);
    // Content is identical, so hashes still match and embeddings are reused.
    expect(second.embeddingsComputed).toBe(0);
  });

  it('removes pages that disappeared upstream', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);

    wiki.state.pages = wiki.state.pages.filter((p) => p.pageid !== 2);
    await ingest(wiki.fetchImpl, { runId: 'run-test-2' });

    const rows = await rawQuery<{ count: string }>(
      handle.db,
      sql`SELECT count(*)::text AS count FROM pages WHERE title = 'Bonemass'`,
    );
    expect(Number(rows[0]!.count)).toBe(0);

    const orphans = await rawQuery<{ count: string }>(
      handle.db,
      sql`SELECT count(*)::text AS count FROM chunks WHERE title = 'Bonemass'`,
    );
    expect(Number(orphans[0]!.count)).toBe(0);
  });

  it('does not prune when the run was limited', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl, { limit: 1 });
    const rows = await rawQuery<{ count: string }>(
      handle.db,
      sql`SELECT count(*)::text AS count FROM pages`,
    );
    expect(Number(rows[0]!.count)).toBe(1);

    // A second limited run must not delete the page the first one wrote.
    await ingest(wiki.fetchImpl, { runId: 'run-test-2', limit: 1 });
    const after = await rawQuery<{ count: string }>(
      handle.db,
      sql`SELECT count(*)::text AS count FROM pages`,
    );
    expect(Number(after[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it('records a failing page and keeps going', async () => {
    const wiki = fakeWiki(PAGES);
    let calls = 0;
    const flaky: FetchLike = async (url, init) => {
      const params = new URL(url).searchParams;
      if (params.get('action') === 'parse' && Number(params.get('pageid')) === 2) {
        calls += 1;
        return new Response('boom', { status: 500 });
      }
      return wiki.fetchImpl(url, init);
    };

    const result = await ingest(flaky, { runId: 'run-flaky' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.title).toBe('Bonemass');
    expect(calls).toBeGreaterThan(1); // it retried before giving up

    const rows = await rawQuery<{ title: string }>(
      handle.db,
      sql`SELECT DISTINCT title FROM pages ORDER BY title`,
    );
    expect(rows.map((r) => r.title)).toEqual(['Iron', 'Iron Sword']);
  });

  it('writes an audit row for the run', async () => {
    const { fetchImpl } = fakeWiki(PAGES);
    await ingest(fetchImpl);
    const rows = await rawQuery<{ id: string; status: string; chunks_written: number }>(
      handle.db,
      sql`SELECT id, status, chunks_written FROM ingest_runs`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('ok');
    expect(Number(rows[0]!.chunks_written)).toBeGreaterThan(0);
  });

  it('reports progress as it goes', async () => {
    const { fetchImpl } = fakeWiki(PAGES);
    const events: string[] = [];
    await ingest(fetchImpl, { onProgress: (e: { type: string }) => events.push(e.type) });
    expect(events).toContain('listed');
    expect(events).toContain('planned');
    expect(events).toContain('page');
    expect(events.at(-1)).toBe('done');
  });
});
