import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError, RetryError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import {
  applyMemory,
  applyStrings,
  captionsOf,
  createPacer,
  createSilence,
  deriveMemory,
  estimateTokens,
  extractStrings,
  isIdentifierRow,
  isPublishable,
  maxReplyTokens,
  mergeTranslations,
  overlayCaptions,
  planArticle,
  pruneFailures,
  translateArticle,
  translateStrings,
  worthTranslating,
  type Extraction,
} from '@/lib/wiki/translate';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import { canRequestTranslation, translationBuckets } from '@/lib/wiki/translate-policy';
import { isTripped, resetCircuits } from '@/lib/rag/circuit';
import type * as Provider from '@/lib/rag/provider';
import { garbage, mockTranslator, promptStrings, refusal, spanish, unavailable } from '../helpers/mock-translator';

// Every test passes its own mock chain. One that forgets gets a chain that
// cannot answer (the run ends as if every provider refused), never the real
// one — whose key may well be in the environment of whoever runs the tests.
vi.mock('@/lib/rag/provider', async (original) => ({
  ...(await original<typeof Provider>()),
  rewriteCandidates: () => {
    throw new Error('a test reached the real model chain');
  },
}));

/**
 * The translator hands a model a list of strings, never the document, so that
 * the shape of the page stays in this file's hands rather than the model's.
 * These tests are that guarantee: every string reachable, every string put
 * back where it came from, and nothing numeric sent at all.
 *
 * They need no model, which is the point — the failure they guard against is a
 * silently smaller article, and that has to be impossible by construction
 * rather than unlikely in practice.
 */

/**
 * A clock on which workers running at once interleave as they would in real
 * time: `sleep` parks a worker until its time comes, and `drive` lets every
 * worker run until all of them are parked, then moves time on to the
 * earliest wake-up. A clock that jumps forward whenever anyone sleeps lets a
 * worker parked for its turn overtake one still waiting on a provider.
 */
function eventClock(start = 1_000_000) {
  let time = start;
  let seq = 0;
  const timers: { at: number; seq: number; wake: () => void }[] = [];
  return {
    now: () => time,
    /** Milliseconds since the clock started. */
    elapsed: () => time - start,
    sleep: (ms: number) =>
      new Promise<void>((wake) => {
        timers.push({ at: time + Math.max(0, ms), seq: seq++, wake });
      }),
    async drive<T>(work: Promise<T>): Promise<T> {
      let settled = false;
      work.then(
        () => (settled = true),
        () => (settled = true),
      );
      for (let step = 0; step < 10_000; step++) {
        for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
        if (settled) return work;
        if (timers.length === 0) {
          // Only a real timer is pending: a provider's own deadline.
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers.shift()!;
        time = Math.max(time, next.at);
        next.wake();
      }
      throw new Error('the clock ran too many steps');
    },
  };
}

const doc: ArticleDoc = {
  lead: 'The iron sword is the second sword.',
  blocks: [
    { kind: 'paragraph', section: 'Usage', text: 'Primary attack is a 3-hit combo.' },
    { kind: 'list', section: 'Notes', ordered: false, items: ['Cannot be repaired in the field', '20'] },
    {
      kind: 'table',
      section: 'Upgrade information',
      caption: 'Crafting costs',
      headers: ['Level', 'Wood', 'Iron'],
      rows: [
        ['1', '2', '20'],
        ['2', '1', '10'],
      ],
    },
  ],
  infobox: {
    title: 'Iron Sword',
    image: { url: 'https://example.test/sword.png', alt: 'Iron Sword' },
    common: [
      {
        label: 'Properties',
        rows: [
          { label: 'Description', value: 'The straight line between life and death.' },
          { label: 'Internal ID', value: 'SwordIron' },
          { label: 'Weight', value: '1.0' },
        ],
      },
    ],
    tabs: [
      {
        label: '1',
        groups: [{ label: 'Stats', rows: [{ label: 'Durability', value: '200' }] }],
      },
    ],
  },
  images: [{ url: 'https://example.test/a.png', alt: 'screenshot' }],
  facets: { biome: 'Swamp' },
};

describe('what gets sent to the model', () => {
  it.each([
    ['20', false],
    ['1.0', false],
    ['35%', false],
    ['1.5', false],
    ['SwordIron', true],
    ['', false],
    ['   ', false],
    ['Iron Sword', true],
    ['The straight line between life and death.', true],
    ['Level', true],
  ])('%s -> translatable: %s', (value, expected) => {
    // `SwordIron` is translatable by shape and must not be translated in fact:
    // it reads as two English words, so it is the row's label that saves it.
    expect(worthTranslating(value)).toBe(expected);
  });

  it.each([
    ['Internal ID', true],
    ['ID', true],
    ['Prefab', true],
    ['Description', false],
    ['Weight', false],
  ])('label %s marks an identifier row: %s', (label, expected) => {
    expect(isIdentifierRow(label)).toBe(expected);
  });

  it('leaves numbers, IDs and image data out entirely', () => {
    const { strings } = extractStrings(doc, 'Iron Sword');

    // A crafting cost that comes back as "veinte" is worse than one in English.
    expect(strings).not.toContain('20');
    expect(strings).not.toContain('1.0');
    expect(strings).not.toContain('SwordIron');
    expect(strings.some((s) => s.includes('example.test'))).toBe(false);
  });

  it('reaches every piece of prose, including inside tables and tabs', () => {
    const { strings } = extractStrings(doc, 'Iron Sword');

    expect(strings).toContain('Iron Sword');
    expect(strings).toContain('The iron sword is the second sword.');
    expect(strings).toContain('Primary attack is a 3-hit combo.');
    expect(strings).toContain('Cannot be repaired in the field');
    expect(strings).toContain('Crafting costs');
    expect(strings).toContain('Level');
    expect(strings).toContain('Description');
    expect(strings).toContain('Durability');
  });
});

describe('putting the translation back', () => {
  /** Marks each string so a value landing in the wrong slot is visible. */
  function translateAll(extraction: Extraction): string[] {
    return extraction.strings.map((s) => `ES:${s}`);
  }

  it('puts every string back where it came from', () => {
    const extraction = extractStrings(doc, 'Iron Sword');
    const { doc: out, title } = applyStrings(doc, 'Iron Sword', extraction, translateAll(extraction));

    expect(title).toBe('ES:Iron Sword');
    expect(out.lead).toBe('ES:The iron sword is the second sword.');

    const table = out.blocks[2];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.caption).toBe('ES:Crafting costs');
    expect(table.headers).toEqual(['ES:Level', 'ES:Wood', 'ES:Iron']);

    expect(out.infobox?.common[0]?.rows[0]?.label).toBe('ES:Description');
    expect(out.infobox?.tabs[0]?.groups[0]?.rows[0]?.label).toBe('ES:Durability');
  });

  it('keeps the structure identical', () => {
    const extraction = extractStrings(doc, 'Iron Sword');
    const { doc: out } = applyStrings(doc, 'Iron Sword', extraction, translateAll(extraction));

    // The failure this guards against is a translation that renders fine and
    // is quietly missing a row the wiki had.
    expect(out.blocks).toHaveLength(doc.blocks.length);
    const before = doc.blocks[2];
    const after = out.blocks[2];
    if (before?.kind !== 'table' || after?.kind !== 'table') throw new Error('expected tables');
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.rows[0]).toHaveLength(before.rows[0]!.length);
    expect(out.infobox?.tabs).toHaveLength(doc.infobox!.tabs.length);
  });

  it('leaves numbers untouched, because it never had them', () => {
    const extraction = extractStrings(doc, 'Iron Sword');
    const { doc: out } = applyStrings(doc, 'Iron Sword', extraction, translateAll(extraction));

    const table = out.blocks[2];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.rows).toEqual([
      ['1', '2', '20'],
      ['2', '1', '10'],
    ]);
    expect(out.infobox?.common[0]?.rows[1]?.value).toBe('SwordIron');
    expect(out.infobox?.common[0]?.rows[2]?.value).toBe('1.0');
  });

  it('does not touch the document it was given', () => {
    // The English document is shared and cached; mutating it would poison
    // every later reader of that object.
    const extraction = extractStrings(doc, 'Iron Sword');
    applyStrings(doc, 'Iron Sword', extraction, translateAll(extraction));

    expect(doc.lead).toBe('The iron sword is the second sword.');
  });

  it('keeps English for any string the model failed to return', () => {
    const extraction = extractStrings(doc, 'Iron Sword');
    // A batch that failed leaves its inputs untouched in the array.
    const partial = extraction.strings.map((s, i) => (i === 1 ? '' : `ES:${s}`));
    const { doc: out } = applyStrings(doc, 'Iron Sword', extraction, partial);

    expect(out.lead).toBe('The iron sword is the second sword.');
  });
});

/** Several blocks under each heading: the shape that made Spanish pages repeat a heading. */
const magic: ArticleDoc = {
  lead: 'Magic is cast with staffs.',
  blocks: [
    { kind: 'paragraph', section: 'Magic > Elemental Magic', text: 'Elemental magic spends eitr.' },
    {
      kind: 'list',
      section: 'Magic > Elemental Magic',
      ordered: false,
      items: ['Staff of Embers', 'Staff of Frost'],
    },
    { kind: 'paragraph', section: 'Magic > Blood Magic', text: 'Blood magic spends health.' },
    { kind: 'paragraph', section: 'Magic > Blood Magic', text: 'The Staff of Embers is not blood magic.' },
  ],
  infobox: null,
  images: [],
  facets: {},
};

