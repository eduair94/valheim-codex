import { hostname } from 'node:os';
import { parseArgs as parseFlags } from 'node:util';
import type { Db, DbHandle } from '../src/lib/db/create-db';
import { acquireLease, type Lease, type QueueEntry } from '../src/lib/wiki/translate-store';
import { openScriptDatabase, type DatabaseFlags } from './_db';

/**
 * What the three translation scripts share: their flags, the database they
 * open, how a run picks articles from the queue, how it takes an article the
 * site may be translating at the same moment, and when it stops asking.
 */

/**
 * The database a run works on, said out loud, by the rules in `_db.ts`:
 * `--pglite <dir>` for a local copy, `--neon` for DATABASE_URL. Without
 * either, a DATABASE_URL that came from `.env.local` — production's, on the
 * operator's machine — is never written to unconfirmed, and one set next to
 * PGLITE_DATA_DIR stops the run instead of quietly winning, which is how a
 * rehearsal meant for a local copy used to land on production.
 */
export async function openDatabase(args: Args, { writes }: { writes: boolean }): Promise<DbHandle> {
  return openScriptDatabase(args.database(), {
    writes,
    lang: 'es',
    announce: (where) => console.log(`Base de datos: ${where}.`),
  });
}

/**
 * The pages a reader opens first, in the order to fill them in: the biomes,
 * the bosses, the crafting stations, the first creatures met, then the hub
 * pages. Every one of them was still in English on 2026-10-26.
 *
 * Named rather than derived, because no column says which pages matter: by
 * size they sit in the middle of the queue, behind hundreds of item stubs
 * (smallest first) or after four reference dumps that cost two hundred
 * requests between them (largest first).
 */
export const PRIORITY = [
  'meadows', 'black-forest', 'swamp', 'mountain', 'mistlands', 'ashlands',
  'eikthyr', 'the-elder', 'bonemass', 'moder', 'yagluth', 'the-queen', 'fader',
  'workbench', 'forge', 'black-forge', 'cauldron',
  'boar', 'greydwarf', 'troll', 'draugr', 'surtling',
  'weapons', 'armor', 'food', 'materials', 'creatures', 'mead', 'taming', 'portal',
];

type Flag = { type: 'string' } | { type: 'boolean'; short?: string };
/** The flags one script takes: anything else on its command line is an error. */
export type FlagTable = Record<string, Flag>;

/** What every translation script takes: the language, help, and which database (`_db.ts`). */
export const COMMON_FLAGS = {
  lang: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  pglite: { type: 'string' },
  neon: { type: 'boolean' },
} satisfies FlagTable;

/** How a script picks its articles from the queue. */
export const QUEUE_FLAGS = {
  limit: { type: 'string' },
  'max-strings': { type: 'string' },
  order: { type: 'string' },
  slugs: { type: 'string' },
  priority: { type: 'boolean' },
} satisfies FlagTable;

/** How fast a queue run asks, and how often it saves (`runPace`). */
export const PACE_FLAGS = {
  tpm: { type: 'string' },
  rpm: { type: 'string' },
  batch: { type: 'string' },
  chunk: { type: 'string' },
  concurrency: { type: 'string' },
} satisfies FlagTable;

