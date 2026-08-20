import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { DbHandle } from './create-db';

const MIGRATIONS_DIR = 'drizzle';
const BREAKPOINT = '--> statement-breakpoint';

/**
 * Applies every `NNNN_*.sql` file in `drizzle/` that has not run yet.
 *
 * A hand-rolled runner rather than drizzle-kit's: the migrations are written by
 * hand (extension, generated column, HNSW index) and both drivers need the same
 * statement-at-a-time execution.
 */
export async function runMigrations(
  handle: Pick<DbHandle, 'db'>,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const { db } = handle;

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const appliedRows: unknown = await db.execute(sql`SELECT name FROM _migrations`);
  const rows: { name: string }[] = Array.isArray(appliedRows)
    ? (appliedRows as { name: string }[])
    : ((appliedRows as { rows: { name: string }[] }).rows ?? []);
  const applied = new Set(rows.map((r) => r.name));

  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const raw = await readFile(join(dir, file), 'utf8');
    const statements = raw
      .split(BREAKPOINT)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)*$/.test(s));

    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }
    await db.execute(sql`INSERT INTO _migrations (name) VALUES (${file})`);
    ran.push(file);
  }
  return ran;
}
