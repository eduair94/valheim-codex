import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RecipeGraph } from '@/lib/craft/types';
import type { Db, DbHandle } from '@/lib/db/create-db';
import { rawQuery } from '@/lib/db/create-db';
import { getLatestRecipeGraph, isRecipeGraphBehind } from '@/lib/db/recipe-repo';
import { EMBEDDING_PROVIDER_KEY, getSetting } from '@/lib/db/repo';
import { getArticleBySlug, getTranslation, saveTranslation } from '@/lib/db/wiki-repo';
import { IngestConfigError, recipeStaleness, runIngest, staleness, type ProgressEvent } from '@/lib/ingest/run';
import { NO_ARTICLE, UNFINISHED } from '@/lib/ingest/store';
import { PARSER_VERSION } from '@/lib/ingest/version';
import { MediaWikiClient, type FetchLike } from '@/lib/wiki/mediawiki';
import { RECIPES_VERSION } from '@/lib/wiki/recipes-version';
import { createTestDb } from '../helpers/db';
import { fakeEmbed } from '../helpers/fake-embed';

const fakeEmbedMany = async (texts: string[]): Promise<number[][]> => texts.map(fakeEmbed);

type FakePage = {
  pageid: number;
  title: string;
  revid: number;
  fixture: string;
  categories?: string[];
  /** An edit to the fixture's HTML, standing for a change upstream. */
  edit?: (html: string) => string;
};

/**
 * A MediaWiki stand-in backed by the saved fixtures, so the whole ingest runs
 * for real — parse, chunk, embed, store — without hitting the network.
 */
function fakeWiki(pages: FakePage[]) {
  // Deep copy: tests mutate revids, and a shallow copy would leak that
  // mutation into every later test through the shared PAGES objects.
  const state = { pages: pages.map((p) => ({ ...p })), parseCalls: 0, revisionCalls: 0, redirectCalls: 0 };

  const fetchImpl: FetchLike = async (url: string) => {
    const params = new URL(url).searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

    // The recipe graph asks where the titles its recipes name lead; here, as
    // for titles that are no redirect, nowhere.
    if (params.get('redirects') === '1') {
      state.redirectCalls += 1;
      return json({ query: {} });
    }
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
          text: page.edit ? page.edit(parsed.parse.text) : parsed.parse.text,
          categories: (page.categories ?? ['Test']).map((category) => ({ category })),
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

/*
 * One database for the whole file, emptied before every test. Booting PGlite
 * and running every migration costs seconds per test; nothing here depends on
 * more than the tables the ingest writes, and the truncate cascades from
 * pages to chunks, articles and translations.
 */
let handle: DbHandle;

beforeAll(async () => {
  handle = await createTestDb();
});

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  // The recipe graphs hang from no page, so the cascade does not reach them.
  await handle.db.execute(sql`TRUNCATE pages, settings, ingest_runs, recipe_graph CASCADE`);
});

describe('runIngest', () => {
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

  it('says why each page is re-indexed', async () => {
    const wiki = fakeWiki(PAGES);
    const plans: ProgressEvent[] = [];
    const onProgress = (e: ProgressEvent) => {
      if (e.type === 'planned') plans.push(e);
    };

    await ingest(wiki.fetchImpl, { onProgress });
    wiki.state.pages[0]!.revid = 101;
    await ingest(wiki.fetchImpl, { runId: 'run-test-2', onProgress });

    expect(plans.map((p) => p.type === 'planned' && p.reasons)).toEqual([
      { added: 3, revised: 0, unfinished: 0, parser: 0, forced: 0 },
      { added: 0, revised: 1, unfinished: 0, parser: 0, forced: 0 },
    ]);
  });

  it('finishes a page that has chunks but no article', async () => {
    // A run that failed between a page's chunks and its article recorded the
    // page's revision, so the revision alone would never bring it back.
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    await handle.db.execute(sql`DELETE FROM articles WHERE title = 'Bonemass'`);

    const second = await ingest(wiki.fetchImpl, { runId: 'run-test-2' });
    expect(second.pagesChanged).toBe(1);
    expect(await getArticleBySlug(handle.db, 'bonemass')).not.toBeNull();
  });
});

