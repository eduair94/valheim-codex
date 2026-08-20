import 'server-only';

import { schema } from './schema';
import { createDb, rawQuery, type Db, type DbHandle } from './create-db';
import { installGracefulShutdown } from './shutdown';

let handle: DbHandle | null = null;
let connecting: Promise<DbHandle> | null = null;

/**
 * Process-wide database handle.
 *
 * Uses Neon when `DATABASE_URL` is set, and an embedded PGlite database under
 * `.data/pglite` otherwise, so `pnpm dev` works with no external service.
 */
export async function getDb(): Promise<Db> {
  if (handle) return handle.db;
  connecting ??= createDb({
    databaseUrl: process.env.DATABASE_URL || undefined,
    // Overridable so a build, a test run and a running ingest never contend
    // for the same embedded database: PGlite is single-process.
    pgliteDataDir: process.env.PGLITE_DATA_DIR || '.data/pglite',
  }).then((h) => {
    handle = h;
    connecting = null;
    // Only the embedded driver has local state that a hard stop can corrupt.
    if (h.driver === 'pglite') installGracefulShutdown(() => closeDb());
    return h;
  });
  return (await connecting).db;
}

/** Closes the handle. Used by scripts and tests; a no-op if never opened. */
export async function closeDb(): Promise<void> {
  const h = handle;
  handle = null;
  connecting = null;
  await h?.close();
}

export { schema, rawQuery };
export type { Db };
