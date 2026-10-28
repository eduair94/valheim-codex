import { describe, expect, it } from 'vitest';
import {
  afterArticle,
  COMMON_FLAGS,
  PACE_FLAGS,
  parseArgs,
  PRIORITY,
  QUEUE_FLAGS,
  runPace,
  type ArticleOutcome,
  type FlagTable,
  type StopReason,
  type Streaks,
} from '../../scripts/translate-cli';

/**
 * The bulk translation scripts' command line, and the rule that decides when
 * `pnpm translate:es` stops asking the providers.
 */

/** The flags of `pnpm translate:es`. */
const CORPUS: FlagTable = {
  ...COMMON_FLAGS,
  ...QUEUE_FLAGS,
  ...PACE_FLAGS,
  'dry-run': { type: 'boolean' },
  rebuild: { type: 'boolean' },
};

const read = (argv: string[], flags: FlagTable = CORPUS) =>
  parseArgs(argv, flags, 'usage', (message) => {
    throw new Error(message);
  });

describe('the translation scripts’ command line (IT-4)', () => {
  it('reads --name=value as well as --name value', () => {
    const args = read(['--max-strings=20', '--slugs=meadows,forge', '--limit', '2', '--dry-run']);
    expect(args.count('max-strings', 0)).toBe(20);
    expect(args.slugs()).toEqual(['meadows', 'forge']);
    expect(args.count('limit', 0)).toBe(2);
    expect(args.has('dry-run')).toBe(true);
    expect(args.has('rebuild')).toBe(false);
  });

  it.each([
    [['--dry-run=true'], 'a value given to a switch'],
    [['--dryrun'], 'a misspelt flag'],
    [['--priorty'], 'a misspelt flag'],
    [['--out', 'batch.json'], 'another script’s flag'],
    [['--limit'], 'a flag missing its value'],
    [['--limit', '--dry-run'], 'a flag whose value looks like another flag'],
    [['meadows'], 'a stray word'],
  ])('refuses %j (%s) rather than running with defaults', (argv) => {
    expect(() => read(argv)).toThrow();
  });

  it('still takes the `--` pnpm passes on', () => {
    expect(read(['--', '--dry-run']).has('dry-run')).toBe(true);
  });

  it('refuses --priority together with --slugs, and a number that is not one', () => {
    expect(read(['--priority']).slugs()).toBe(PRIORITY);
    expect(() => read(['--priority', '--slugs', 'forge']).slugs()).toThrow('--priority');
    expect(() => read(['--limit', 'ten']).count('limit', 0)).toThrow('--limit espera un número');
  });

  it('hands the database flags over', () => {
    expect(read(['--pglite', '.data/copy']).database()).toEqual({ pglite: '.data/copy', neon: false });
    expect(read(['--neon']).database()).toEqual({ pglite: undefined, neon: true });
  });
});

describe('how fast a run asks, and how often it saves', () => {
  it('spends half of Groq’s minute by default, and saves after every round of requests', () => {
    // The chat runs on the same key: a run left alone keeps the other half,
    // four thousand tokens, a question's worth, for readers.
    expect(runPace(read([]))).toEqual({ batchSize: 40, concurrency: 1, chunk: 40, rpm: 0, tpm: 4_000 });
  });

  it('saves one round of requests at a time whatever their size, unless told otherwise', () => {
    expect(runPace(read(['--batch', '20', '--concurrency', '2']))).toMatchObject({ chunk: 40 });
    expect(runPace(read(['--chunk', '400']))).toMatchObject({ chunk: 400 });
    // Zero is "one save at the end of each article", as before.
    expect(runPace(read(['--chunk', '0']))).toMatchObject({ chunk: Number.POSITIVE_INFINITY });
  });

  it('takes a token budget, requests a minute, or neither', () => {
    expect(runPace(read(['--tpm', '6000', '--rpm', '15']))).toMatchObject({ tpm: 6_000, rpm: 15 });
    expect(runPace(read(['--tpm', '0']))).toMatchObject({ tpm: 0, rpm: 0 });
    expect(() => runPace(read(['--tpm', 'lots']))).toThrow('--tpm espera un número');
  });
});

describe('when a run stops asking (IT-1, IT-2)', () => {
  const outcome = (o: Partial<ArticleOutcome> = {}): ArticleOutcome => ({
    translated: 0,
    answered: 1,
    freshSent: 1,
    exhausted: false,
    outage: false,
    rateLimited: false,
    ...o,
  });

  /** The stop after each article, in turn. */
  function drive(outcomes: ArticleOutcome[]): (StopReason | null)[] {
    let streaks: Streaks = { idle: 0, down: 0 };
    return outcomes.map((o) => {
      const next = afterArticle(streaks, o);
      streaks = next.streaks;
      return next.stop;
    });
  }

  const idle = outcome();
  const stuck = outcome({ freshSent: 0 });
  const down = outcome({ answered: 0, outage: true });

  it('stops at the first article every provider refused, translated or not', () => {
    expect(drive([outcome({ exhausted: true, translated: 4 })])).toEqual(['exhausted']);
  });

  it('counts an article with only old failures left as neither progress nor trouble', () => {
    expect(drive([stuck, stuck, stuck, stuck, stuck]).every((stop) => stop === null)).toBe(true);
    // Nor do they hide a real streak: they neither add to it nor end it.
    expect(drive([idle, stuck, idle, stuck, idle])).toEqual([null, null, null, null, 'idle']);
  });

  it('stops after three articles that were sent new strings and got none back', () => {
    expect(drive([idle, idle, outcome({ translated: 1 }), idle, idle, idle])).toEqual([
      null,
      null,
      null,
      null,
      null,
      'idle',
    ]);
  });

  it('stops after two articles no provider answered, and any answer ends that streak', () => {
    expect(drive([down, down])).toEqual([null, 'unavailable']);
    expect(drive([down, stuck, down])).toEqual([null, null, null]);
    // An outage is not a sign the answers are bad.
    expect(drive([idle, idle, down, idle])).toEqual([null, null, null, 'idle']);
  });

  it('says when it was rate limits that outlasted every wait, rather than silence', () => {
    // Something else is spending the same minute — the site's chat, most
    // likely — which calls for a quieter hour, not for checking the network.
    const limited = outcome({ answered: 0, outage: true, rateLimited: true });
    expect(drive([down, limited])).toEqual([null, 'rate-limited']);
    expect(drive([limited, down])).toEqual([null, 'unavailable']);
  });

  it('counts an article that ended on an outage as down, though a provider replied badly before it went quiet', () => {
    // Groq's reply failed its check, and its retries met a busy minute: the
    // reply was paid for, but nothing answered after it. Scored as answers
    // that are no use, three such articles stopped the run blaming the model.
    const limited = outcome({ answered: 1, outage: true, rateLimited: true });
    expect(drive([limited, limited, limited])).toEqual([null, 'rate-limited', 'rate-limited']);
  });

  it('counts an article that translated something before its outage as progress', () => {
    // The next article asks again after the wait, and it is that one which
    // tells whether the providers are still down.
    expect(drive([down, outcome({ translated: 2, outage: true }), down])).toEqual([null, null, null]);
  });
});
