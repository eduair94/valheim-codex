import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryError } from 'ai';
import {
  applyMemory,
  applyStrings,
  captionsOf,
  createPacer,
  deriveMemory,
  extractStrings,
  isIdentifierRow,
  isPublishable,
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
import type * as Provider from '@/lib/rag/provider';
import { garbage, mockTranslator, refusal, spanish, unavailable } from '../helpers/mock-translator';

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

  it('stops at the first request every provider refuses, keeping what came before', async () => {
    const mock = mockTranslator((batch, call) => (call === 0 ? spanish(batch, call) : refusal(429)));
    const run = await translateStrings(strings, 'es', { batchSize: 4, candidates: mock.candidates });

    // No third batch, and the refused one is not halved: the budget is gone.
    expect(mock.calls).toHaveLength(2);
    expect(run.exhausted).toBe(true);
    expect(run.translations.slice(0, 4)).toEqual(es(strings.slice(0, 4)));
    expect(run.skipped).toBe(6);
    expect(run.failed).toBe(0);
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
    expect(run).toMatchObject({ requests: 2, answered: 0 });
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
    expect(run).toMatchObject({ failed: 0, skipped: 4, unavailable: false, answered: 2 });
  });

  it('counts a reply that is not the list asked for, and one of the wrong length, as answered', async () => {
    const mock = mockTranslator((batch, call) => (call === 0 ? garbage() : spanish(batch.slice(1), call)));
    const run = await translateStrings(strings.slice(0, 2), 'es', { batchSize: 2, candidates: mock.candidates });
    // The unparseable reply is halved; each half comes back one short.
    expect(mock.calls.map((c) => c.length)).toEqual([2, 1, 1]);
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
