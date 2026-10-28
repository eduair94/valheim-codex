import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { createDb, type DbHandle } from '../src/lib/db/create-db';

/**
 * Which database a script works on, chosen out loud.
 *
 * Scripts read `.env.local`, then `.env` (`_env.ts`), and dotenv fills in
 * every variable the shell left unset. On an operator's machine `.env.local`
 * holds production's DATABASE_URL, and the old rule — DATABASE_URL when set,
 * PGLITE_DATA_DIR otherwise — let it reach runs meant for a local copy:
 * `PGLITE_DATA_DIR=<copy> pnpm translate:es --rebuild` rewrote production,
 * because PGLITE_DATA_DIR was never even read. PowerShell leaves no way out:
 * `$env:DATABASE_URL = ''` deletes the variable, and the file fills it in
 * again. And `.env.development.local`, which points `next dev` at a
 * disposable copy, is not read by scripts at all.
 *
 * So the choice is never left to chance:
 *
 *   - `--pglite <dir>` works on that local copy, whatever else is set;
 *   - `--neon` works on DATABASE_URL, whatever else is set;
 *   - with neither, DATABASE_URL and PGLITE_DATA_DIR both set is a question
 *     only the person running the script can answer, and nothing runs;
 *   - a DATABASE_URL that came from a file may be read, but a run that writes
 *     to it asks for `--neon` first. One given in the environment — the
 *     scheduled workflow's secret, `DATABASE_URL='…' pnpm db:migrate` — is a
 *     choice already made, and works as it always did;
 *   - otherwise PGLITE_DATA_DIR, or `.data/pglite`.
 *
 * Only the host is ever printed, never the credentials the URL carries.
 */

export type DatabaseFlags = { pglite?: string; neon?: boolean };

/** Where a variable's value came from: the shell, or the dotenv file that filled it in. */
export type EnvSource = 'environment' | '.env.local' | '.env';

export type DatabaseTarget =
  | { driver: 'neon'; url: string; host: string; from: EnvSource }
  | { driver: 'pglite'; dir: string };

type Lang = 'es' | 'en';

/** A choice the script cannot make for the person running it. Its message says what to pass. */
export class DatabaseChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseChoiceError';
  }
}

/** The files `_env.ts` loads, in its order: the first that defines a variable is the one that sets it. */
const DOTENV_FILES = ['.env.local', '.env'] as const;

function readDotenv(file: string, cwd: string): Record<string, string> {
  try {
    return parse(readFileSync(resolve(cwd, file)));
  } catch {
    return {};
  }
}

/**
 * Where the value a variable has now came from, or null when it is unset or
 * empty. dotenv never overwrites what the shell set, so a value that differs
 * from the first file defining the variable is the shell's. One equal to it
 * counts as the file's: the two cannot be told apart, and the file is the one
 * to be careful with.
 */
export function envSource(
  key: string,
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): EnvSource | null {
  const value = env[key];
  if (!value) return null;
  for (const file of DOTENV_FILES) {
    const parsed = readDotenv(file, cwd);
    if (key in parsed) return parsed[key] === value ? file : 'environment';
  }
  return 'environment';
}

/** The host a database URL names: which database, without how to get into it. */
export function databaseHost(url: string): string {
  try {
    return new URL(url).host || '(no host)';
  } catch {
    return '(an unreadable URL)';
  }
}

