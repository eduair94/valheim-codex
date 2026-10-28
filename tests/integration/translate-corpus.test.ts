import { sql } from 'drizzle-orm';
import { APICallError } from 'ai';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCircuits } from '@/lib/rag/circuit';
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
  resetCircuits();
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
  tpm: 0,
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

/** A clock that only moves when the run waits on it, so a minute's wait costs a test nothing. */
function fakeClock() {
  let time = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
    waits,
  };
}

function refused(status: number, message: string): APICallError {
  return new APICallError({
    message,
    url: 'https://provider.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: status,
    isRetryable: false,
  });
}

/** Groq's refusal, per minute or per day, as it worded it in production. */
const groqLimit = (per: 'minute' | 'day', wait: string) =>
  refused(
    429,
    'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_test` service tier `on_demand` on ' +
      `tokens per ${per} (${per === 'day' ? 'TPD' : 'TPM'}): Limit 8000, Used 7742, Requested 1963. ` +
      `Please try again in ${wait}.`,
  );

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

  it('stops after two articles no provider answers, a minute between requests, holding nothing against their strings (IT-2)', async () => {
    for (const slug of ['down-1', 'down-2', 'down-3']) await seed(slug, [`Sentence of ${slug}.`]);
    const mock = mockTranslator(() => unavailable(503));
    const clock = fakeClock();
    const result = await run(mock, { translate: { candidates: mock.candidates, now: clock.now, sleep: clock.sleep } });

    expect(result.stopped).toEqual({ slug: 'down-2', reason: 'unavailable' });
    // The first article's request, asked again a minute later; then the
    // second's, a minute after that — still the outage, so it ends at once.
    const first = ['down-1', 'Sentence of down-1.'];
    const second = ['down-2', 'Sentence of down-2.'];
    expect(mock.calls).toEqual([first, first, second]);
    expect(clock.waits).toEqual([60_000, 60_000]);
    const failures = await rawQuery<{ failures: Record<string, number> }>(
      handle.db,
      sql`SELECT failures FROM article_translation_memory`,
    );
    expect(failures.map((row) => row.failures)).toEqual([{}, {}]);
    const log = lines.join('\n');
    expect(log).toContain('sin respuesta de ningún proveedor');
    expect(log).toContain('— ningún proveedor respondió');
    expect(log).not.toContain('límite');
  });

  it('stops at the first article every provider refuses for the day, and says the budget is spent', async () => {
    for (const slug of ['spent-1', 'spent-2']) await seed(slug, [`Sentence of ${slug}.`]);
    const groq = mockTranslator(() => groqLimit('day', '12m37.248s'), 'groq/openai/gpt-oss-120b');
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const clock = fakeClock();
    const result = await run(groq, {
      translate: { candidates: () => [groq.candidate, broke.candidate], now: clock.now, sleep: clock.sleep },
    });

    expect(result.stopped).toEqual({ slug: 'spent-1', reason: 'exhausted' });
    expect(groq.calls).toHaveLength(1);
    expect(clock.waits).toEqual([]);
    expect(lines.join('\n')).toContain('ningún proveedor tenía presupuesto');
  });

  it('waits out Groq’s per-minute limit and goes on, where the run of 2026-10-28 stopped', async () => {
    for (const slug of ['meadows', 'mountain']) await seed(slug, [`Sentence of ${slug}.`, `Another of ${slug}.`]);
    // Groq refuses the second article's first request, once, as it did in production.
    const groq = mockTranslator(
      (strings, call) => (call === 1 ? groqLimit('minute', '510ms') : es(strings)),
      'groq/openai/gpt-oss-120b',
    );
    const broke = mockTranslator(() => refusal(402), 'openrouter/x-ai/grok-4.3');
    const clock = fakeClock();
    const result = await run(groq, {
      slugs: ['meadows', 'mountain'],
      translate: { candidates: () => [groq.candidate, broke.candidate], now: clock.now, sleep: clock.sleep },
    });

    expect(result).toMatchObject({ stopped: null, articles: 2, strings: 6 });
    expect(clock.waits).toEqual([510]);
    expect(broke.calls).toHaveLength(0);
    expect((await shown('mountain'))?.title).toBe('ES:mountain');
    // One request each, three calls to Groq: the refused one counts. Twenty
    // tokens a reply, as the mock reports them.
    expect(result).toMatchObject({ requests: 2, calls: 3, tokens: 40 });
    expect(lines.at(-1)).toBe('\nTraducidos 6 cadenas en 2 artículos, con 2 pedidos (3 llamadas a proveedores, 40 tokens).');
  });

  it('stops as rate-limited, not as spent nor as silence, when a rate limit outlasts every wait', async () => {
    for (const slug of ['limited-1', 'limited-2', 'limited-3']) await seed(slug, [`Sentence of ${slug}.`]);
    const mock = mockTranslator(() => refusal(429));
    const clock = fakeClock();
    const result = await run(mock, { translate: { candidates: mock.candidates, now: clock.now, sleep: clock.sleep } });

    expect(result.stopped).toEqual({ slug: 'limited-2', reason: 'rate-limited' });
    expect(mock.calls).toHaveLength(3);
    expect(clock.waits).toEqual([60_000, 60_000]);
    const log = lines.join('\n');
    expect(log).not.toContain('presupuesto');
    expect(log).not.toContain('ningún proveedor respondió');
    expect(log).toContain('— límite por minuto, aun tras esperar');
    expect(log).toContain('siguieron limitando por minuto');
  });

  it('halves a batch too large for the minute, and asks a refused half again after the wait', async () => {
    for (const slug of ['large-1', 'large-2']) await seed(slug, [`First of ${slug}.`, `Second of ${slug}.`, `Third of ${slug}.`]);
    // Each article's batch is too large for Groq's minute; each half is then refused once, with a wait.
    const refusedOnce = new Set<string>();
    const groq = mockTranslator((strings) => {
      if (strings.length > 2) {
        return refused(
          413,
          'Request too large for model `openai/gpt-oss-120b` in organization `org_test` service tier `on_demand` on ' +
            'tokens per minute (TPM): Limit 8000, Requested 9311, please reduce your message size and try again.',
        );
      }
      if (refusedOnce.has(strings[0]!)) return es(strings);
      refusedOnce.add(strings[0]!);
      return groqLimit('minute', '45s');
    }, 'groq/openai/gpt-oss-120b');
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const clock = fakeClock();
    const result = await run(groq, {
      slugs: ['large-1', 'large-2'],
      translate: { candidates: () => [groq.candidate, broke.candidate], now: clock.now, sleep: clock.sleep },
    });

    expect(result).toMatchObject({ stopped: null, articles: 2, strings: 8 });
    // Every refused half asked again after a minute's wait.
    expect(clock.waits).toEqual([60_000, 60_000, 60_000, 60_000]);
    expect((await shown('large-2'))?.title).toBe('ES:large-2');
  });

  it('keeps --rpm between articles too, not only inside one', async () => {
    for (const slug of ['paced-1', 'paced-2', 'paced-3']) await seed(slug, [`Sentence of ${slug}.`]);
    const mock = mockTranslator();
    const clock = fakeClock();
    await run(mock, { rpm: 6, translate: { candidates: mock.candidates, now: clock.now, sleep: clock.sleep } });

    expect(mock.calls).toHaveLength(3);
    // Ten seconds apart, the first request of each article included.
    expect(clock.waits).toEqual([10_000, 10_000]);
  });

  it('paces a run by the tokens its requests use, leaving the rest of each minute to the chat', async () => {
    for (const slug of ['tokens-1', 'tokens-2', 'tokens-3']) await seed(slug, [`Sentence of ${slug}.`]);
    const mock = mockTranslator();
    const clock = fakeClock();
    // Twenty tokens a request, at 1,200 a minute: a second each, across articles.
    const result = await run(mock, { tpm: 1_200, translate: { candidates: mock.candidates, now: clock.now, sleep: clock.sleep } });

    expect(mock.calls).toHaveLength(3);
    expect(clock.waits).toEqual([1_000, 1_000]);
    expect(result.tokens).toBe(60);
    expect(lines.some((line) => line.startsWith('   1. tokens-1') && line.includes('2 cadenas, 20 tokens'))).toBe(true);
  });

  it.each([4, 400])(
    'goes on past a round whose last request nobody answered, once its wait is over (--chunk %i)',
    async (chunk) => {
      // Nine strings, batches of four. The first batch runs out of time, its
      // first half is answered, and its second half, long, runs out of time
      // too with no halving left: one request unanswered. With rounds of one
      // batch that ended the round, and, taken for providers that stopped
      // answering, the article.
      const long = (n: number) => `Paragraph ${n}. ${'The Mistlands is a biome shrouded in thick fog, home to Seekers. '.repeat(17)}`;
      await seed('lore', Array.from({ length: 8 }, (_, i) => long(i)));
      const groq = mockTranslator(
        (strings, call, signal) =>
          call === 0 || call === 2
            ? new Promise<string[]>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
            : es(strings),
        'groq/openai/gpt-oss-120b',
      );
      const clock = fakeClock();
      const result = await run(groq, {
        batchSize: 4,
        chunk,
        translate: { candidates: groq.candidates, now: clock.now, sleep: clock.sleep, requestTimeoutMs: 50 },
      });

      // The next request asked after the wait that half set, whatever the round size.
      expect(groq.calls.map((c) => c.length)).toEqual([4, 2, 2, 4, 1]);
      expect(clock.waits).toEqual([60_000, 60_000]);
      expect(result).toMatchObject({ stopped: null, articles: 1, strings: 7 });
      expect((await loadTranslationJob(handle.db, 'lore', 'es'))?.memory?.size).toBe(7);
    },
  );

  it.each([2, 400])(
    'ends an article on a bad reply that met a busy minute twice, as rate-limited, whatever the round size (--chunk %i)',
    async (chunk) => {
      // Groq's reply fails its check, the retry meets a limit too long to sit
      // out, and so does the same request a minute later: two requests in a
      // row unanswered, the second after the wait. The bad reply was paid for
      // and is no answer.
      await seed('article', ['First sentence.', 'Second sentence.', 'Third sentence.']);
      const groq = mockTranslator(
        (strings, call) =>
          call === 0
            ? refused(400, "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.")
            : call <= 2
              ? groqLimit('minute', '56s')
              : es(strings),
        'groq/openai/gpt-oss-120b',
      );
      const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
      const clock = fakeClock();
      const result = await run(groq, {
        batchSize: 2,
        chunk,
        translate: { candidates: () => [groq.candidate, broke.candidate], now: clock.now, sleep: clock.sleep },
      });

      expect(groq.calls).toHaveLength(3);
      expect(clock.waits).toEqual([60_000]);
      expect(result).toMatchObject({ stopped: null, articles: 0, strings: 0 });
      expect(lines.some((line) => line.includes('— límite por minuto, aun tras esperar'))).toBe(true);
    },
  );

  it('stops as rate-limited, not as answers that are no use, when every bad reply meets a minute too busy to wait out', async () => {
    // Each batch: Groq's reply fails its check, the retry meets a limit too
    // long to sit out, and so does the same request a minute later. Every
    // reply was paid for, and none was an answer: scored as answers that are
    // no use, three such articles stopped the run telling the operator to
    // check the model.
    for (const slug of ['busy-a', 'busy-b', 'busy-c', 'busy-d']) {
      await seed(slug, [`One of ${slug}.`, `Two of ${slug}.`, `Three of ${slug}.`, `Four of ${slug}.`]);
    }
    const seen = new Map<string, number>();
    const groq = mockTranslator((strings) => {
      const asked = seen.get(strings[0]!) ?? 0;
      seen.set(strings[0]!, asked + 1);
      if (asked === 0) return refused(400, "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.");
      return asked <= 2 ? groqLimit('minute', '56s') : es(strings);
    }, 'groq/openai/gpt-oss-120b');
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const clock = fakeClock();
    const result = await run(groq, {
      batchSize: 2,
      chunk: 2,
      slugs: ['busy-a', 'busy-b', 'busy-c', 'busy-d'],
      translate: { candidates: () => [groq.candidate, broke.candidate], now: clock.now, sleep: clock.sleep },
    });

    // busy-a: the request and its re-ask a minute later, both refused. busy-b:
    // its first request a minute after that, refused too, and the run stops.
    expect(result.stopped).toEqual({ slug: 'busy-b', reason: 'rate-limited' });
    expect(groq.calls.map((c) => c[0])).toEqual(['busy-a', 'busy-a', 'busy-a', 'busy-b', 'busy-b']);
    expect(clock.waits).toEqual([60_000, 60_000]);
    const log = lines.join('\n');
    expect(lines.filter((line) => line.includes('— límite por minuto, aun tras esperar'))).toHaveLength(2);
    expect(log).toContain('siguieron limitando por minuto');
    expect(log).not.toContain('nada de lo que devuelven sirve');
  });

  it('saves every round of requests, so a run that dies costs only the one in flight', async () => {
    await seed('long', ['One sentence.', 'Two sentences.', 'Three sentences.']);
    // What the memory holds when each request goes out.
    const saved: number[] = [];
    const mock = mockTranslator(async (strings) => {
      const rows = await rawQuery<{ entries: Record<string, string> }>(
        handle.db,
        sql`SELECT entries FROM article_translation_memory`,
      );
      saved.push(Object.keys(rows[0]?.entries ?? {}).length);
      return es(strings);
    });
    await run(mock, { batchSize: 2, chunk: 2 });

    expect(mock.calls.map((c) => c.length)).toEqual([2, 2]);
    expect(saved).toEqual([0, 2]);
  });
});