/**
 * Tokens a minute a run spends unless told otherwise: half of what Groq's
 * free tier allows gpt-oss-120b, 8,000, on the key the site's chat answers
 * on too. The other half is a reader's question every minute — a rewrite and
 * an answer, three to four thousand tokens (models.ts).
 *
 * Chosen from the batches themselves. On the queue of 2026-10-28, 1,477
 * batches with a median of 32 strings, Groq counts a batch's prompt at about
 * 1,200 tokens, 2,100 at the 90th percentile, before its reply and gpt-oss's
 * reasoning come on top; black-forest's two batches, 75 strings, came to
 * 2,828 tokens on Gemini, which does not reason. At this budget a full batch
 * on Groq goes out about once a minute, and a short one sooner.
 *
 * Groq drains its minute continuously, as its refusals show: "Used 7742,
 * Requested 1963" was told to try again in 12.7875 s, the time it takes the
 * 1,705 tokens over the limit to drain at 8,000 a minute. Replayed on a
 * bucket like that, behind production's chain and with 2,000 tokens of
 * reasoning a batch, fifteen requests a minute (the old default) held Groq
 * near 9,900 tokens a minute, and a chat answer arriving during the run
 * could not get in within the ten seconds it can wait at 99% of the run's
 * seconds. At this budget the run held 4,350 a minute. The run takes twice
 * as long, and translates as much in a day: Groq's 200,000 tokens last under
 * an hour either way.
 *
 * The budget bounds the average, not one batch: right after a batch of T
 * tokens, Groq's minute holds T. Replayed on the real queue of 2026-10-28,
 * with the rewrite's tokens in the minute when the answer asks, a reader's
 * question always got in during a run in the default order, smallest first,
 * whose batches stay under 4,500 tokens. During a --priority run, whose prose
 * batches reach 6,500 to 8,500 tokens (1,000 to 3,000 of them reasoning), it
 * found no room in time at 3% to 10% of the run's seconds, right after the
 * largest batches. Smaller batches do not buy that back cheaply: at 2,000
 * characters a batch instead of 6,000, the priority run translated a fifth
 * to a quarter fewer strings in its day, and with 3,000 tokens of reasoning,
 * which no batch size touches, still found no room at 6% of the seconds. So
 * --priority, a run of some fifty minutes, once, is for a quiet hour of the
 * chat.
 */
export const TOKENS_PER_MINUTE = 4_000;

export type Pace = {
  /** Strings per request. */
  batchSize: number;
  /** Requests at once. */
  concurrency: number;
  /** Strings between saves. */
  chunk: number;
  /** Requests a minute; 0 for no spacing by requests. */
  rpm: number;
  /** Tokens a minute; 0 for no budget. */
  tpm: number;
};

/**
 * A queue run's pace, from its command line: --batch (strings per request,
 * 40), --concurrency (requests at once, 1), --tpm (tokens a minute,
 * `TOKENS_PER_MINUTE`), --rpm (requests a minute, no limit: the token budget
 * keeps a run far under every provider's) and --chunk (strings between
 * saves).
 *
 * On a token budget, a second request at once waits for what the first may
 * cost (`createPacer`), so more than one only speeds up a run with --tpm 0.
 *
 * Work is saved after every round of requests, --batch times --concurrency
 * strings, unless --chunk says otherwise; 0 saves once per article. Runs
 * used to save every 400 strings, ten batches, which took under two minutes
 * when a run never waited. Now that it waits out rate limits, ten batches
 * can be ten minutes of a run, and a Ctrl+C during a wait lost them all: up
 * to a quarter of Groq's day, in a replay of production's chain.
 */
export function runPace(args: Args): Pace {
  const batchSize = Math.max(1, Math.floor(args.count('batch', 40)));
  const concurrency = Math.max(1, Math.floor(args.count('concurrency', 1)));
  const chunk =
    args.flag('chunk') === undefined ? batchSize * concurrency : args.count('chunk', 0) || Number.POSITIVE_INFINITY;
  return { batchSize, concurrency, chunk, rpm: args.count('rpm', 0), tpm: args.count('tpm', TOKENS_PER_MINUTE) };
}

export type Args = {
  flag: (name: string) => string | undefined;
  has: (name: string) => boolean;
  /** A non-negative number, `fallback` when absent; a mistake otherwise. */
  count: (name: string, fallback: number) => number;
  /** `--priority`, `--slugs a,b,c`, or null for the whole queue. */
  slugs: () => string[] | null;
  order: () => 'smallest' | 'largest';
  /** `--pglite` and `--neon`, for `openDatabase`. */
  database: () => DatabaseFlags;
};

