import 'server-only';

import { logWarn } from '../log';
import { schema } from './schema';
import { createDb, rawQuery, type Db, type DbHandle } from './create-db';
import { installGracefulShutdown } from './shutdown';

type DbState = { handle: DbHandle | null; connecting: Promise<DbHandle> | null };

/**
 * The handle lives on `globalThis`, not in this module's scope.
 *
 * The dev server re-evaluates a module whenever something it imports changes.
 * With the handle in a module variable, the re-evaluated copy started with
 * none and opened the embedded database a second time, while the first
 * connection was still open and `dir-lock.ts` (not re-evaluated) still held
 * the directory: every database-backed route answered DatabaseLockedError
 * until the server was restarted. A handle opened by an earlier copy of this
 * module keeps the schema it was built with; restart after changing schema.ts.
 */
const STATE_KEY = Symbol.for('wiki-valheim.db');

function state(): DbState {
  const scope = globalThis as unknown as Record<symbol, DbState | undefined>;
  return (scope[STATE_KEY] ??= { handle: null, connecting: null });
}

/**
 * Process-wide database handle.
 *
 * Uses Neon when `DATABASE_URL` is set, and an embedded PGlite database under
 * `.data/pglite` otherwise, so `pnpm dev` works with no external service.
 */
export async function getDb(): Promise<Db> {
  const s = state();
  if (s.handle) return s.handle.db;
  /*
   * DATABASE_URL wins, so a local copy named in PGLITE_DATA_DIR is never
   * opened, and on a machine whose .env.local holds production's URL a server
   * started to serve that copy serves production instead. Said in the log
   * rather than refused: production sets only the URL.
   */
  if (!s.connecting && process.env.DATABASE_URL && process.env.PGLITE_DATA_DIR) {
    logWarn('db', 'DATABASE_URL is set, so PGLITE_DATA_DIR is ignored; blank DATABASE_URL to serve the local copy');
  }
  s.connecting ??= createDb({
    databaseUrl: process.env.DATABASE_URL || undefined,
    // Overridable so a build, a test run and a running ingest never contend
    // for the same embedded database: PGlite is single-process.
    pgliteDataDir: process.env.PGLITE_DATA_DIR || '.data/pglite',
  }).then(
    (h) => {
      s.handle = h;
      s.connecting = null;
      // Only the embedded driver has local state that a hard stop can corrupt.
      if (h.driver === 'pglite') installGracefulShutdown(() => closeDb());
      return h;
    },
    (error: unknown) => {
      // A failed attempt must not be replayed to every later caller: the
      // next request tries again.
      s.connecting = null;
      throw error;
    },
  );
  return (await s.connecting).db;
}

/** Closes the handle. Used by scripts and tests; a no-op if never opened. */
export async function closeDb(): Promise<void> {
  const s = state();
  const h = s.handle;
  s.handle = null;
  s.connecting = null;
  await h?.close();
}

export { schema, rawQuery };
export type { Db };