/** The headings the reader draws: a new one wherever the section text changes. */
function headings(d: ArticleDoc): string[] {
  const out: string[] = [];
  let last = '';
  for (const block of d.blocks) {
    if (block.section && block.section !== last) {
      last = block.section;
      out.push(block.section);
    }
  }
  return out;
}

describe('each string is sent once (BWR-19)', () => {
  it('sends a heading shared by several blocks once', () => {
    const { strings, slots } = extractStrings(magic, 'Magic');
    expect(strings.filter((s) => s === 'Magic > Elemental Magic')).toHaveLength(1);
    expect(slots.filter((s) => s.kind === 'block' && s.field === 'section')).toHaveLength(4);
  });

  it('gives every block under a heading the same translation, so the heading is drawn once', () => {
    // The prompt asks for the English in brackets on a name's first mention
    // only. Sent once per block, that made the second copy of a heading differ.
    const seen = new Set<string>();
    const glossFirst = (s: string) => {
      const first = !seen.has(s);
      seen.add(s);
      return first ? `ES:${s} (${s})` : `ES:${s}`;
    };
    const extraction = extractStrings(magic, 'Magic');
    const { doc: out } = applyStrings(magic, 'Magic', extraction, extraction.strings.map(glossFirst));

    expect(headings(out)).toHaveLength(headings(magic).length);
    expect(out.blocks[0]!.section).toBe(out.blocks[1]!.section);
  });

  it('glosses a repeated name on its first appearance only, but keeps headings identical', () => {
    const table: ArticleDoc = {
      lead: '',
      blocks: [
        { kind: 'paragraph', section: 'Wood', text: 'Wood' },
        {
          kind: 'table',
          section: 'Wood',
          caption: '',
          headers: ['Material'],
          rows: [['Wood'], ['Wood']],
        },
      ],
      infobox: null,
      images: [],
      facets: {},
    };
    const extraction = extractStrings(table, 'Wood');
    expect(extraction.strings).toEqual(['Wood', 'Material']);

    const { doc: out, title } = applyStrings(table, 'Wood', extraction, ['Madera (Wood)', 'Material']);
    expect(title).toBe('Madera (Wood)');
    expect(out.blocks.map((b) => b.section)).toEqual(['Madera (Wood)', 'Madera (Wood)']);
    const cells = out.blocks[1];
    if (cells?.kind !== 'table') throw new Error('expected a table');
    expect(cells.rows).toEqual([['Madera'], ['Madera']]);
    // Only a bracket that is the English itself is a gloss.
    const keep = applyStrings(table, 'Wood', extraction, ['Madera (seca)', 'Material']);
    expect(keep.doc.blocks[0]!.kind === 'paragraph' && keep.doc.blocks[0]!.text).toBe('Madera (seca)');
  });

  it('translates the prose of a block kind it does not know, and never reads it as a table', () => {
    // A notice or a quote added by a later parser: prose in `text`, no rows.
    const notice = { kind: 'notice', section: 'Notes', text: 'This content is outdated.' };
    const withNotice = { ...magic, blocks: [...magic.blocks, notice] } as unknown as ArticleDoc;
    const extraction = extractStrings(withNotice, 'Magic');
    expect(extraction.strings).toContain('This content is outdated.');

    const { doc: out } = applyStrings(withNotice, 'Magic', extraction, extraction.strings.map((s) => `ES:${s}`));
    expect((out.blocks[4] as unknown as { text: string }).text).toBe('ES:This content is outdated.');
  });
});

describe('translating in batches', () => {
  beforeEach(() => {
    // The provider chain warns about every failure; these tests fail on purpose.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const strings = Array.from({ length: 10 }, (_, i) => `String number ${i}`);
  const es = (list: string[]) => list.map((s) => `ES:${s}`);

  it('sends each batch once, in order, and puts every answer back in place', async () => {
    const mock = mockTranslator();
    const run = await translateStrings(strings, 'es', { batchSize: 4, candidates: mock.candidates });

    expect(mock.calls.map((c) => c.length)).toEqual([4, 4, 2]);
    expect(run.translations).toEqual(es(strings));
    expect(run).toMatchObject({ model: 'mock/translator', failed: 0, skipped: 0, exhausted: false, requests: 3 });
  });

  it('keeps every batch that worked when another one fails', async () => {
    // Anything carrying string 5 fails, however it is asked.
    const mock = mockTranslator((batch) => (batch.includes('String number 5') ? garbage() : spanish(batch, 0)));
    const run = await translateStrings(strings, 'es', { batchSize: 4, candidates: mock.candidates });

    expect(run.translations.slice(0, 4)).toEqual(es(strings.slice(0, 4)));
    expect(run.translations.slice(8)).toEqual(es(strings.slice(8)));
    // The failing batch was halved once: the half without string 5 made it.
    expect(run.translations.slice(4, 6)).toEqual([null, null]);
    expect(run.translations.slice(6, 8)).toEqual(es(strings.slice(6, 8)));
    expect(run.failed).toBe(2);
    expect(run.failedIndexes).toEqual([4, 5]);
    expect(run.exhausted).toBe(false);
  });

  it('halves a batch whose reply has the wrong length instead of merging it', async () => {
    const mock = mockTranslator((batch) => (batch.length === 4 ? spanish(batch.slice(1), 0) : spanish(batch, 0)));
    const run = await translateStrings(strings.slice(0, 4), 'es', { batchSize: 4, candidates: mock.candidates });

    expect(mock.calls.map((c) => c.length)).toEqual([4, 2, 2]);
    expect(run.translations).toEqual(es(strings.slice(0, 4)));
  });

  it('stops at the first request every provider refuses for the day, keeping what came before', async () => {
    const mock = mockTranslator((batch, call) => (call === 0 ? spanish(batch, call) : refusal(402)));
    const run = await translateStrings(strings, 'es', { batchSize: 4, candidates: mock.candidates });

    // No third batch, and the refused one is not halved: the budget is gone.
    expect(mock.calls).toHaveLength(2);
    expect(run.exhausted).toBe(true);
    expect(run.translations.slice(0, 4)).toEqual(es(strings.slice(0, 4)));
    expect(run.skipped).toBe(6);
    expect(run.failed).toBe(0);
  });

  it('ends at the first request every provider rate-limits when it cannot wait, without calling the budget spent', async () => {
    const mock = mockTranslator((batch, call) => (call === 0 ? spanish(batch, call) : refusal(429)));
    const run = await translateStrings(strings, 'es', { batchSize: 4, candidates: mock.candidates });

    // A limit that outlasted the providers' own waits refuses the next request too, a moment later.
    expect(mock.calls).toHaveLength(2);
    expect(run).toMatchObject({ exhausted: false, unavailable: true, rateLimited: true, skipped: 6, failed: 0 });
  });

  it('treats a chain with no provider configured as spent', async () => {
    const run = await translateStrings(strings, 'es', {
      candidates: () => {
        throw new Error('No model provider configured.');
      },
    });
    expect(run.exhausted).toBe(true);
    expect(run.translations.every((t) => t === null)).toBe(true);
  });

  it('starts nothing after the deadline', async () => {
    let clock = 0;
    const mock = mockTranslator((batch) => {
      clock += 1_000;
      return spanish(batch, 0);
    });
    const run = await translateStrings(strings, 'es', {
      batchSize: 4,
      candidates: mock.candidates,
      now: () => clock,
      deadline: 1_000,
    });

    expect(mock.calls).toHaveLength(1);
    expect(run.skipped).toBe(6);
    expect(run.exhausted).toBe(false);
  });

  it('spaces requests to stay under a per-minute limit', async () => {
    let clock = 0;
    const waits: number[] = [];
    const mock = mockTranslator();
    await translateStrings(strings, 'es', {
      batchSize: 4,
      candidates: mock.candidates,
      minIntervalMs: 5_000,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    expect(waits).toEqual([5_000, 5_000]);
  });

  it('runs up to `concurrency` requests at once', async () => {
    let inFlight = 0;
    let most = 0;
    const mock = mockTranslator(async (batch) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return spanish(batch, 0);
    });
    const run = await translateStrings(strings, 'es', { batchSize: 2, concurrency: 2, candidates: mock.candidates });

    expect(most).toBe(2);
    expect(run.translations).toEqual(es(strings));
  });

  it('abandons a provider that never answers and asks the next one', async () => {
    const hung = mockTranslator(
      (_strings, _call, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
      'mock/hung',
    );
    const healthy = mockTranslator(spanish, 'mock/healthy');
    const run = await translateStrings(strings.slice(0, 2), 'es', {
      candidates: () => [hung.candidate, healthy.candidate],
      requestTimeoutMs: 50,
    });
    expect(run.translations).toEqual(es(strings.slice(0, 2)));
    expect(run.model).toBe('mock/healthy');
  });

  it('sends each string as one line, so a line break inside a cell cannot shift the count', async () => {
    const mock = mockTranslator();
    const run = await translateStrings(['Grows in\nthe Meadows', 'Other'], 'es', { candidates: mock.candidates });
    expect(mock.calls[0]).toEqual(['Grows in\nthe Meadows', 'Other']);
    expect(run.translations).toEqual(['ES:Grows in\nthe Meadows', 'ES:Other']);
  });

  it('cuts a batch of long strings short, by characters, so its reply can be written in time', async () => {
    const mock = mockTranslator();
    const long = Array.from({ length: 6 }, (_, i) => `${'Patch notes entry '.repeat(20)}${i}`);
    await translateStrings(long, 'es', { candidates: mock.candidates, maxBatchChars: 1_000 });
    // 360 characters each: two fit under 1,000, a third does not.
    expect(mock.calls.map((c) => c.length)).toEqual([2, 2, 2]);
  });
});

describe('staying inside the time it was given', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const four = ['a one', 'b two', 'c three', 'd four'];
  const hang = (_s: string[], _c: number, signal?: AbortSignal) =>
    new Promise<string[]>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason));
    });

  it('starts neither half of a halved batch once the deadline has passed', async () => {
    let clock = 0;
    const mock = mockTranslator((batch) => {
      // A wrong-length reply that arrives after the deadline.
      clock = 1_000;
      return spanish(batch.slice(1), 0);
    });
    const run = await translateStrings(four, 'es', {
      batchSize: 4,
      candidates: mock.candidates,
      now: () => clock,
      deadline: 500,
    });
    expect(mock.calls).toHaveLength(1);
    // Never answered, so held against nothing.
    expect(run).toMatchObject({ failed: 0, skipped: 4, exhausted: false, requests: 1 });
  });

  it('bounds a request whose every provider hangs by the run, not by providers times their timeout', async () => {
    const chain = ['mock/a', 'mock/b', 'mock/c'].map((name) => mockTranslator(hang, name));
    const started = Date.now();
    const run = await translateStrings(four, 'es', {
      candidates: () => chain.map((m) => m.candidate),
      requestTimeoutMs: 1_000,
      signal: AbortSignal.timeout(150),
    });
    // Three providers at 1,000 ms each would have taken three seconds.
    expect(Date.now() - started).toBeLessThan(900);
    expect(chain[0]!.calls).toHaveLength(1);
    expect(chain[1]!.calls).toHaveLength(0);
    // Abandoned with the run: not the strings' fault, and not a refusal.
    expect(run).toMatchObject({ failed: 0, skipped: 4, exhausted: false });
  });

  it('gives each provider its own timeout and moves on', async () => {
    const hung = mockTranslator(hang, 'mock/hung');
    const healthy = mockTranslator(spanish, 'mock/healthy');
    const run = await translateStrings(four, 'es', {
      candidates: () => [hung.candidate, healthy.candidate],
      requestTimeoutMs: 50,
      signal: AbortSignal.timeout(5_000),
    });
    expect(run.translations).toEqual(four.map((s) => `ES:${s}`));
    expect(run.model).toBe('mock/healthy');
  });

  it('shares one pace between runs that share a pacer', async () => {
    let clock = 0;
    const waits: number[] = [];
    const pacer = createPacer(
      1_000,
      () => clock,
      async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    );
    const mock = mockTranslator();
    await Promise.all([
      translateStrings(['first article'], 'es', { candidates: mock.candidates, pacer }),
      translateStrings(['second article'], 'es', { candidates: mock.candidates, pacer }),
    ]);
    expect(mock.calls).toHaveLength(2);
    expect(waits).toEqual([1_000]);
  });

  it('gives no turn at or after the time it is told not to pass', async () => {
    let clock = 0;
    const pacer = createPacer(
      1_000,
      () => clock,
      async (ms) => {
        clock += ms;
      },
    );
    expect(await pacer.take(5_000)).toBe(true);
    expect(await pacer.take(500)).toBe(false);
    // The refused turn was not claimed: the next one is still 1,000.
    expect(await pacer.take(5_000)).toBe(true);
    expect(clock).toBe(1_000);
  });
});