/**
 * The database, with the first statement `fails` picks failing once — as one
 * dropped request to Neon's HTTP driver would, which holds no transaction
 * around a page's writes.
 */
function failingOnce(db: Db, fails: (statement: string) => boolean): Db {
  let armed = true;
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'execute') {
        return async (query: Parameters<Db['execute']>[0]) => {
          if (armed && fails(JSON.stringify(query))) {
            armed = false;
            throw new Error('fetch failed (simulated)');
          }
          return target.execute(query);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Db;
}

describe('runIngest — a page a run stopped partway through (IT-7)', () => {
  const ingest = (db: Db, fetchImpl: FetchLike, overrides = {}) =>
    runIngest({
      db,
      client: new MediaWikiClient({ contact: 'test@example.com', fetchImpl, sleep: async () => {} }),
      embedFn: fakeEmbedMany,
      runId: `run-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    });

  const bonemass = async () =>
    (
      await rawQuery<{ revid: number; chunks: number; article: boolean }>(
        handle.db,
        sql`SELECT p.revid,
                   (SELECT count(*)::int FROM chunks c WHERE c.page_key = p.key) AS chunks,
                   EXISTS (SELECT 1 FROM articles a WHERE a.page_key = p.key) AS article
            FROM pages p WHERE p.title = 'Bonemass'`,
      )
    )[0];

  const chunkInsert = (statement: string) => statement.includes('INSERT INTO chunks') && statement.includes('fandom:2');
  const articleWrite = (statement: string) => statement.includes('INSERT INTO articles') && statement.includes('fandom:2');

  it.each([
    ['its chunks are inserted, after the old ones were deleted', chunkInsert],
    ['its article is written', articleWrite],
  ])('rewrites it on the next ordinary run when what fails is the moment %s', async (_moment, fails) => {
    // Recorded under its new revision before the chunks and the article were
    // written, a page whose write failed was never looked at again.
    const wiki = fakeWiki(PAGES);
    await ingest(handle.db, wiki.fetchImpl);
    wiki.state.pages[1]!.revid = 201;

    const broken = await ingest(failingOnce(handle.db, fails), wiki.fetchImpl);
    expect(broken.errors.map((e) => e.title)).toEqual(['Bonemass']);
    expect((await bonemass())?.revid).toBe(UNFINISHED);

    const plans: ProgressEvent[] = [];
    const next = await ingest(handle.db, wiki.fetchImpl, { onProgress: (e: ProgressEvent) => e.type === 'planned' && plans.push(e) });
    expect(next.pagesChanged).toBe(1);
    expect(plans[0]?.type === 'planned' && plans[0].reasons.unfinished).toBe(1);
    expect(await bonemass()).toMatchObject({ revid: 201, article: true });
    expect((await bonemass())!.chunks).toBeGreaterThan(0);
  });

  it('rewrites a page a --reparse stopped on without needing another --reparse', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(handle.db, wiki.fetchImpl, { parserVersion: 1 });
    const broken = await ingest(failingOnce(handle.db, chunkInsert), wiki.fetchImpl, { parserVersion: 2, reparse: true });
    expect(broken.errors).toHaveLength(1);
    expect((await bonemass())!.chunks).toBe(0);

    const next = await ingest(handle.db, wiki.fetchImpl, { parserVersion: 2 });
    expect(next.pagesChanged).toBe(1);
    expect(next.outdatedPages).toBe(0);
    expect((await bonemass())!.chunks).toBeGreaterThan(0);
  });

  it('records the revision with the article, so a page written whole is left alone', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(handle.db, wiki.fetchImpl);
    expect((await bonemass())?.revid).toBe(200);
    expect((await ingest(handle.db, wiki.fetchImpl)).pagesChanged).toBe(0);
  });
});

describe('runIngest — parser versions and translations', () => {
  const ingest = (fetchImpl: FetchLike, overrides = {}) =>
    runIngest({
      db: handle.db,
      client: new MediaWikiClient({ contact: 'test@example.com', fetchImpl, sleep: async () => {} }),
      embedFn: fakeEmbedMany,
      runId: `run-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    });

  const parserVersions = async () =>
    (await rawQuery<{ v: number }>(handle.db, sql`SELECT parser_version AS v FROM articles ORDER BY title`)).map(
      (r) => Number(r.v),
    );

  /** A Spanish translation of Iron, made from the article as it is now. */
  const translateIron = async () => {
    const article = (await getArticleBySlug(handle.db, 'iron'))!;
    await saveTranslation(handle.db, {
      pageKey: article.pageKey,
      lang: 'es',
      title: 'Hierro (Iron)',
      doc: article.doc,
      model: 'test-model',
      sourceUpdatedAt: article.updatedAt,
    });
    return article;
  };

  it('records which parser built every article', async () => {
    await ingest(fakeWiki(PAGES).fetchImpl);
    expect(await parserVersions()).toEqual([PARSER_VERSION, PARSER_VERSION, PARSER_VERSION]);
  });

  it('re-derives pages an older parser built when asked, though no page changed upstream', async () => {
    // Before this, a parser fix reached only pages someone later edited.
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl, { parserVersion: 1 });
    const afterFirst = wiki.state.parseCalls;

    const plans: ProgressEvent[] = [];
    const second = await ingest(wiki.fetchImpl, {
      parserVersion: 2,
      reparse: true,
      onProgress: (e: ProgressEvent) => e.type === 'planned' && plans.push(e),
    });

    expect(second.pagesChanged).toBe(3);
    expect(wiki.state.parseCalls).toBe(afterFirst + 3);
    expect(plans[0]?.type === 'planned' && plans[0].reasons.parser).toBe(3);
    expect(second.outdatedPages).toBe(0);
    // Same output, so nothing to re-embed and nothing for a reader to notice.
    expect(second.embeddingsComputed).toBe(0);
    expect(second.articlesChanged).toBe(0);
    expect(await parserVersions()).toEqual([2, 2, 2]);

    const third = await ingest(wiki.fetchImpl, { parserVersion: 2, reparse: true });
    expect(third.pagesChanged).toBe(0);
  });

  it('leaves what an older parser built alone unless asked, and says how much there is', async () => {
    // The owner picks the moment: re-deriving fetches every such page and
    // marks the translations of those whose text changes stale.
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl, { parserVersion: 1 });
    const afterFirst = wiki.state.parseCalls;

    const plans: ProgressEvent[] = [];
    const onProgress = (e: ProgressEvent) => e.type === 'planned' && plans.push(e);
    const second = await ingest(wiki.fetchImpl, { parserVersion: 2, onProgress });

    expect(second.pagesChanged).toBe(0);
    expect(wiki.state.parseCalls).toBe(afterFirst);
    expect(second.outdatedPages).toBe(3);
    expect(plans[0]?.type === 'planned' && plans[0].outdated).toBe(3);
    expect(await parserVersions()).toEqual([1, 1, 1]);

    // A page revised upstream is rebuilt anyway, and with the running parser.
    wiki.state.pages[2]!.revid = 301;
    const third = await ingest(wiki.fetchImpl, { parserVersion: 2, onProgress });
    expect(third.pagesChanged).toBe(1);
    expect(third.outdatedPages).toBe(2);
    expect(await parserVersions()).toEqual([1, 2, 1]); // Bonemass, Iron, Iron Sword
  });

  it('re-derives pages written before versions were recorded', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    // What the 0008 migration leaves on every existing row.
    await handle.db.execute(sql`UPDATE articles SET parser_version = 0`);

    expect((await ingest(wiki.fetchImpl)).outdatedPages).toBe(3);
    const second = await ingest(wiki.fetchImpl, { reparse: true });
    expect(second.pagesChanged).toBe(3);
    expect(await parserVersions()).toEqual([PARSER_VERSION, PARSER_VERSION, PARSER_VERSION]);
  });

  it('counts --full as a request to re-derive what an older parser built', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl, { parserVersion: 1 });
    const second = await ingest(wiki.fetchImpl, { parserVersion: 2, full: true });
    expect(second.outdatedPages).toBe(0);
    expect(await parserVersions()).toEqual([2, 2, 2]);
  });

  it('keeps a translation fresh across a full re-index of an unchanged article', async () => {
    // `--full` used to bump every article's updated_at, so all 850 Spanish
    // translations turned stale at once and signed-in views re-translated them.
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    const before = await translateIron();
    expect((await getTranslation(handle.db, before.pageKey, 'es'))!.stale).toBe(false);

    const second = await ingest(wiki.fetchImpl, { full: true });

    expect(second.articlesChanged).toBe(0);
    const after = (await getArticleBySlug(handle.db, 'iron'))!;
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await getTranslation(handle.db, before.pageKey, 'es'))!.stale).toBe(false);
  });

  it('marks the translation stale when what a reader sees did change', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    const before = await translateIron();

    // A new revision whose text is different.
    wiki.state.pages[2]!.revid = 301;
    wiki.state.pages[2]!.fixture = 'Birch';
    const second = await ingest(wiki.fetchImpl);

    expect(second.articlesChanged).toBe(1);
    expect((await getTranslation(handle.db, before.pageKey, 'es'))!.stale).toBe(true);
  });

  it('counts a new article as changed', async () => {
    const result = await ingest(fakeWiki(PAGES).fetchImpl);
    expect(result.articlesChanged).toBe(3);
  });

  it('marks the translation stale when only an image caption changed', async () => {
    // A translation keeps its captions by image URL and lays them over the
    // article's images, so an edited caption showed the old one's translation.
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    const article = (await getArticleBySlug(handle.db, 'iron-sword'))!;
    await saveTranslation(handle.db, {
      pageKey: article.pageKey,
      lang: 'es',
      title: 'Espada de hierro',
      doc: article.doc,
      model: 'test-model',
      sourceUpdatedAt: article.updatedAt,
    });

    wiki.state.pages[0]!.revid = 101;
    wiki.state.pages[0]!.edit = (html) =>
      html.replaceAll('data-caption="Iron sword in an old version"', 'data-caption="Iron sword before the Mistlands"');
    const second = await ingest(wiki.fetchImpl);

    const after = (await getArticleBySlug(handle.db, 'iron-sword'))!;
    expect(after.doc.images.map((i) => i.caption)).toContain('Iron sword before the Mistlands');
    expect(after.doc.blocks).toEqual(article.doc.blocks);
    expect(second.articlesChanged).toBe(1);
    expect((await getTranslation(handle.db, article.pageKey, 'es'))!.stale).toBe(true);
  });

  it('keeps the translation fresh when only an image’s alt text changed', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    const article = (await getArticleBySlug(handle.db, 'iron-sword'))!;

    wiki.state.pages[0]!.revid = 101;
    wiki.state.pages[0]!.edit = (html) =>
      html.replaceAll('alt="Iron sword in an old version"', 'alt="An iron sword from 2018"');
    const second = await ingest(wiki.fetchImpl);

    const after = (await getArticleBySlug(handle.db, 'iron-sword'))!;
    expect(after.doc.images.map((i) => i.alt)).toContain('An iron sword from 2018');
    expect(second.articlesChanged).toBe(0);
    expect(after.updatedAt.getTime()).toBe(article.updatedAt.getTime());
  });

  it('updates what is never translated without marking the translation stale', async () => {
    // Categories, images and facets are not part of a translation.
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    const before = await translateIron();

    wiki.state.pages[2]!.revid = 301;
    wiki.state.pages[2]!.categories = ['Materials', 'Ores'];
    const second = await ingest(wiki.fetchImpl);

    expect(second.articlesChanged).toBe(0);
    const after = (await getArticleBySlug(handle.db, 'iron'))!;
    expect(after.categories).toEqual(['Materials', 'Ores']);
    expect((await getTranslation(handle.db, before.pageKey, 'es'))!.stale).toBe(false);
  });
});

