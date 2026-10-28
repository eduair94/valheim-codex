import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rawQuery, type DbHandle } from '@/lib/db/create-db';
import { upsertArticle } from '@/lib/db/wiki-repo';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import { applyMemory, extractStrings } from '@/lib/wiki/translate';
import { acquireLease, loadTranslationJob, resetMemoryTableState, saveTranslationWork } from '@/lib/wiki/translate-store';
import type * as Provider from '@/lib/rag/provider';
import { translateQueue, type QueueRun } from '../../scripts/translate-queue';
import { createTestDb } from '../helpers/db';
import { mockTranslator, refusal, unavailable } from '../helpers/mock-translator';

// Every run here carries its own mock chain; one that forgets gets a chain
// that cannot answer, never the real one.
vi.mock('@/lib/rag/provider', async (original) => ({
  ...(await original<typeof Provider>()),
  rewriteCandidates: () => {
    throw new Error('a test reached the real model chain');
  },
}));

/**
 * The queue run of `pnpm translate:es`, against a real (in-memory) Postgres
 * and a mock model: when it goes on, when it stops, and what it says about
 * why.
 */

let handle: DbHandle;
let pageId = 1;
let lines: string[] = [];

beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  await handle?.close();
});
beforeEach(async () => {
  resetMemoryTableState();
  lines = [];
  await handle.db.execute(sql`TRUNCATE pages CASCADE`);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function paragraphs(texts: string[]): ArticleDoc {
  return {
    lead: '',
    blocks: texts.map((text) => ({ kind: 'paragraph' as const, section: '', text })),
    infobox: null,
    images: [],
    facets: {},
  };
}

async function seed(slug: string, texts: string[]): Promise<string> {
  const key = `fandom:${pageId}`;
  await handle.db.execute(sql`
    INSERT INTO pages (key, source, page_id, title, url, revid)
    VALUES (${key}, 'fandom', ${pageId}, ${slug}, ${`https://example.test/${slug}`}, 1)
  `);
  pageId += 1;
  await upsertArticle(handle.db, {
    pageKey: key,
    source: 'fandom',
    title: slug,
    slug,
    url: `https://example.test/${slug}`,
    categories: [],
    doc: paragraphs(texts),
  });
  return key;
}

/** A translation that is shown, with everything translated but `stuck`, which has failed before. */
async function seedStuck(slug: string, texts: string[], stuck: string): Promise<void> {
  const key = await seed(slug, texts);
  const job = (await loadTranslationJob(handle.db, slug, 'es'))!;
  const done = extractStrings(job.doc, job.title).strings.filter((s) => s !== stuck);
  const applied = applyMemory(job.doc, job.title, new Map(done.map((s) => [s, `ES:${s}`])));
  const lease = await acquireLease(handle.db, { pageKey: key, lang: 'es', holder: 'test' });
  if (lease.kind !== 'acquired') throw new Error(`expected the lease, got ${lease.kind}`);
  await saveTranslationWork(handle.db, {
    pageKey: key,
    lang: 'es',
    lease: 'test',
    release: true,
    memory: applied.memory,
    failures: new Map([[stuck, 1]]),
    pending: applied.pending,
    publish: { title: applied.title, doc: applied.doc, model: 'test', version: job.version },
  });
}

const RUN: QueueRun = {
  lang: 'es',
  limit: Number.POSITIVE_INFINITY,
  maxStrings: Number.POSITIVE_INFINITY,
  chunk: 400,
  batchSize: 40,
  rpm: 0,
  concurrency: 1,
  order: 'smallest',
  slugs: null,
  dryRun: false,
};

const run = (mock: ReturnType<typeof mockTranslator>, extra: Partial<QueueRun> = {}) =>
  translateQueue(handle.db, {
    ...RUN,
    translate: { candidates: mock.candidates },
    log: (line) => lines.push(line),
    ...extra,
  });

const shown = async (slug: string) => (await loadTranslationJob(handle.db, slug, 'es'))?.published ?? null;

const es = (strings: string[]) => strings.map((s) => `ES:${s}`);

/** A reply with one entry too many, for any batch that carries a culprit: never usable. */
const choke = (strings: string[]) => (strings.some((s) => s.startsWith('Culprit')) ? [...es(strings), 'one too many'] : es(strings));

describe('translateQueue (pnpm translate:es)', () => {
  it('gets past articles with only old failures left, to the work behind them (IT-1)', async () => {
    // Three articles whose last string no model returns usably, met first —
    // as smallest-first used to put them, once everything around them was done.
    await seedStuck('stuck-a', ['Alpha.', 'Culprit one.'], 'Culprit one.');
    await seedStuck('stuck-b', ['Beta.', 'Culprit two.'], 'Culprit two.');
    await seedStuck('stuck-c', ['Gamma.', 'Culprit three.'], 'Culprit three.');
    await seed('fresh', ['Fresh one.', 'Fresh two.']);

    const mock = mockTranslator(choke);
    const result = await run(mock, { slugs: ['stuck-a', 'stuck-b', 'stuck-c', 'fresh'] });

    expect(result.stopped).toBeNull();
    expect(result.articles).toBe(1);
    expect((await shown('fresh'))?.title).toBe('ES:fresh');
    // Each still has its turn, once per run.
    expect(mock.calls.flat()).toEqual(expect.arrayContaining(['Culprit one.', 'Culprit two.', 'Culprit three.']));
    // Numbered by place in the run, not by articles translated so far.
    expect(lines.some((line) => line.startsWith('   4. fresh'))).toBe(true);
    expect(lines.join('\n')).not.toContain('presupuesto');
  });

  it('puts such articles last in its own queue, so fresh work gets the day’s first requests', async () => {
    await seedStuck('stuck-a', ['Alpha.', 'Culprit one.'], 'Culprit one.');
    await seed('fresh-but-larger', ['A fresh article, longer than any stuck one, waiting its turn. '.repeat(4)]);
    const mock = mockTranslator(choke);
    await run(mock);
    expect(mock.calls[0]).toContain('fresh-but-larger');
  });

  it('still stops after three articles in a row whose new strings come back unusable', async () => {
    for (const slug of ['idle-1', 'idle-2', 'idle-3', 'idle-4']) await seed(slug, [`Sentence of ${slug}.`]);
    // A model that answers every request, and always one entry too many.
    const mock = mockTranslator((strings) => [...es(strings), 'one too many']);
    const result = await run(mock);

    expect(result.stopped).toEqual({ slug: 'idle-3', reason: 'idle' });
    expect(mock.calls.flat()).not.toContain('idle-4');
    const log = lines.join('\n');
    expect(log).toContain('nada de lo que devuelven sirve');
    expect(log).not.toContain('presupuesto');
  });

  it('stops after two articles no provider answers, holding nothing against their strings (IT-2)', async () => {
    for (const slug of ['down-1', 'down-2', 'down-3']) await seed(slug, [`Sentence of ${slug}.`]);
    const mock = mockTranslator(() => unavailable(503));
    const result = await run(mock);

    expect(result.stopped).toEqual({ slug: 'down-2', reason: 'unavailable' });
    expect(mock.calls.flat()).not.toContain('down-3');
    const failures = await rawQuery<{ failures: Record<string, number> }>(
      handle.db,
      sql`SELECT failures FROM article_translation_memory`,
    );
    expect(failures.map((row) => row.failures)).toEqual([{}, {}]);
    expect(lines.join('\n')).toContain('sin respuesta de ningún proveedor');
  });

  it('stops at the first article every provider refuses, and says the budget is spent', async () => {
    for (const slug of ['spent-1', 'spent-2']) await seed(slug, [`Sentence of ${slug}.`]);
    const mock = mockTranslator(() => refusal(429));
    const result = await run(mock);

    expect(result.stopped).toEqual({ slug: 'spent-1', reason: 'exhausted' });
    expect(mock.calls).toHaveLength(1);
    expect(lines.join('\n')).toContain('ningún proveedor tenía presupuesto');
  });
});