describe('when no provider answers: an outage, not the text (IT-2)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const strings = Array.from({ length: 12 }, (_, i) => `String number ${i}`);
  const hang = (_s: string[], _c: number, signal?: AbortSignal) =>
    new Promise<string[]>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason));
    });

  it.each([
    ['a 503 "overloaded"', () => unavailable(503)],
    ['a network that never connects', () => unavailable()],
    ['a model that does not exist (404)', () => unavailable(404)],
    // How the SDK reports the last provider once its own retries ran out.
    [
      'a 503 after the SDK retried',
      () => new RetryError({ message: 'Failed after 3 attempts.', reason: 'maxRetriesExceeded', errors: [unavailable(503)] }),
    ],
  ])('holds %s against no string, halves nothing, and stops after two requests', async (_name, error) => {
    const mock = mockTranslator(() => error());
    const run = await translateStrings(strings, 'es', { batchSize: 4, candidates: mock.candidates });

    expect(mock.calls.map((c) => c.length)).toEqual([4, 4]);
    expect(run).toMatchObject({ failed: 0, failedIndexes: [], skipped: 12, exhausted: false, unavailable: true });
    // No answer, as against a rate limit: the operator is told which. And
    // the run stopped for it, which a caller does not ask again on the spot.
    expect(run).toMatchObject({ requests: 2, answered: 0, rateLimited: false, outage: true });
  });

  it('is not every provider refusing when one refuses and another is down', async () => {
    const refusing = mockTranslator(() => refusal(429), 'mock/refusing');
    const down = mockTranslator(() => unavailable(503), 'mock/down');
    const run = await translateStrings(strings.slice(0, 4), 'es', {
      candidates: () => [refusing.candidate, down.candidate],
    });
    expect(run).toMatchObject({ failed: 0, exhausted: false, unavailable: true, answered: 0 });
  });

  it('goes on past a single batch some provider chokes on', async () => {
    const mock = mockTranslator((batch, call) => (call === 0 ? unavailable(500) : spanish(batch, call)));
    const run = await translateStrings(strings, 'es', { batchSize: 4, candidates: mock.candidates });

    expect(mock.calls).toHaveLength(3);
    expect(run.translations.slice(4)).toEqual(strings.slice(4).map((s) => `ES:${s}`));
    expect(run).toMatchObject({ failed: 0, skipped: 4, unavailable: false, answered: 2, outage: false });
  });

  it('counts a reply that is not the list asked for, and one of the wrong length, as answered', async () => {
    const mock = mockTranslator((batch, call) => (call === 0 ? garbage() : spanish(batch.slice(1), call)));
    const run = await translateStrings(strings.slice(0, 2), 'es', { batchSize: 2, candidates: mock.candidates });
    // The unparseable reply is asked for once more and comes back one short;
    // halved, so does each half.
    expect(mock.calls.map((c) => c.length)).toEqual([2, 2, 1, 1]);
    expect(run).toMatchObject({ failed: 2, answered: 3, unavailable: false });
  });

  it('holds a timeout against nothing when the text is too short to explain it', async () => {
    const hung = mockTranslator(hang);
    const run = await translateStrings(strings.slice(0, 4), 'es', {
      batchSize: 4,
      candidates: hung.candidates,
      requestTimeoutMs: 20,
    });
    expect(hung.calls.map((c) => c.length)).toEqual([4]);
    expect(run).toMatchObject({ failed: 0, unavailable: true, answered: 0 });
  });

  it('holds a timeout against one long string, which is what a string too long to write looks like', async () => {
    const long = `${'A very long changelog entry. '.repeat(80)}`;
    const hung = mockTranslator(hang);
    const run = await translateStrings([long], 'es', { candidates: hung.candidates, requestTimeoutMs: 20 });
    expect(run).toMatchObject({ failed: 1, failedIndexes: [0], unavailable: false, answered: 0 });
  });

  it('tries a long batch that timed out in halves, and holds nothing against it if they time out too', async () => {
    const long = Array.from({ length: 4 }, (_, i) => `${'Patch notes entry. '.repeat(40)}${i}`);
    const hung = mockTranslator(hang);
    const run = await translateStrings(long, 'es', { candidates: hung.candidates, requestTimeoutMs: 20 });
    expect(hung.calls.map((c) => c.length)).toEqual([4, 2]);
    expect(run).toMatchObject({ failed: 0, unavailable: true });
  });

  it('keeps the failure log as it was through an outage, and sends no retries after it', async () => {
    const failures = new Map([['Primary attack is a 3-hit combo.', 1]]);
    const mock = mockTranslator(() => unavailable(503));
    const result = await translateArticle({ doc, title: 'Iron Sword', lang: 'es', failures, candidates: mock.candidates });

    expect([...result.failures]).toEqual([['Primary attack is a 3-hit combo.', 1]]);
    expect(result).toMatchObject({ translated: 0, failed: 0, unavailable: true, answered: 0, exhausted: false });
    // Two fresh batches tried; the string that failed before was not sent after them.
    expect(mock.calls.flat()).not.toContain('Primary attack is a 3-hit combo.');
  });
});

/*
 * The production run of 2026-10-28, with one provider able to answer: Groq,
 * at 8,000 tokens a minute. Every other provider was out of credit (xAI,
 * Cerebras, OpenRouter) or out of its day (Gemini). The run stopped after its
 * fourth article on a Groq refusal that said "try again in 510ms", and it had
 * already lost three batches to Groq replies that failed its JSON check.
 */
