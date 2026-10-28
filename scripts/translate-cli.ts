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

/** Why a run stopped before the end of its queue. */
export type StopReason = 'exhausted' | 'idle' | 'unavailable';

/**
 * Articles in a row that were sent strings never tried before, were
 * answered, and got none translated: a provider problem — a model that
 * replies in prose, say — not that many bad articles.
 */
export const MAX_IDLE_ARTICLES = 3;

/** Articles in a row no provider answered at all: an outage, which more requests only wait out. */
export const MAX_DOWN_ARTICLES = 2;

/** What one article's run says about the providers. */
export type ArticleOutcome = {
  translated: number;
  /** Requests a provider answered, usably or not. */
  answered: number;
  /** Strings sent that had never failed before. */
  freshSent: number;
  exhausted: boolean;
  unavailable: boolean;
};

/** Articles in a row that came back idle, and that no provider answered. */
export type Streaks = { idle: number; down: number };

/**
 * Whether a run goes on after an article, and the streaks it carries to the
 * next one.
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
  if (outcome.answered === 0 && outcome.unavailable) {
    const down = streaks.down + 1;
    return { streaks: { ...streaks, down }, stop: down >= MAX_DOWN_ARTICLES ? 'unavailable' : null };
  }
  // Whatever answered is up, however useless the answer.
  const down = outcome.answered > 0 ? 0 : streaks.down;
  if (outcome.freshSent === 0) return { streaks: { ...streaks, down }, stop: null };
  const idle = streaks.idle + 1;
  return { streaks: { idle, down }, stop: idle >= MAX_IDLE_ARTICLES ? 'idle' : null };
}

/**
 * How long a script's lease on an article lasts without being renewed. Each
 * saved chunk renews it, and a chunk of 400 strings at 15 requests a minute
 * takes under two minutes, so this only matters for a run that died: the
 * article is free again for the site a quarter of an hour later.
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
