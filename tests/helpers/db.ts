import { createDb, type DbHandle } from '@/lib/db/create-db';
import { runMigrations } from '@/lib/db/migrate';

/** In-memory Postgres (PGlite + pgvector) with all migrations applied. */
export async function createTestDb(): Promise<DbHandle> {
  const handle = await createDb();
  await runMigrations(handle);
  return handle;
}