/** Prints a mistake on the command line with the script's usage, and exits. */
function exitWith(usage: string): (message: string) => never {
  return (message) => {
    console.error(`${message}\n\n${usage}`);
    process.exit(1);
  };
}

/**
 * The command line of one script, read strictly against its own `flags`.
 *
 * `--max-strings=20` and `--max-strings 20` both work. Everything that is not
 * one of the script's flags is a mistake, and so is a value given to a switch
 * or one missing after a flag that needs it. These used to be skipped without
 * a word: `--dry-run=true` and `--dryrun` ran for real, `--max-strings=20` ran
 * uncapped, `--slugs=meadows` translated the whole queue, and a flag from
 * another script was simply ignored.
 *
 * `onError` exits by default; a test passes one that throws.
 */
export function parseArgs(
  argv: string[],
  flags: FlagTable,
  usage: string,
  onError: (message: string) => never = exitWith(usage),
): Args {
  // pnpm 9 passes a literal `--` on: `pnpm translate:es -- --dry-run`.
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let values: Record<string, unknown> = {};
  try {
    values = parseFlags({ args, options: flags, strict: true, allowPositionals: false }).values;
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }

  const flag = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === 'string' ? value : undefined;
  };
  const has = (name: string): boolean => values[name] !== undefined && values[name] !== false;

  return {
    flag,
    has,
    count: (name, fallback) => {
      const raw = flag(name);
      if (raw === undefined) return fallback;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : onError(`--${name} espera un número, no "${raw}".`);
    },
    slugs: () => {
      const raw = flag('slugs');
      if (has('priority')) {
        return raw === undefined ? PRIORITY : onError('--priority y --slugs eligen los artículos cada uno a su manera; pasá uno solo.');
      }
      if (raw === undefined) return null;
      const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
      return list.length > 0 ? list : onError('--slugs espera una lista separada por comas.');
    },
    order: () => {
      const raw = flag('order') ?? 'smallest';
      return raw === 'smallest' || raw === 'largest' ? raw : onError(`--order es smallest o largest, no "${raw}".`);
    },
    database: () => ({ pglite: flag('pglite'), neon: has('neon') }),
  };
}

/**
 * The queue a run works through: all of it in queue order, or the named
 * slugs in the order given. Named slugs with nothing pending are reported, so
 * a typo is not mistaken for a page already done.
 */
export function pickQueue(queue: QueueEntry[], slugs: string[] | null): { entries: QueueEntry[]; idle: string[] } {
  if (!slugs) return { entries: queue, idle: [] };
  const bySlug = new Map(queue.map((entry) => [entry.slug, entry]));
  return {
    entries: slugs.flatMap((slug) => bySlug.get(slug) ?? []),
    idle: slugs.filter((slug) => !bySlug.has(slug)),
  };
}

/**
 * Why a run stopped before the end of its queue: the providers' budget
 * spent, answers that are no use, no answer at all, or rate limits that
 * outlasted every wait — an outage to the run, but one a quieter hour cures.
 */
export type StopReason = 'exhausted' | 'idle' | 'unavailable' | 'rate-limited';

/**
 * Articles in a row that were sent strings never tried before, were
 * answered, and got none translated: a provider problem — a model that
 * replies in prose, say — not that many bad articles.
 */
export const MAX_IDLE_ARTICLES = 3;

/**
 * Articles in a row that ended on an outage and translated nothing: requests
 * no provider answered, at least a minute apart, two of them in a row — the
 * second article's first request is already the second, since the count
 * runs across articles. An outage, or a rate limit that outlasts every wait,
 * which more requests only wait out.
 */
export const MAX_DOWN_ARTICLES = 2;

