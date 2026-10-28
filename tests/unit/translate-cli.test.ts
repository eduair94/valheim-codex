import { describe, expect, it } from 'vitest';
import {
  afterArticle,
  COMMON_FLAGS,
  parseArgs,
  PRIORITY,
  QUEUE_FLAGS,
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
  'dry-run': { type: 'boolean' },
  rebuild: { type: 'boolean' },
  rpm: { type: 'string' },
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

describe('when a run stops asking (IT-1, IT-2)', () => {
  const outcome = (o: Partial<ArticleOutcome> = {}): ArticleOutcome => ({
    translated: 0,
    answered: 1,
    freshSent: 1,
    exhausted: false,
    unavailable: false,
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
  const down = outcome({ answered: 0, unavailable: true });

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
});