const MESSAGES = {
  en: {
    from: (from: EnvSource) => (from === 'environment' ? 'from the environment' : `from ${from}`),
    neon: (host: string, from: string) => `Neon at ${host} (DATABASE_URL ${from})`,
    pglite: (dir: string) => `PGlite at ${dir}`,
    bothFlags: '--pglite and --neon name two different databases; pass one of them.',
    pgliteNeedsDir: '--pglite needs the directory of a local copy.',
    neonNeedsUrl: '--neon works on DATABASE_URL, which is not set.',
    ambiguous: (host: string, from: string, dir: string) =>
      `DATABASE_URL (${from}: ${host}) and PGLITE_DATA_DIR (${dir}) are both set. A script would use ` +
      'DATABASE_URL and ignore PGLITE_DATA_DIR, so nothing runs until you choose:\n' +
      `pass --pglite ${dir} for the local copy, or --neon for ${host}.`,
    confirm: (host: string, file: string) =>
      `DATABASE_URL comes from ${file} and names ${host}, and this run writes to it.\n` +
      'Pass --neon to confirm, or --pglite <dir> to work on a local copy instead.',
    fileHint: (file: string) =>
      `\n(${file} fills DATABASE_URL in whenever the shell leaves it unset; ` +
      "in PowerShell, $env:DATABASE_URL = '' does exactly that.)",
  },
  es: {
    from: (from: EnvSource) => (from === 'environment' ? 'del entorno' : `de ${from}`),
    neon: (host: string, from: string) => `Neon en ${host} (DATABASE_URL ${from})`,
    pglite: (dir: string) => `PGlite en ${dir}`,
    bothFlags: '--pglite y --neon apuntan a dos bases distintas; pasá una sola.',
    pgliteNeedsDir: '--pglite necesita el directorio de una copia local.',
    neonNeedsUrl: '--neon trabaja sobre DATABASE_URL, que no está definida.',
    ambiguous: (host: string, from: string, dir: string) =>
      `Están definidas DATABASE_URL (${from}: ${host}) y PGLITE_DATA_DIR (${dir}). Un script usaría ` +
      'DATABASE_URL e ignoraría PGLITE_DATA_DIR, así que no se hace nada hasta que elijas:\n' +
      `pasá --pglite ${dir} para la copia local, o --neon para ${host}.`,
    confirm: (host: string, file: string) =>
      `DATABASE_URL viene de ${file} y apunta a ${host}, y esta corrida escribe ahí.\n` +
      'Pasá --neon para confirmarlo, o --pglite <dir> para trabajar sobre una copia local.',
    fileHint: (file: string) =>
      `\n(${file} completa DATABASE_URL cada vez que la terminal la deja sin definir; ` +
      "en PowerShell, $env:DATABASE_URL = '' hace justamente eso.)",
  },
} as const;

/**
 * The database a run works on, by the rules above. Throws a
 * DatabaseChoiceError, whose message says what to pass, when the flags and
 * the environment leave it open.
 */
export function chooseDatabase(input: {
  flags: DatabaseFlags;
  env: Record<string, string | undefined>;
  /** Where DATABASE_URL came from (`envSource`). */
  urlFrom: EnvSource | null;
  /** Whether the run writes. One that only reads may use a URL from a file without `--neon`. */
  writes: boolean;
  lang: Lang;
}): DatabaseTarget {
  const { flags, env, writes } = input;
  const m = MESSAGES[input.lang];
  const url = env.DATABASE_URL || undefined;
  const dir = env.PGLITE_DATA_DIR || undefined;
  const from = input.urlFrom ?? 'environment';

  if (flags.pglite !== undefined && flags.neon) throw new DatabaseChoiceError(m.bothFlags);
  if (flags.pglite !== undefined) {
    if (flags.pglite.trim() === '') throw new DatabaseChoiceError(m.pgliteNeedsDir);
    return { driver: 'pglite', dir: flags.pglite };
  }
  if (flags.neon) {
    if (!url) throw new DatabaseChoiceError(m.neonNeedsUrl);
    return { driver: 'neon', url, host: databaseHost(url), from };
  }
  if (url) {
    const host = databaseHost(url);
    const hint = from === 'environment' ? '' : m.fileHint(from);
    if (dir) throw new DatabaseChoiceError(m.ambiguous(host, m.from(from), dir) + hint);
    if (writes && from !== 'environment') throw new DatabaseChoiceError(m.confirm(host, from) + hint);
    return { driver: 'neon', url, host, from };
  }
  return { driver: 'pglite', dir: dir ?? '.data/pglite' };
}

/** One line saying which database, for a script to print before it opens it. */
export function describeDatabase(target: DatabaseTarget, lang: Lang): string {
  const m = MESSAGES[lang];
  return target.driver === 'neon' ? m.neon(target.host, m.from(target.from)) : m.pglite(target.dir);
}

/**
 * Chooses the database (`chooseDatabase`), says which (`announce`, before
 * anything is opened, so a failure to connect still says where), and opens
 * it. A choice it cannot make prints what to pass and exits.
 */
export async function openScriptDatabase(
  flags: DatabaseFlags,
  options: { writes: boolean; lang: Lang; announce: (where: string) => void },
): Promise<DbHandle> {
  let target: DatabaseTarget;
  try {
    target = chooseDatabase({
      flags,
      env: process.env,
      urlFrom: envSource('DATABASE_URL'),
      writes: options.writes,
      lang: options.lang,
    });
  } catch (error) {
    if (!(error instanceof DatabaseChoiceError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
  options.announce(describeDatabase(target, options.lang));
  return createDb(target.driver === 'neon' ? { databaseUrl: target.url } : { pgliteDataDir: target.dir });
}