describe('runIngest — recipes and the recipe graph', () => {
  const ingest = (fetchImpl: FetchLike, overrides = {}) =>
    runIngest({
      db: handle.db,
      client: new MediaWikiClient({ contact: 'test@example.com', fetchImpl, sleep: async () => {} }),
      embedFn: fakeEmbedMany,
      runId: `run-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    });

  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  /** Every page's stored recipes: by which extractor, from which revision, and when they last changed. */
  const recipeRows = async () =>
    (
      await rawQuery<{ title: string; recipes_version: number; revid: number; updated_at: string }>(
        handle.db,
        sql`SELECT p.title, r.recipes_version, r.revid, r.updated_at::text AS updated_at
            FROM page_recipes r JOIN pages p ON p.key = r.page_key ORDER BY p.title`,
      )
    ).map((r) => ({ ...r, recipes_version: Number(r.recipes_version), revid: Number(r.revid) }));

  const count = async (table: 'recipe_graph' | 'articles' | 'chunks') =>
    Number((await rawQuery<{ n: string }>(handle.db, sql`SELECT count(*)::text AS n FROM ${sql.raw(table)}`))[0]!.n);

  /** The graph readers are served. */
  const served = async (): Promise<RecipeGraph | null> => (await getLatestRecipeGraph(handle.db))?.graph ?? null;

  /** The steps of an item the maths plans with, in quality order. */
  const steps = (graph: RecipeGraph, id: string) => graph.recipes.filter((r) => r.product === id && !r.alt);

  /** The Iron Sword's first step taking 5 Wood instead of 2: an edit to its recipe upstream. */
  const moreWood = (html: string) =>
    html.replace('<a href="/wiki/Wood" title="Wood">Wood</a> x2', '<a href="/wiki/Wood" title="Wood">Wood</a> x5');

  /** What the run said it read recipes for, and why. */
  const recipePlans = (events: ProgressEvent[]) =>
    events.flatMap((e) => (e.type === 'recipes-planned' ? [e.reasons] : []));

  it("stores every page's recipes from the fetch that builds its article, and assembles one graph", async () => {
    const wiki = fakeWiki(PAGES);
    const result = await ingest(wiki.fetchImpl);

    // One request per page: the recipes come from the same HTML as the article.
    expect(wiki.state.parseCalls).toBe(3);
    expect(result.recipesExtracted).toBe(3);
    expect((await recipeRows()).map((r) => [r.title, r.recipes_version, r.revid])).toEqual([
      ['Bonemass', RECIPES_VERSION, 200],
      ['Iron', RECIPES_VERSION, 300],
      ['Iron Sword', RECIPES_VERSION, 100],
    ]);

    expect(await count('recipe_graph')).toBe(1);
    const graph = (await served())!;
    expect(result.graph?.version).toBe(graph.version);
    expect(result.graph?.report).toMatchObject({ items: graph.items.length, recipes: graph.recipes.length });
    expect(steps(graph, 'SwordIron').map((r) => [r.quality, r.stationLevel, r.inputs.map(([, qty]) => qty)])).toEqual([
      [1, 2, [2, 20, 3]],
      [2, 3, [1, 10, 2]],
      [3, 4, [2, 20, 4]],
      [4, 5, [3, 30, 6]],
    ]);
    expect(await isRecipeGraphBehind(handle.db)).toBe(false);
  });

  it('reads no recipes and assembles no graph when nothing changed', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    const recipes = await recipeRows();
    const asked = wiki.state.redirectCalls;

    const second = await ingest(wiki.fetchImpl);

    expect(second.recipesExtracted).toBe(0);
    expect(second.graph).toBeNull();
    expect(wiki.state.parseCalls).toBe(3);
    expect(wiki.state.redirectCalls).toBe(asked);
    expect(await recipeRows()).toEqual(recipes);
    expect(await count('recipe_graph')).toBe(1);
  });

  it("reads every page's recipes again for a new extractor, and leaves the articles and their translations alone", async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl, { recipesVersion: 1 });
    const iron = (await getArticleBySlug(handle.db, 'iron'))!;
    await saveTranslation(handle.db, {
      pageKey: iron.pageKey,
      lang: 'es',
      title: 'Hierro (Iron)',
      doc: iron.doc,
      model: 'test-model',
      sourceUpdatedAt: iron.updatedAt,
    });

    const events: ProgressEvent[] = [];
    const second = await ingest(wiki.fetchImpl, { recipesVersion: 2, onProgress: (e: ProgressEvent) => events.push(e) });

    expect(second.pagesChanged).toBe(0);
    expect(second.articlesChanged).toBe(0);
    expect(second.recipesExtracted).toBe(3);
    expect(wiki.state.parseCalls).toBe(6);
    expect(recipePlans(events)).toEqual([{ missing: 0, extractor: 3, revised: 0, forced: 0 }]);
    expect((await recipeRows()).map((r) => r.recipes_version)).toEqual([2, 2, 2]);
    expect((await getArticleBySlug(handle.db, 'iron'))!.updatedAt.getTime()).toBe(iron.updatedAt.getTime());
    expect((await getTranslation(handle.db, iron.pageKey, 'es'))!.stale).toBe(false);
    // The same recipes make the same graph, stored again as the newest.
    expect(second.graph?.version).toBe((await served())!.version);
    expect(await count('recipe_graph')).toBe(1);
  });

  it('reads recipes only: a fresh index gets its recipes and a graph, and no article, chunk or vector', async () => {
    const wiki = fakeWiki(PAGES);
    const embed = vi.fn(fakeEmbedMany);
    const events: ProgressEvent[] = [];
    const result = await ingest(wiki.fetchImpl, {
      recipesOnly: true,
      embedFn: embed,
      onProgress: (e: ProgressEvent) => events.push(e),
    });

    expect(result.recipesExtracted).toBe(3);
    expect(result.pagesChanged).toBe(0);
    expect(result.graph?.version).toBe((await served())!.version);
    expect(recipePlans(events)).toEqual([{ missing: 3, extractor: 0, revised: 0, forced: 0 }]);
    expect(embed).not.toHaveBeenCalled();
    expect(await getSetting(handle.db, EMBEDDING_PROVIDER_KEY)).toBeNull();
    expect(await count('articles')).toBe(0);
    expect(await count('chunks')).toBe(0);
    // Each page is stored unfinished, so the next ordinary run derives its article.
    const revids = await rawQuery<{ revid: number }>(handle.db, sql`SELECT revid FROM pages`);
    expect(revids.map((r) => Number(r.revid))).toEqual([UNFINISHED, UNFINISHED, UNFINISHED]);

    const plans: ProgressEvent[] = [];
    const next = await ingest(wiki.fetchImpl, { onProgress: (e: ProgressEvent) => e.type === 'planned' && plans.push(e) });
    expect(plans[0]?.type === 'planned' && plans[0].reasons.added).toBe(3);
    expect(next.pagesChanged).toBe(3);
    expect(await getArticleBySlug(handle.db, 'iron-sword')).not.toBeNull();
    expect(next.graph?.version).toBe(result.graph?.version);
  });

  it('reads recipes only on a stored index: the revised recipe reaches the graph, and its article waits for an ordinary run', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    const article = (await getArticleBySlug(handle.db, 'iron-sword'))!;
    const parses = wiki.state.parseCalls;

    wiki.state.pages[0]!.revid = 101;
    wiki.state.pages[0]!.edit = moreWood;
    const events: ProgressEvent[] = [];
    const result = await ingest(wiki.fetchImpl, { recipesOnly: true, onProgress: (e: ProgressEvent) => events.push(e) });

    expect(wiki.state.parseCalls).toBe(parses + 1);
    expect(recipePlans(events)).toEqual([{ missing: 0, extractor: 0, revised: 1, forced: 0 }]);
    expect(result.recipesExtracted).toBe(1);
    expect(steps((await served())!, 'SwordIron')[0]!.inputs[0]![1]).toBe(5);
    expect((await getArticleBySlug(handle.db, 'iron-sword'))!.updatedAt.getTime()).toBe(article.updatedAt.getTime());

    const next = await ingest(wiki.fetchImpl);
    expect(next.pagesChanged).toBe(1);
    expect(next.articlesChanged).toBe(1);
  });

  it('assembles the graph again on every recipes-only run, so an edit to the overrides reaches it', async () => {
    const wiki = fakeWiki(PAGES);
    const first = await ingest(wiki.fetchImpl);

    const again = await ingest(wiki.fetchImpl, { recipesOnly: true });

    expect(again.recipesExtracted).toBe(0);
    expect(wiki.state.parseCalls).toBe(3);
    expect(again.graph?.version).toBe(first.graph?.version);

    // And with `full`, every page's recipes are read again first.
    const events: ProgressEvent[] = [];
    const forced = await ingest(wiki.fetchImpl, { recipesOnly: true, full: true, onProgress: (e: ProgressEvent) => events.push(e) });
    expect(recipePlans(events)).toEqual([{ missing: 0, extractor: 0, revised: 0, forced: 3 }]);
    expect(forced.recipesExtracted).toBe(3);
    expect(forced.pagesChanged).toBe(0);
  });

  it('refuses a recipes-only run asked to rebuild articles or vectors, before writing anything', async () => {
    const wiki = fakeWiki(PAGES);
    for (const asked of [{ reparse: true }, { reembed: true }, { switchProvider: 'injected' }]) {
      await expect(ingest(wiki.fetchImpl, { recipesOnly: true, ...asked })).rejects.toBeInstanceOf(IngestConfigError);
    }
    expect(wiki.state.parseCalls).toBe(0);
    expect(await rawQuery(handle.db, sql`SELECT 1 FROM ingest_runs`)).toHaveLength(0);
  });

  it('records a failed assembly and still ends an otherwise good run ok; the next run assembles it', async () => {
    const wiki = fakeWiki(PAGES);
    const readOnly: FetchLike = async (url, init) =>
      new URL(url).searchParams.get('redirects') === '1'
        ? json({ error: { code: 'readonly', info: 'The wiki is currently in read-only mode.' } })
        : wiki.fetchImpl(url, init);

    const broken = await ingest(readOnly, { runId: 'run-broken-graph' });

    expect(broken.graph).toBeNull();
    expect(broken.errors).toEqual([{ title: '(recipe graph)', message: expect.stringContaining('read-only') }]);
    const [run] = await rawQuery<{ status: string }>(handle.db, sql`SELECT status FROM ingest_runs WHERE id = 'run-broken-graph'`);
    expect(run?.status).toBe('ok');
    expect(await count('recipe_graph')).toBe(0);
    expect(await getArticleBySlug(handle.db, 'iron-sword')).not.toBeNull();

    // Nothing new on the wiki, but the graph is still behind its recipes.
    const next = await ingest(wiki.fetchImpl);
    expect(next.recipesExtracted).toBe(0);
    expect(next.graph).not.toBeNull();
    expect(await count('recipe_graph')).toBe(1);
  });

  it("never assembles a graph without a listed page's recipes", async () => {
    // A graph missing a page would offer a breakdown that stops at an item it
    // could have made, as if the item were found rather than made.
    const wiki = fakeWiki(PAGES);
    const flaky: FetchLike = async (url, init) => {
      const params = new URL(url).searchParams;
      if (params.get('action') === 'parse' && params.get('pageid') === '2') return new Response('boom', { status: 500 });
      return wiki.fetchImpl(url, init);
    };
    const events: ProgressEvent[] = [];
    const first = await ingest(flaky, { onProgress: (e: ProgressEvent) => events.push(e) });

    expect(first.errors.map((e) => e.title)).toEqual(['Bonemass']);
    expect(first.graph).toBeNull();
    expect(events).toContainEqual({ type: 'graph-skipped', reason: expect.stringMatching(/Bonemass.*the next run reads them/) });
    expect(await count('recipe_graph')).toBe(0);

    const next = await ingest(wiki.fetchImpl);
    expect(next.recipesExtracted).toBe(1);
    expect(next.graph).not.toBeNull();
  });

  it('reads no more pages than the limit, recipes included, and assembles no graph from part of the wiki', async () => {
    const wiki = fakeWiki(PAGES);
    const events: ProgressEvent[] = [];
    const limited = await ingest(wiki.fetchImpl, { limit: 1, onProgress: (e: ProgressEvent) => events.push(e) });
    expect(wiki.state.parseCalls).toBe(1);
    expect(limited.graph).toBeNull();
    // Another run with a limit would read no more of them than this one did.
    expect(events).toContainEqual({ type: 'graph-skipped', reason: expect.stringContaining('a run without a limit reads them') });

    await ingest(wiki.fetchImpl, { recipesOnly: true, limit: 1 });
    expect(wiki.state.parseCalls).toBe(2);
    expect(await count('recipe_graph')).toBe(0);
  });

  it('keeps the graph readers have when a run stops partway, and the next run assembles the whole wiki', async () => {
    const wiki = fakeWiki(PAGES);
    await ingest(wiki.fetchImpl);
    const before = (await served())!;

    // Every page revised, the Iron Sword's recipe among them; the network
    // goes down after the first page, before the graph is assembled.
    for (const page of wiki.state.pages) page.revid += 1;
    wiki.state.pages[0]!.edit = moreWood;
    let parses = 0;
    const down: FetchLike = async (url, init) => {
      const params = new URL(url).searchParams;
      if ((params.get('action') === 'parse' && ++parses > 1) || params.get('redirects') === '1') {
        throw new TypeError('fetch failed');
      }
      return wiki.fetchImpl(url, init);
    };
    const stopped = await ingest(down, { concurrency: 1 });

    expect(stopped.errors.map((e) => e.title)).toEqual(['Bonemass', 'Iron', '(recipe graph)']);
    expect((await served())!.version).toBe(before.version);
    expect(await isRecipeGraphBehind(handle.db)).toBe(true);

    const next = await ingest(wiki.fetchImpl);
    expect(next.errors).toEqual([]);
    const after = (await served())!;
    expect(after.version).toBe(next.graph?.version);
    expect(steps(after, 'SwordIron')[0]!.inputs[0]![1]).toBe(5);
    expect(await isRecipeGraphBehind(handle.db)).toBe(false);

    // The very graph an uninterrupted ingest of the same wiki assembles.
    const clean = await createTestDb();
    try {
      const fresh = await runIngest({
        db: clean.db,
        client: new MediaWikiClient({ contact: 'test@example.com', fetchImpl: wiki.fetchImpl, sleep: async () => {} }),
        embedFn: fakeEmbedMany,
      });
      expect(fresh.graph?.version).toBe(after.version);
    } finally {
      await clean.close();
    }
  });
});

describe('recipeStaleness', () => {
  const state = { recipesVersion: 2, revid: 10 };

  it("reads a page's recipes again when they are missing, read by another extractor or from another revision", () => {
    expect(recipeStaleness(undefined, 10, { recipesVersion: 2, full: false })).toBe('missing');
    expect(recipeStaleness({ ...state, recipesVersion: 1 }, 10, { recipesVersion: 2, full: false })).toBe('extractor');
    // A rollback reads them again too: the running extractor is the one that must have read them.
    expect(recipeStaleness({ ...state, recipesVersion: 3 }, 10, { recipesVersion: 2, full: false })).toBe('extractor');
    expect(recipeStaleness(state, 11, { recipesVersion: 2, full: false })).toBe('revised');
    expect(recipeStaleness(state, undefined, { recipesVersion: 2, full: false })).toBe('revised');
    expect(recipeStaleness(state, 10, { recipesVersion: 2, full: true })).toBe('forced');
  });

  it('leaves recipes alone that the running extractor read from the live revision', () => {
    expect(recipeStaleness(state, 10, { recipesVersion: 2, full: false })).toBeNull();
  });
});

describe('staleness', () => {
  const stored = { key: 'fandom:1', revid: 10, parserVersion: 3 };
  const current = { full: false, reparse: true, parserVersion: 3 };

  it('re-derives a page that is new, revised, unfinished or built by another parser', () => {
    expect(staleness(undefined, 10, current)).toBe('added');
    expect(staleness({ ...stored, parserVersion: NO_ARTICLE }, 10, current)).toBe('added');
    expect(staleness(stored, 11, current)).toBe('revised');
    // Whatever the live revision, and without a revision lookup.
    expect(staleness({ ...stored, revid: UNFINISHED }, undefined, { ...current, reparse: false })).toBe('unfinished');
    expect(staleness(stored, undefined, current)).toBe('revised');
    expect(staleness({ ...stored, parserVersion: 2 }, 10, current)).toBe('parser');
    // A rollback rebuilds too: the running parser is the one that must have built it.
    expect(staleness({ ...stored, parserVersion: 4 }, 10, current)).toBe('parser');
    expect(staleness(stored, 10, { ...current, full: true })).toBe('forced');
  });

  it('leaves what an older parser built to its revision unless asked to reparse', () => {
    const older = { ...stored, parserVersion: 2 };
    const incremental = { ...current, reparse: false };
    expect(staleness(older, 10, incremental)).toBeNull();
    expect(staleness(older, 11, incremental)).toBe('revised');
    expect(staleness({ ...stored, parserVersion: NO_ARTICLE }, 10, incremental)).toBe('added');
  });

  it('leaves a page alone when nothing about it changed', () => {
    expect(staleness(stored, 10, current)).toBeNull();
  });
});