/** What one article's run says about the providers. */
export type ArticleOutcome = {
  translated: number;
  /** Requests a provider answered, usably or not, or replied to before saying to wait. */
  answered: number;
  /** Strings sent that had never failed before. */
  freshSent: number;
  exhausted: boolean;
  /** Requests no provider answered ended the article (`TranslationRun.outage`). */
  outage: boolean;
  /** The last request no provider answered was refused for the minute, by a provider that is up. */
  rateLimited: boolean;
};

/** Articles in a row that came back idle, and that no provider answered. */
export type Streaks = { idle: number; down: number };

/**
 * Whether a run goes on after an article, and the streaks it carries to the
 * next one: README.md's promise that a run "stops when the free tier runs out
 * [exhausted], when no provider answers for two articles in a row [down], or
 * after three articles that yield nothing usable [idle]". Down articles whose
 * last word was a rate limit that outlasted every wait stop the run as
 * 'rate-limited', so the operator is told to try a quieter hour rather than
 * to look for an outage.
 *
 * Down is an article that ended on an outage, whatever was paid for before
 * it. Counted by its answers, an article whose provider replied badly and
 * then kept saying to wait passed for one whose answers are no use, and
 * three of them stopped the run telling the operator to check the model.
 *
 * An article whose only strings left are ones that failed before is neither
 * progress nor a sign of trouble. It is retried once per run, and expected to
 * fail again; counted as idle, three such articles — and smallest first, they
 * gather at the head of the queue, since everything around them gets
 * finished — stopped every run before it reached a single article that could
 * still be translated, while the message blamed the providers.
 */
export function afterArticle(streaks: Streaks, outcome: ArticleOutcome): { streaks: Streaks; stop: StopReason | null } {
  if (outcome.exhausted) return { streaks, stop: 'exhausted' };
  if (outcome.translated > 0) return { streaks: { idle: 0, down: 0 }, stop: null };
  if (outcome.outage) {
    const down = streaks.down + 1;
    const stop = down < MAX_DOWN_ARTICLES ? null : outcome.rateLimited ? 'rate-limited' : 'unavailable';
    return { streaks: { ...streaks, down }, stop };
  }
  // Whatever answered is up, however useless the answer.
  const down = outcome.answered > 0 ? 0 : streaks.down;
  if (outcome.freshSent === 0) return { streaks: { ...streaks, down }, stop: null };
  const idle = streaks.idle + 1;
  return { streaks: { idle, down }, stop: idle >= MAX_IDLE_ARTICLES ? 'idle' : null };
}

/**
 * How long a script's lease on an article lasts without being renewed. Each
 * saved chunk renews it, and a chunk is a round of requests (`runPace`): a
 * minute or two, and a few more when no provider answers and the run waits
 * to ask again. So this only matters for a run that died: the article is
 * free again for the site a quarter of an hour later. A chunk that outlasts
 * it anyway finds its save refused, and the site's work stands.
 */
export const SCRIPT_LEASE_MS = 15 * 60 * 1000;

/** The site's lease outlives its 75-second requests by a little; waiting that long is enough. */
const WAIT_FOR_SITE_MS = 150_000;

/** This run, as a lease holder: one name for every article it takes. */
export const scriptHolder = `script:${hostname()}:${process.pid}`;

/**
 * Takes an article for this run, waiting while the site is translating it —
 * a reader's request holds it for a minute or two at most. `held` only when
 * it is still taken after that.
 */
export async function leaseForScript(db: Db, job: { pageKey: string; slug: string }, lang: string): Promise<Lease> {
  const until = Date.now() + WAIT_FOR_SITE_MS;
  for (let first = true; ; first = false) {
    const lease = await acquireLease(db, { pageKey: job.pageKey, lang, holder: scriptHolder, ttlMs: SCRIPT_LEASE_MS });
    if (lease.kind !== 'held' || Date.now() >= until) return lease;
    if (first) console.log(`  ${job.slug.padEnd(34)} el sitio lo está traduciendo; espero a que termine…`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