describe('rate limits, daily quotas and bad replies', () => {
  beforeEach(() => {
    resetCircuits();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const strings = Array.from({ length: 8 }, (_, i) => `String number ${i}`);
  const es = (list: string[]) => list.map((s) => `ES:${s}`);
  const GROQ = 'groq/openai/gpt-oss-120b';

  function refused(status: number, message: string): APICallError {
    return new APICallError({
      message,
      url: 'https://provider.test/v1/chat/completions',
      requestBodyValues: {},
      statusCode: status,
      isRetryable: false,
    });
  }
  const groqLimit = (per: 'minute' | 'day', wait: string) =>
    refused(
      429,
      'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_test` service tier `on_demand` on ' +
        `tokens per ${per} (${per === 'day' ? 'TPD' : 'TPM'}): Limit 8000, Used 6176, Requested 1892. ` +
        `Please try again in ${wait}.`,
    );
  const GEMINI_DAY = refused(
    429,
    'You exceeded your current quota.\n* Quota exceeded for metric: generativelanguage.googleapis.com/' +
      'generate_content_free_tier_requests, limit: 20, model: gemini-2.5-flash-lite, description: Generate content ' +
      'requests per day limit exceeded on Free Tier.',
  );
  const badJson = () => refused(400, "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.");
  /** Groq's 413, for a request larger than its whole minute's budget. */
  const tooLarge = () =>
    refused(
      413,
      'Request too large for model `openai/gpt-oss-120b` in organization `org_test` service tier `on_demand` on ' +
        'tokens per minute (TPM): Limit 8000, Requested 9311, please reduce your message size and try again.',
    );
  /** A provider that never answers until its deadline aborts it. */
  const hang = (signal?: AbortSignal) =>
    new Promise<string[]>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason));
    });

  /** A clock that only moves when the translator waits on it. */
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

  it('asks every provider for a reply ceiling sized to the batch, never the model’s maximum', async () => {
    const seen: { strings: number; ceiling: number | undefined }[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const batch = promptStrings(options.prompt);
        seen.push({ strings: batch.length, ceiling: options.maxOutputTokens });
        return {
          content: [{ type: 'text', text: JSON.stringify({ translations: es(batch) }) }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 10, text: 10, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const long = Array.from({ length: 40 }, (_, i) => `${'A sentence of the article, long enough to count. '.repeat(2)}${i}`);
    await translateStrings([...long, 'Short'], 'es', { candidates: () => [{ name: 'mock/ceiling', model }] });

    expect(seen.map((s) => s.strings)).toEqual([40, 1]);
    expect(seen.map((s) => s.ceiling)).toEqual([maxReplyTokens(long), maxReplyTokens(['Short'])]);
  });

  it('sizes that ceiling above the longest reply measured, with room to reason, and far under 65,536', () => {
    // The longest reply in the corpus's memories: "flax", 40 strings, 1,712 characters, a 2,178-character reply.
    const flax = Array.from({ length: 40 }, (_, i) => 'x'.repeat(i < 32 ? 43 : 42));
    expect(flax.join('')).toHaveLength(1_712);
    const replyTokens = Math.ceil(2_178 / 3);
    expect(maxReplyTokens(flax)).toBeGreaterThan(replyTokens + 2_000);
    expect(maxReplyTokens(['Short'])).toBeLessThan(maxReplyTokens(flax));
    expect(maxReplyTokens(['A changelog entry far longer than any other. '.repeat(400)])).toBeLessThanOrEqual(8_192);
  });

  it('waits out a short rate limit on the same provider, instead of asking providers that refuse', async () => {
    const clock = fakeClock();
    const groq = mockTranslator((batch, call) => (call === 0 ? groqLimit('minute', '510ms') : spanish(batch, call)), GROQ);
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const run = await translateStrings(strings, 'es', {
      candidates: () => [groq.candidate, broke.candidate],
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(run.translations).toEqual(es(strings));
    expect(groq.calls).toHaveLength(2);
    expect(broke.calls).toHaveLength(0);
    expect(clock.waits).toEqual([510]);
    expect(run).toMatchObject({ exhausted: false, unavailable: false, failed: 0 });
  });

  it('stops at once, as spent, when every provider is out of credit or out of its day', async () => {
    const clock = fakeClock();
    const gemini = mockTranslator(() => GEMINI_DAY, 'google/gemini-2.5-flash-lite');
    const groq = mockTranslator(() => groqLimit('day', '12m37.248s'), GROQ);
    const openrouter = mockTranslator(() => refusal(402), 'openrouter/x-ai/grok-4.3');
    const run = await translateStrings(strings, 'es', {
      batchSize: 4,
      candidates: () => [gemini.candidate, groq.candidate, openrouter.candidate],
      noAnswerWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(groq.calls).toHaveLength(1);
    expect(clock.waits).toEqual([]);
    expect(run).toMatchObject({ exhausted: true, skipped: 8, failed: 0 });
  });

  it('waits for a limit the provider could not wait out in time, then asks again for the same strings', async () => {
    // 45 seconds of a 60-second deadline leave too little to answer in: the
    // chain moves on, every other provider refuses, and the run waits instead
    // — a minute, the window a per-minute limit counts in, or longer if told.
    const clock = fakeClock();
    const groq = mockTranslator((batch, call) => (call === 0 ? groqLimit('minute', '45s') : spanish(batch, call)), GROQ);
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const run = await translateStrings(strings, 'es', {
      candidates: () => [groq.candidate, broke.candidate],
      noAnswerWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(groq.calls).toEqual([strings, strings]);
    expect(clock.waits).toEqual([60_000]);
    expect(run.translations).toEqual(es(strings));
    expect(run).toMatchObject({ exhausted: false, unavailable: false, failed: 0 });

    const later = fakeClock();
    const slow = mockTranslator((batch, call) => (call === 0 ? groqLimit('minute', '1m30s') : spanish(batch, call)), GROQ);
    await translateStrings(strings, 'es', {
      candidates: () => [slow.candidate, broke.candidate],
      noAnswerWaitMs: 60_000,
      now: later.now,
      sleep: later.sleep,
    });
    expect(later.waits).toEqual([90_000]);
  });

  it('stops after two requests in a row no provider answered, the second asked after a real wait', async () => {
    const clock = fakeClock();
    const down = mockTranslator(() => unavailable(503));
    const run = await translateStrings(strings, 'es', {
      batchSize: 4,
      candidates: down.candidates,
      noAnswerWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    // The same four strings, asked again a minute later; the next four never.
    expect(down.calls).toEqual([strings.slice(0, 4), strings.slice(0, 4)]);
    expect(clock.waits).toEqual([60_000]);
    expect(run).toMatchObject({ unavailable: true, exhausted: false, failed: 0, skipped: 8, answered: 0 });
  });

  it('asks once more after a reply that fails validation, then halves the batch: a bad reply, not a dead provider', async () => {
    const groq = mockTranslator(() => badJson(), GROQ);
    const run = await translateStrings(strings.slice(0, 4), 'es', { batchSize: 4, candidates: groq.candidates });

    // Each request twice on the same provider: the batch, then each half.
    expect(groq.calls.map((c) => c.length)).toEqual([4, 4, 2, 2, 2, 2]);
    expect(run).toMatchObject({ failed: 4, exhausted: false, unavailable: false, answered: 3 });
    expect(isTripped(GROQ)).toBe(false);
  });

  it('keeps the second reply when the first failed validation', async () => {
    const groq = mockTranslator((batch, call) => (call === 0 ? badJson() : spanish(batch, call)), GROQ);
    const run = await translateStrings(strings, 'es', { candidates: groq.candidates });
    expect(groq.calls).toHaveLength(2);
    expect(run.translations).toEqual(es(strings));
  });

  it('halves a batch too large for a provider’s per-minute budget, holding nothing against it', async () => {
    const groq = mockTranslator((batch, call) => (batch.length > 2 ? tooLarge() : spanish(batch, call)), GROQ);
    const run = await translateStrings(strings.slice(0, 4), 'es', { batchSize: 4, candidates: groq.candidates });

    expect(groq.calls.map((c) => c.length)).toEqual([4, 2, 2]);
    expect(run.translations).toEqual(es(strings.slice(0, 4)));
    expect(run).toMatchObject({ failed: 0, unavailable: false });
  });

  it('keeps halving a batch too large for the minute down to strings that fit, since saying so costs nothing', async () => {
    const groq = mockTranslator((batch, call) => (batch.length > 1 ? tooLarge() : spanish(batch, call)), GROQ);
    const run = await translateStrings(strings.slice(0, 4), 'es', { batchSize: 4, candidates: groq.candidates });

    expect(groq.calls.map((c) => c.length)).toEqual([4, 2, 1, 1, 2, 1, 1]);
    expect(run.translations).toEqual(es(strings.slice(0, 4)));
    expect(run).toMatchObject({ failed: 0, unavailable: false });

    // One string too large on its own will not fit on any later call either.
    const alone = await translateStrings(['A changelog entry far too long. '.repeat(300)], 'es', {
      candidates: mockTranslator(() => tooLarge(), GROQ).candidates,
    });
    expect(alone).toMatchObject({ failed: 1, failedIndexes: [0] });
  });

  it('holds nothing against a long string whose provider spent its deadline partly waiting out a rate limit', async () => {
    // The endpoint gives a provider 25 seconds, and may spend two thirds of
    // them waiting as it is told: what is left says nothing about the text.
    const long = 'The Mistlands is a biome shrouded in thick fog. '.repeat(50).trim();
    const groq = () =>
      mockTranslator((_batch, call, signal) => (call === 0 ? groqLimit('minute', '150ms') : hang(signal)), GROQ);
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');

    const first = groq();
    const run = await translateStrings([long], 'es', {
      candidates: () => [first.candidate, broke.candidate],
      requestTimeoutMs: 300,
    });
    expect(first.calls).toHaveLength(2);
    expect(run).toMatchObject({ failed: 0, failedIndexes: [], unavailable: true, exhausted: false });

    const second = groq();
    const article = await translateArticle({
      doc: { lead: '', blocks: [{ kind: 'paragraph', section: '', text: long }], infobox: null, images: [], facets: {} },
      title: 'Mistlands',
      lang: 'es',
      memory: new Map([['Mistlands', 'Tierras brumosas']]),
      candidates: () => [second.candidate, broke.candidate],
      requestTimeoutMs: 300,
    });
    expect(article.failures.size).toBe(0);
  });

  it('holds nothing against a long string when its only provider waited out a rate limit, then ran out of time', async () => {
    // Alone in its chain, a provider used to get the SDK's own retries, which
    // sat out the refusal where the chain could not see it: the timeout that
    // followed read as the string being too long to write.
    const long = 'The Mistlands is a biome shrouded in thick fog. '.repeat(50).trim();
    const retryable = () =>
      new APICallError({
        message: groqLimit('minute', '150ms').message,
        url: 'https://provider.test/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });
    const groq = mockTranslator((_batch, call, signal) => (call === 0 ? retryable() : hang(signal)), GROQ);
    const run = await translateStrings([long], 'es', { candidates: groq.candidates, requestTimeoutMs: 600 });

    expect(groq.calls).toHaveLength(2);
    expect(run).toMatchObject({ failed: 0, failedIndexes: [], unavailable: true, rateLimited: false });
  });

  it('counts a deadline missed after a wait as no answer, never as a refusal that ends the run on the spot', async () => {
    // A run a reader is waiting on stops at the first request every provider
    // refuses. A provider that waited as it was told, and then ran out of
    // time, refused nothing: the next batch is still asked.
    const groq = mockTranslator(
      (batch, call, signal) => (call === 0 ? groqLimit('minute', '150ms') : call === 1 ? hang(signal) : spanish(batch, call)),
      GROQ,
    );
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const run = await translateStrings(strings, 'es', {
      batchSize: 4,
      candidates: () => [groq.candidate, broke.candidate],
      requestTimeoutMs: 300,
    });

    expect(groq.calls.map((c) => c.length)).toEqual([4, 4, 4]);
    expect(run.translations.slice(4)).toEqual(es(strings.slice(4)));
    expect(run).toMatchObject({ failed: 0, skipped: 4, unavailable: false, rateLimited: false });
  });

  it('waits before sending the halves of a long batch that ran out of time, in a run that can wait', async () => {
    // A timeout on enough text to explain it is halved, and it is still a
    // request nobody answered: its halves go out after the run's wait, so a
    // refusal of the first one is not a second request on the heels of the first.
    const clock = fakeClock();
    const long = Array.from({ length: 4 }, (_, i) => `${'Patch notes entry. '.repeat(40)}${i}`);
    const groq = mockTranslator((batch, call, signal) => (call === 0 ? hang(signal) : spanish(batch, call)), GROQ);
    const run = await translateStrings(long, 'es', {
      candidates: groq.candidates,
      requestTimeoutMs: 20,
      noAnswerWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(groq.calls.map((c) => c.length)).toEqual([4, 2, 2]);
    expect(clock.waits).toEqual([60_000]);
    expect(run.translations).toEqual(es(long));
    expect(run).toMatchObject({ failed: 0, unavailable: false });
  });

  it('asks a half again after its wait when the batch was too large for the minute and the half was refused', async () => {
    const clock = fakeClock();
    // The whole batch is too large; its first half then meets the minute's limit, once.
    const groq = mockTranslator(
      (batch, call) => (batch.length > 2 ? tooLarge() : call === 1 ? groqLimit('minute', '45s') : spanish(batch, call)),
      GROQ,
    );
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const run = await translateStrings(strings.slice(0, 4), 'es', {
      candidates: () => [groq.candidate, broke.candidate],
      noAnswerWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    // The 413 is a provider answering about size: halving is the remedy, and it is no outage.
    expect(groq.calls.map((c) => c.length)).toEqual([4, 2, 2, 2]);
    expect(clock.waits).toEqual([60_000]);
    expect(run.translations).toEqual(es(strings.slice(0, 4)));
    expect(run).toMatchObject({ unavailable: false, failed: 0 });
  });

  it('waits a minute before asking again, however short the waits a provider keeps stating', async () => {
    // A busy half-minute on the key the chat shares: Groq says "510ms" every
    // time, the chain sits out three of them, and a request half a second
    // later would only meet the same minute.
    const clock = fakeClock();
    const start = clock.now();
    const groq = mockTranslator(
      (batch, call) => (clock.now() - start < 30_000 ? groqLimit('minute', '510ms') : spanish(batch, call)),
      GROQ,
    );
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const run = await translateStrings(strings, 'es', {
      candidates: () => [groq.candidate, broke.candidate],
      noAnswerWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(clock.waits).toEqual([510, 510, 510, 60_000]);
    expect(run.translations).toEqual(es(strings));
    expect(run).toMatchObject({ unavailable: false, exhausted: false });
  });

  it('asks each of two batches refused together again after the wait, rather than stopping', async () => {
    // Two requests in flight meet one busy minute: that is one limit met
    // twice, not two requests a minute apart.
    const clock = fakeClock();
    const start = clock.now();
    const groq = mockTranslator(
      (batch, call) => (clock.now() - start < 45_000 ? groqLimit('minute', '45s') : spanish(batch, call)),
      GROQ,
    );
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const run = await translateStrings(strings, 'es', {
      batchSize: 4,
      concurrency: 2,
      candidates: () => [groq.candidate, broke.candidate],
      noAnswerWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(groq.calls).toHaveLength(4);
    expect(run.translations).toEqual(es(strings));
    expect(run).toMatchObject({ unavailable: false, failed: 0 });
  });

  it('still stops two workers whose batches are refused again after the wait, before the next batch', async () => {
    const clock = fakeClock();
    const twelve = Array.from({ length: 12 }, (_, i) => `String number ${i}`);
    const groq = mockTranslator(() => groqLimit('minute', '45s'), GROQ);
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const run = await translateStrings(twelve, 'es', {
      batchSize: 4,
      concurrency: 2,
      candidates: () => [groq.candidate, broke.candidate],
      noAnswerWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    // A refusal after a minute's wait ends the run, whichever worker meets
    // it first; the third batch is never sent.
    expect(groq.calls.length).toBeGreaterThanOrEqual(3);
    expect(groq.calls.flat()).not.toContain('String number 8');
    expect(clock.waits.length).toBeGreaterThan(0);
    expect(clock.waits.every((ms) => ms >= 60_000)).toBe(true);
    expect(run).toMatchObject({ unavailable: true, rateLimited: true, exhausted: false, failed: 0, skipped: 12 });
  });

  it('asks a batch again after the wait when its provider replied badly and then asked to wait, rather than halving it', async () => {
    const clock = fakeClock();
    const groq = mockTranslator(
      (batch, call) => (call === 0 ? badJson() : call === 1 ? groqLimit('minute', '56s') : spanish(batch, call)),
      GROQ,
    );
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const run = await translateStrings(strings, 'es', {
      candidates: () => [groq.candidate, broke.candidate],
      noAnswerWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(groq.calls.map((c) => c.length)).toEqual([8, 8, 8]);
    expect(clock.waits).toEqual([60_000]);
    expect(run.translations).toEqual(es(strings));
    expect(run).toMatchObject({ failed: 0, unavailable: false });
    expect(isTripped(GROQ)).toBe(false);
  });

  it('counts a request whose provider replied badly and then said to wait as unanswered: refused again after the wait, the run stops', async () => {
    // The bad reply was paid for, and shows the provider is up; but its last
    // word was to wait, so it never answered the request. Taken for an
    // answer, a run of such requests scored as answers that are no use, and
    // stopped telling the operator to check the model.
    const clock = fakeClock();
    const groq = mockTranslator((batch, call) => (call === 0 ? badJson() : groqLimit('minute', '56s')), GROQ);
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const run = await translateStrings(strings, 'es', {
      batchSize: 4,
      candidates: () => [groq.candidate, broke.candidate],
      noAnswerWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    // The bad reply, the refusal after it, and the same four strings a
    // minute later, refused again: two in a row, the second after the wait.
    expect(groq.calls).toEqual([strings.slice(0, 4), strings.slice(0, 4), strings.slice(0, 4)]);
    expect(clock.waits).toEqual([60_000]);
    expect(run).toMatchObject({ answered: 1, unavailable: true, rateLimited: true, outage: true, failed: 0, skipped: 8 });
  });

  it('carries a request nobody answered over to the next call that shares its silence: that call waits first, and counts what it meets as the second', async () => {
    // A queue run asks for an article a round at a time. Four long strings:
    // the batch runs out of time, its first half is answered, and its second
    // half runs out of time too, with no halving left. One request
    // unanswered at the end of the round, and no outage yet.
    const clock = fakeClock();
    const silence = createSilence();
    const long = Array.from({ length: 4 }, (_, i) => `${'The Mistlands is a biome shrouded in thick fog. '.repeat(23)}${i}`);
    const groq = mockTranslator(
      (batch, call, signal) => (call === 0 || call === 2 ? hang(signal) : spanish(batch, call)),
      GROQ,
    );
    const round = await translateStrings(long, 'es', {
      candidates: groq.candidates,
      requestTimeoutMs: 20,
      noAnswerWaitMs: 60_000,
      silence,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(groq.calls.map((c) => c.length)).toEqual([4, 2, 2]);
    expect(round).toMatchObject({ failed: 0, unavailable: true, outage: false });
    expect(clock.waits).toEqual([60_000]);

    // The next round sits out the wait that half set, and its request,
    // unanswered, is the second in a row: the run stops, with no re-ask.
    const down = mockTranslator(() => unavailable(503));
    const next = await translateStrings(['The next string.'], 'es', {
      candidates: down.candidates,
      noAnswerWaitMs: 60_000,
      silence,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(clock.waits).toEqual([60_000, 60_000]);
    expect(down.calls).toHaveLength(1);
    expect(next).toMatchObject({ unavailable: true, outage: true, answered: 0, skipped: 1 });

    // Without one, a call starts afresh: no wait, and its first request unanswered is only the first.
    const fresh = fakeClock();
    const alone = await translateStrings(['The next string.'], 'es', {
      candidates: mockTranslator(() => unavailable(503)).candidates,
      noAnswerWaitMs: 60_000,
      now: fresh.now,
      sleep: fresh.sleep,
    });
    expect(fresh.waits).toEqual([60_000]);
    expect(alone).toMatchObject({ requests: 2, outage: true });
  });

  it('holds back a worker parked for its turn until the wait another worker’s refusal set', async () => {
    // Groq is busy for the first fifty seconds. Worker A's batch is refused
    // five seconds in, with a wait too long to sit out; worker B is parked
    // for its turn until fifteen. Sent then, B's batch met the same busy
    // minute and stopped the run, though Groq answers from fifty.
    const clock = eventClock();
    const busy = (batch: string[]) => (clock.elapsed() < 50_000 ? groqLimit('minute', '45s') : es(batch));
    let first = true;
    const starts: { strings: string; at: number }[] = [];
    const groq = mockTranslator(async (batch) => {
      starts.push({ strings: batch.join(','), at: clock.elapsed() });
      if (first) {
        first = false;
        await clock.sleep(5_000);
      }
      return busy(batch);
    }, GROQ);
    const broke = mockTranslator(() => refusal(402), 'cerebras/gpt-oss-120b');
    const six = strings.slice(0, 6);
    const run = await clock.drive(
      translateStrings(six, 'es', {
        batchSize: 2,
        concurrency: 2,
        candidates: () => [groq.candidate, broke.candidate],
        pacer: createPacer(15_000, clock.now, clock.sleep),
        noAnswerWaitMs: 60_000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    );

    expect(run.translations).toEqual(es(six));
    expect(run).toMatchObject({ unavailable: false, outage: false });
    // Nothing went out between the refusal and the end of its wait.
    expect(starts.slice(1).every(({ at }) => at >= 65_000)).toBe(true);
  });

  it('claims a request’s turn at what it may cost, so two workers never send one minute’s tokens at once', async () => {
    // Each answer reports four thousand tokens, at a budget of four thousand
    // a minute. Two workers used to share every turn and send together.
    const clock = eventClock();
    const starts: number[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const batch = promptStrings(options.prompt);
        starts.push(clock.elapsed());
        await clock.sleep(5_000);
        return {
          content: [{ type: 'text', text: JSON.stringify({ translations: es(batch) }) }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 2_000, noCache: 2_000, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2_000, text: 2_000, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const four = strings.slice(0, 4);
    await clock.drive(
      translateStrings(four, 'es', {
        batchSize: 2,
        concurrency: 2,
        candidates: () => [{ name: GROQ, model }],
        pacer: createPacer(0, clock.now, clock.sleep, 4_000),
        noAnswerWaitMs: 60_000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    );

    // The second waits for what the first may cost, paid off at the budget's rate.
    expect(starts).toEqual([0, (estimateTokens(four.slice(0, 2), 'es') * 60_000) / 4_000]);
  });

  it('counts every call the chain makes, and the tokens the providers say they used', async () => {
    // What Groq's thousand requests and 200,000 tokens a day go on: the
    // reply that failed its check, the same request asked once more, and
    // again after the wait it stated. Three calls for one request.
    const clock = fakeClock();
    const groq = mockTranslator(
      (batch, call) => (call === 0 ? badJson() : call === 1 ? groqLimit('minute', '510ms') : spanish(batch, call)),
      GROQ,
    );
    const run = await translateStrings(strings, 'es', { candidates: groq.candidates, now: clock.now, sleep: clock.sleep });

    expect(run.translations).toEqual(es(strings));
    expect(run).toMatchObject({ requests: 1, calls: 3 });
    // The mock reports twenty tokens a reply. The reply Groq turned down
    // reports none, and counts as what the batch could have cost.
    expect(run.tokens).toBe(estimateTokens(strings, 'es') + 20);
  });

  it('holds the next turn back until the tokens spent are paid off at the budget’s rate', async () => {
    let clock = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      clock += ms;
    };
    const pacer = createPacer(0, () => clock, sleep, 4_000);
    expect(await pacer.take()).toBe(true);
    pacer.spend?.(2_000);
    expect(await pacer.take()).toBe(true);
    // Two thousand tokens at four thousand a minute: half a minute.
    expect(waits).toEqual([30_000]);
    // Nor is a turn given that would only come past the instant it must not pass.
    pacer.spend?.(4_000);
    expect(await pacer.take(clock + 30_000)).toBe(false);

    // Without a budget, tokens hold nothing back.
    const plain = createPacer(0, () => clock, sleep);
    plain.spend?.(1_000_000);
    expect(await plain.take()).toBe(true);
    expect(waits).toEqual([30_000]);
  });

  it('holds a turn back for what the requests under way may cost, and settles each at what it used', async () => {
    let clock = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      clock += ms;
    };
    const pacer = createPacer(0, () => clock, sleep, 4_000);
    expect(await pacer.take(undefined, 2_000)).toBe(true);
    // A turn while that request is under way: its 2,000 tokens first, half a minute.
    expect(await pacer.take(undefined, 1_000)).toBe(true);
    expect(waits).toEqual([30_000]);
    // A turn refused for its deadline claims nothing.
    expect(await pacer.take(clock + 1_000, 1_000_000)).toBe(false);
    // Both end now, having used less than they might have: 1,000 and 500
    // tokens, paid off from here, 22.5 seconds.
    pacer.spend?.(1_000, 2_000);
    pacer.spend?.(500, 1_000);
    expect(await pacer.take()).toBe(true);
    expect(waits).toEqual([30_000, 22_500]);

    // Without a budget, claims hold nothing back either.
    const plain = createPacer(0, () => clock, sleep);
    expect(await plain.take(undefined, 1_000_000)).toBe(true);
    expect(await plain.take(undefined, 1_000_000)).toBe(true);
    expect(waits).toEqual([30_000, 22_500]);
  });

  it('asks for an article’s old failures after the wait, in a run that waits, when its fresh strings ended on one request nobody answered', async () => {
    // The fresh strings: four long paragraphs whose second half runs out of
    // time, with no halving left. One request unanswered, no outage: the
    // retry of the string that failed before goes out after the wait, where
    // it used to be dropped for the run.
    const clock = fakeClock();
    const long = Array.from({ length: 4 }, (_, i) => `${'The Mistlands is a biome shrouded in thick fog. '.repeat(23)}${i}`);
    const lore: ArticleDoc = {
      lead: '',
      blocks: [...long, 'An old failure.'].map((text) => ({ kind: 'paragraph' as const, section: '', text })),
      infobox: null,
      images: [],
      facets: {},
    };
    const groq = mockTranslator(
      (batch, call, signal) => (call === 0 || call === 2 ? hang(signal) : spanish(batch, call)),
      GROQ,
    );
    const result = await translateArticle({
      doc: lore,
      title: 'Lore',
      lang: 'es',
      memory: new Map([['Lore', 'Saber']]),
      failures: new Map([['An old failure.', 1]]),
      candidates: groq.candidates,
      requestTimeoutMs: 20,
      noAnswerWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(groq.calls.map((c) => c.length)).toEqual([4, 2, 2, 1]);
    expect(clock.waits).toEqual([60_000, 60_000]);
    expect(result.memory.get('An old failure.')).toBe('ES:An old failure.');
    expect(result).toMatchObject({ outage: false, unavailable: false, failed: 0 });
  });

  it('charges each request the tokens its provider reported, and a reply turned down what it could have cost', async () => {
    let clock = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      clock += ms;
    };
    const twelve = Array.from({ length: 12 }, (_, i) => `String number ${i}`);
    // Twenty tokens a reply at 1,200 a minute: a second between requests.
    await translateStrings(twelve, 'es', {
      batchSize: 4,
      candidates: mockTranslator().candidates,
      pacer: createPacer(0, () => clock, sleep, 1_200),
    });
    expect(waits).toEqual([1_000, 1_000]);

    // At 60,000 a minute, a millisecond a token.
    waits.length = 0;
    const groq = mockTranslator((batch, call) => (call === 0 ? badJson() : spanish(batch, call)), GROQ);
    await translateStrings(twelve, 'es', {
      batchSize: 4,
      candidates: groq.candidates,
      pacer: createPacer(0, () => clock, sleep, 60_000),
    });
    expect(waits).toEqual([estimateTokens(twelve.slice(0, 4), 'es') + 20, 20]);
  });

  it('keeps one pace for an article’s fresh strings and its retries of old failures', async () => {
    const clock = fakeClock();
    const all = extractStrings(doc, 'Iron Sword').strings;
    const mock = mockTranslator();
    await translateArticle({
      doc,
      title: 'Iron Sword',
      lang: 'es',
      failures: new Map(all.slice(0, 2).map((s) => [s, 1])),
      candidates: mock.candidates,
      minIntervalMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    // Every request after the first waited its turn, the first retry included.
    expect(mock.calls.length).toBeGreaterThan(1);
    expect(clock.waits).toEqual(Array(mock.calls.length - 1).fill(5_000));
  });
});

describe('translating an article with a memory', () => {
  const all = extractStrings(doc, 'Iron Sword').strings;

  it('sends only what the memory does not have', async () => {
    const memory = new Map([
      ['Iron Sword', 'Espada de hierro (Iron Sword)'],
      ['Usage', 'Uso'],
    ]);
    const mock = mockTranslator();
    const result = await translateArticle({ doc, title: 'Iron Sword', lang: 'es', memory, candidates: mock.candidates });

    const sent = mock.calls.flat();
    expect(sent).not.toContain('Iron Sword');
    expect(sent).not.toContain('Usage');
    expect(result.title).toBe('Espada de hierro (Iron Sword)');
    expect(result.doc.blocks[0]!.section).toBe('Uso');
    expect(result).toMatchObject({ pending: 0, translated: sent.length, total: all.length });
  });

  it('fills a long article skeleton first, a bounded number of strings per call', async () => {
    const order = planArticle(doc, 'Iron Sword', null).todo.map((i) => all[i]!);
    const mock = mockTranslator();
    const first = await translateArticle({
      doc,
      title: 'Iron Sword',
      lang: 'es',
      maxStrings: 3,
      candidates: mock.candidates,
    });
    expect(first.attempted).toEqual(order.slice(0, 3));
    expect(first.pending).toBe(all.length - 3);
    expect(first.title).toBe('ES:Iron Sword');

    const second = await translateArticle({
      doc,
      title: 'Iron Sword',
      lang: 'es',
      memory: first.memory,
      candidates: mock.candidates,
    });
    expect(second.attempted).toEqual(order.slice(3));
    expect(second.pending).toBe(0);
  });

  it('calls no model when the memory already covers the article', async () => {
    const memory = new Map(all.map((s) => [s, `ES:${s}`]));
    const mock = mockTranslator();
    const result = await translateArticle({ doc, title: 'Iron Sword', lang: 'es', memory, candidates: mock.candidates });

    expect(mock.calls).toHaveLength(0);
    expect(result).toMatchObject({ requests: 0, model: null, pending: 0, translated: 0 });
  });

  it('forgets strings the article no longer has', async () => {
    const memory = new Map([['A sentence the wiki deleted', 'Una frase borrada']]);
    const result = await translateArticle({
      doc,
      title: 'Iron Sword',
      lang: 'es',
      memory,
      candidates: mockTranslator().candidates,
    });
    expect(result.memory.has('A sentence the wiki deleted')).toBe(false);
  });

  it('does not resend what this run already tried', async () => {
    const order = planArticle(doc, 'Iron Sword', null).todo.map((i) => all[i]!);
    const skip = new Set(all.slice(0, 2));
    const mock = mockTranslator();
    const result = await translateArticle({ doc, title: 'Iron Sword', lang: 'es', skip, candidates: mock.candidates });
    expect(mock.calls.flat()).toEqual(order.filter((s) => !skip.has(s)));
    expect(result.pending).toBe(2);
  });

  it('plans the skeleton first: title and lead, headings and labels, infobox values, then the text', () => {
    const { todo, extraction } = planArticle(doc, 'Iron Sword', new Map([['Iron Sword', 'x']]));
    const planned = todo.map((i) => extraction.strings[i]);
    expect(planned).toHaveLength(all.length - 1);
    expect(planned[0]).toBe('The iron sword is the second sword.');
    expect(planned.slice(1, 4)).toEqual(['Usage', 'Notes', 'Upgrade information']);
    expect(planned.indexOf('Durability')).toBeLessThan(planned.indexOf('The straight line between life and death.'));
    expect(planned.slice(-2)).toEqual(['Primary attack is a 3-hit combo.', 'Cannot be repaired in the field']);
  });
});

describe('strings that keep failing', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const all = extractStrings(doc, 'Iron Sword').strings;
  const stubborn = 'Primary attack is a 3-hit combo.';
  /** A model that cannot get `stubborn` right, in any batch. */
  const failsOnStubborn = () => mockTranslator((batch) => (batch.includes(stubborn) ? garbage() : spanish(batch, 0)));

  it('counts a failure against each string whose request came back unusable, and clears it once translated', async () => {
    const first = await translateArticle({ doc, title: 'Iron Sword', lang: 'es', candidates: failsOnStubborn().candidates });
    expect(first.failures.get(stubborn)).toBe(1);
    expect(first.failed).toBe(first.failures.size);
    expect([...first.failures.values()].every((n) => n === 1)).toBe(true);

    const second = await translateArticle({
      doc,
      title: 'Iron Sword',
      lang: 'es',
      memory: first.memory,
      failures: first.failures,
      candidates: failsOnStubborn().candidates,
    });
    // Retried in batches of five, so only the stubborn string's own small
    // batch fails again, and its half after halving.
    expect(second.failures.get(stubborn)).toBe(2);
    expect(second.failures.size).toBeLessThan(first.failures.size);

    const healthy = await translateArticle({
      doc,
      title: 'Iron Sword',
      lang: 'es',
      memory: second.memory,
      failures: second.failures,
      candidates: mockTranslator().candidates,
    });
    expect(healthy.failures.size).toBe(0);
    expect(healthy.pending).toBe(0);
  });

  it('sends strings that failed before last, in batches of at most five', async () => {
    const failures = new Map(all.slice(0, 7).map((s) => [s, 1]));
    const mock = mockTranslator();
    await translateArticle({ doc, title: 'Iron Sword', lang: 'es', failures, candidates: mock.candidates });
    const sizes = mock.calls.map((c) => c.length);
    expect(sizes.slice(-2)).toEqual([5, 2]);
    expect(mock.calls.slice(-2).flat().sort()).toEqual(all.slice(0, 7).sort());
  });

  it('leaves out strings that failed `maxFailures` times, as stuck', async () => {
    const failures = new Map([[stubborn, 2]]);
    const plan = planArticle(doc, 'Iron Sword', null, failures, 2);
    expect(plan.stuck.map((i) => all[i])).toEqual([stubborn]);
    expect(plan.todo.map((i) => all[i])).not.toContain(stubborn);

    const mock = mockTranslator();
    const result = await translateArticle({ doc, title: 'Iron Sword', lang: 'es', failures, maxFailures: 2, candidates: mock.candidates });
    expect(mock.calls.flat()).not.toContain(stubborn);
    expect(result.pending).toBe(1);
    expect(result.failures.get(stubborn)).toBe(2);
  });

  it('does not count a string that was never sent, or one cut off by the deadline', async () => {
    let clock = 0;
    const mock = mockTranslator((batch) => {
      clock = 10;
      return spanish(batch.slice(1), 0);
    });
    const result = await translateArticle({
      doc,
      title: 'Iron Sword',
      lang: 'es',
      candidates: mock.candidates,
      now: () => clock,
      deadline: 5,
    });
    expect(result.failures.size).toBe(0);
  });

  it('forgets failures of strings the article no longer has, or that are now translated', () => {
    const extraction = extractStrings(doc, 'Iron Sword');
    const kept = pruneFailures(
      new Map([
        ['A sentence the wiki deleted', 3],
        ['Usage', 1],
        [stubborn, 2],
      ]),
      extraction,
      new Map([['Usage', 'Uso']]),
    );
    expect([...kept]).toEqual([[stubborn, 2]]);
  });
});

describe('image captions', () => {
  const pictured: ArticleDoc = {
    lead: 'Boars live in the Meadows.',
    blocks: [{ kind: 'paragraph', section: 'Habitat', text: 'A boar in the Meadows' }],
    infobox: null,
    images: [
      { url: 'https://example.test/boar.png', alt: 'Boar.png', caption: 'A boar in the Meadows' },
      { url: 'https://example.test/tamed.png', alt: 'Tamed.png', caption: 'A tamed boar' },
      { url: 'https://example.test/plain.png', alt: 'Plain.png' },
    ],
    facets: {},
  };

  it('translates captions, reusing the text a caption repeats', () => {
    const extraction = extractStrings(pictured, 'Boar');
    expect(extraction.strings.filter((s) => s === 'A boar in the Meadows')).toHaveLength(1);
    expect(extraction.strings).toContain('A tamed boar');

    const { doc: out } = applyStrings(pictured, 'Boar', extraction, extraction.strings.map((s) => `ES:${s}`));
    expect(out.images.map((i) => i.caption)).toEqual(['ES:A boar in the Meadows', 'ES:A tamed boar', undefined]);
    // URLs and alt text are the English article's.
    expect(out.images.map((i) => i.url)).toEqual(pictured.images.map((i) => i.url));
    expect(pictured.images[1]!.caption).toBe('A tamed boar');
  });

  it('keeps the captions of a translation by image URL, and lays them over the English images', () => {
    const extraction = extractStrings(pictured, 'Boar');
    const { doc: out } = applyStrings(pictured, 'Boar', extraction, extraction.strings.map((s) => `ES:${s}`));
    const captions = captionsOf(out);
    expect(captions).toEqual({
      'https://example.test/boar.png': 'ES:A boar in the Meadows',
      'https://example.test/tamed.png': 'ES:A tamed boar',
    });
    expect(overlayCaptions(pictured.images, captions).map((i) => i.caption)).toEqual([
      'ES:A boar in the Meadows',
      'ES:A tamed boar',
      undefined,
    ]);
    expect(overlayCaptions(pictured.images, null)).toEqual(pictured.images);
    expect(captionsOf({ ...pictured, images: [] })).toBeNull();
  });

  it('stores only the captions that were translated, so a rewritten English one is never shadowed', () => {
    const extraction = extractStrings(pictured, 'Boar');
    // "A tamed boar" failed and is still in English.
    const values = extraction.strings.map((s) => (s === 'A tamed boar' ? null : `ES:${s}`));
    const { doc: out } = applyStrings(pictured, 'Boar', extraction, values);
    expect(captionsOf(out, pictured)).toEqual({ 'https://example.test/boar.png': 'ES:A boar in the Meadows' });

    // The wiki rewrites that caption; the page shows the new English one.
    const rewritten = pictured.images.map((i) => (i.caption === 'A tamed boar' ? { ...i, caption: 'A boar, tamed' } : i));
    expect(overlayCaptions(rewritten, captionsOf(out, pictured))[1]!.caption).toBe('A boar, tamed');
  });
});

describe('recovering the memory of an older translation', () => {
  it('pairs each English string with the text in the same place', () => {
    const extraction = extractStrings(doc, 'Iron Sword');
    const translated = applyStrings(doc, 'Iron Sword', extraction, extraction.strings.map((s) => `ES:${s}`));
    const memory = deriveMemory({ doc, title: 'Iron Sword' }, translated);

    expect(memory.size).toBe(extraction.strings.length);
    expect(memory.get('Crafting costs')).toBe('ES:Crafting costs');
    expect(memory.get('Durability')).toBe('ES:Durability');
  });

  it('merges a heading that was stored translated two ways', () => {
    // How /wiki/a/magic was stored: the gloss on the first block of each section only.
    const extraction = extractStrings(magic, 'Magic');
    const stored = applyStrings(magic, 'Magic', extraction, extraction.strings.map((s) => `ES:${s}`)).doc;
    stored.blocks[0]!.section = 'Magia > Magia elemental (Elemental Magic)';
    stored.blocks[1]!.section = 'Magia > Magia elemental';
    stored.blocks[2]!.section = 'Magia > Magia de sangre (Blood Magic)';
    stored.blocks[3]!.section = 'Magia > Magia de sangre';
    expect(headings(stored)).toHaveLength(4);

    const memory = deriveMemory({ doc: magic, title: 'Magic' }, { doc: stored, title: 'Magia' });
    const repaired = applyMemory(magic, 'Magic', memory);

    expect(headings(repaired.doc)).toEqual([
      'Magia > Magia elemental (Elemental Magic)',
      'Magia > Magia de sangre (Blood Magic)',
    ]);
    expect(repaired.pending).toBe(0);
  });

  it('leaves out places where the stored shape differs', () => {
    const stored = { ...structuredClone(doc), blocks: [] };
    const memory = deriveMemory({ doc, title: 'Iron Sword' }, { doc: stored, title: 'Espada de hierro' });
    expect(memory.has('Usage')).toBe(false);
    expect(memory.get('Iron Sword')).toBe('Espada de hierro');
    expect(applyMemory(doc, 'Iron Sword', memory).pending).toBeGreaterThan(0);
  });

  const forge: ArticleDoc = {
    lead: 'The forge is a crafting station.',
    blocks: [
      { kind: 'paragraph', section: 'Usage', text: 'Upgrade it with the anvils and the bellows.' },
      { kind: 'paragraph', section: 'Usage', text: 'It needs a roof to be used.' },
      { kind: 'table', section: 'Usage', caption: '', headers: ['Material', 'Total'], rows: [['Hildir', 'No']] },
    ],
    infobox: null,
    images: [{ url: 'https://example.test/forge.png', alt: 'Forge.png', caption: 'A forge' }],
    facets: {},
  };

  /** Stored the way a half-failed batch left it: the listed strings still in English. */
  function storedWith(english: string[]) {
    const extraction = extractStrings(forge, 'Forge');
    return applyStrings(forge, 'Forge', extraction, extraction.strings.map((s) => (english.includes(s) ? s : `ES:${s}`)));
  }

  it('does not take an English sentence stored unchanged for its translation', () => {
    const memory = deriveMemory({ doc: forge, title: 'Forge' }, storedWith(['It needs a roof to be used.']));
    expect(memory.has('It needs a roof to be used.')).toBe(false);
    expect(applyMemory(forge, 'Forge', memory).pending).toBeGreaterThan(0);
  });

  it('keeps a name, a value or a word the two languages share as its own translation', () => {
    // "Material", "Total", "No" and names read the same in Spanish: counted as
    // untranslated, 583 of 851 finished articles would have turned partial.
    const memory = deriveMemory({ doc: forge, title: 'Forge' }, storedWith(['Material', 'Total', 'Hildir', 'No']));
    expect(memory.get('Material')).toBe('Material');
    expect(memory.get('No')).toBe('No');
    expect(memory.get('Hildir')).toBe('Hildir');
  });

  it('never takes the English caption a stored translation shows for a translated one', () => {
    // Translations stored before captions were translated show the English
    // article's captions.
    const stored = storedWith([]);
    stored.doc.images = forge.images;
    const memory = deriveMemory({ doc: forge, title: 'Forge' }, stored);
    expect(memory.has('A forge')).toBe(false);
  });
});

describe('when a translation is shown', () => {
  it.each([
    [10, 0, true],
    [10, 5, true],
    [10, 6, false],
    [1, 1, false],
    [0, 0, true],
  ])('%i strings, %i still in English -> shown: %s', (total, pending, expected) => {
    // Half translated is the line, on every path that stores a translation.
    expect(isPublishable(total, pending)).toBe(expected);
  });
});

describe('who may ask for a translation', () => {
  const password = { kind: 'password' as const, profile: 'ana' };
  const byok = {
    kind: 'byok' as const,
    profile: 'byok:00000000-0000-4000-8000-000000000000',
    apiKey: 'k',
    model: 'gemini-3.5-flash-lite' as const,
  };

  it('counts a password session against its own allowance and everyone else against the public one', () => {
    expect(translationBuckets(password, '203.0.113.7', {}).map((b) => b.name)).toEqual([
      'translate:pw:ana',
      'translate:pw-global',
    ]);
    // A reader's own key pays for their chat, never for the shared wiki.
    for (const principal of [null, byok]) {
      expect(translationBuckets(principal, '203.0.113.7', {}).map((b) => b.name)).toEqual([
        'translate:public-ip:203.0.113.7',
        'translate:public-global',
      ]);
    }
  });

  it('tells a page in advance when translation is switched off for this reader', () => {
    const off = { PUBLIC_TRANSLATIONS_PER_DAY: '0' };
    expect(canRequestTranslation(null, off)).toBe(false);
    expect(canRequestTranslation(byok, off)).toBe(false);
    expect(canRequestTranslation(password, off)).toBe(true);
    expect(canRequestTranslation(null, {})).toBe(true);
  });
});

describe('importing translations made outside the chain', () => {
  const { strings } = extractStrings(doc, 'Iron Sword');
  const article = { doc, title: 'Iron Sword', memory: null };

  it('stores each translation under the English it was made from', () => {
    const result = mergeTranslations(article, { strings, translations: strings.map((s) => `ES:${s}`) });
    if (!result.ok) throw new Error('expected the import to apply');
    expect(result.applied.pending).toBe(0);
    expect(result.applied.title).toBe('ES:Iron Sword');
    expect(result.added).toBe(strings.length);
  });

  it('drops a string the article no longer has instead of shifting the rest', () => {
    const result = mergeTranslations(article, {
      strings: ['A sentence the wiki deleted', 'Iron Sword'],
      translations: ['Una frase borrada', 'Espada de hierro'],
    });
    expect(result).toMatchObject({ ok: true, added: 1, obsolete: 1 });
    if (result.ok) expect(result.applied.title).toBe('Espada de hierro');
  });

  it('refuses lists of different lengths whole', () => {
    expect(mergeTranslations(article, { strings, translations: ['uno'] })).toEqual({
      ok: false,
      reason: 'count_mismatch',
      translations: 1,
      strings: strings.length,
    });
    expect(mergeTranslations(article, { strings })).toEqual({ ok: false, reason: 'no_translations' });
  });

  it('pairs a hand-written file by position when it carries no strings', () => {
    const result = mergeTranslations(article, { translations: strings.map((s) => `ES:${s}`) });
    expect(result.ok && result.applied.pending).toBe(0);
  });

  it('clears the failure record of a string a person translated', () => {
    const result = mergeTranslations(
      { doc, title: 'Iron Sword', memory: null, failures: new Map([['Usage', 4], ['Notes', 2]]) },
      { strings: ['Usage'], translations: ['Uso'] },
    );
    if (!result.ok) throw new Error('expected the import to apply');
    expect([...result.failures]).toEqual([['Notes', 2]]);
  });

  it('adds to what is already remembered, and skips blank answers', () => {
    const memory = new Map([['Iron Sword', 'Espada de hierro']]);
    const result = mergeTranslations(
      { doc, title: 'Iron Sword', memory },
      { strings: ['Usage', 'Notes'], translations: ['Uso', '  '] },
    );
    if (!result.ok) throw new Error('expected the import to apply');
    expect(result.applied.memory.get('Iron Sword')).toBe('Espada de hierro');
    expect(result.applied.memory.get('Usage')).toBe('Uso');
    expect(result.applied.memory.has('Notes')).toBe(false);
  });
});
