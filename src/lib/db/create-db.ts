import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { schema } from './schema';

export type DbHandle = {
  db: PgDatabase<PgQueryResultHKT, typeof schema>;
  driver: 'neon' | 'pglite';
  close: () => Promise<void>;
};

export type CreateDbOptions = {
  /** Neon connection string. When absent, an embedded PGlite database is used. */
  databaseUrl?: string;
  /** Directory for the embedded database. Omit for an in-memory instance (tests). */
  pgliteDataDir?: string;
};

/**
 * Builds a database handle for whichever driver the environment calls for.
 *
 * Kept free of `server-only` so the ingest script, the migrator and the test
 * suite can all use it outside the Next.js runtime.
 */
export async function createDb(options: CreateDbOptions = {}): Promise<DbHandle> {
  if (options.databaseUrl) {
    const [{ neon }, { drizzle }] = await Promise.all([
      import('@neondatabase/serverless'),
      import('drizzle-orm/neon-http'),
    ]);
    const client = neon(options.databaseUrl);
    const db = drizzle(client, { schema });
    return {
      db: db as unknown as DbHandle['db'],
      driver: 'neon',
      // The HTTP driver is stateless; there is no connection to release.
      close: async () => {},
    };
  }

  const [{ PGlite }, { vector }, { drizzle }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite-pgvector'),
    import('drizzle-orm/pglite'),
  ]);

  // An on-disk PGlite database must be opened by one process at a time; the
  // lock also creates the directory, which PGlite itself will not do.
  let releaseLock: (() => Promise<void>) | null = null;
  if (options.pgliteDataDir) {
    const { acquireDirLock } = await import('./dir-lock');
    releaseLock = await acquireDirLock(options.pgliteDataDir);
  }

  try {
    const client = options.pgliteDataDir
      ? new PGlite(options.pgliteDataDir, { extensions: { vector } })
      : new PGlite({ extensions: { vector } });

    await client.waitReady;
    const db = drizzle(client, { schema });

    return {
      db: db as unknown as DbHandle['db'],
      driver: 'pglite',
      close: async () => {
        await client.close();
        await releaseLock?.();
      },
    };
  } catch (error) {
    await releaseLock?.();
    throw error;
  }
}

/**
 * The narrowest Drizzle type both the Neon and the PGlite driver satisfy.
 * Query code is written against this, so swapping drivers cannot change it.
 */
export type Db = DbHandle['db'];

type RowShaped = { rows: unknown[] };

function hasRows(value: unknown): value is RowShaped {
  return typeof value === 'object' && value !== null && Array.isArray((value as RowShaped).rows);
}

/**
 * Runs raw SQL and returns plain rows.
 *
 * `db.execute()` resolves to `{ rows }` on the Neon driver but to a bare array
 * on others; normalising here keeps the retrieval query driver agnostic.
 */
export async function rawQuery<T>(db: Db, query: SQL): Promise<T[]> {
  const result: unknown = await db.execute(query);
  if (hasRows(result)) return result.rows as T[];
  if (Array.isArray(result)) return result as T[];
  return [];
}
