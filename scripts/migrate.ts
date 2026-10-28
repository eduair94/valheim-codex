import './_env';
import { parseArgs } from 'node:util';
import { runMigrations } from '../src/lib/db/migrate';
import { openScriptDatabase } from './_db';

/**
 * Applies the migrations in drizzle/ that the database has not had yet.
 *
 *   DATABASE_URL='postgresql://owner…' pnpm db:migrate   # production, as the README says
 *   pnpm db:migrate --pglite .data/serve                  # a local copy
 *
 * The first statement is DDL, so which database it is goes through the same
 * rules as every other script (scripts/_db.ts): a DATABASE_URL that came from
 * .env.local needs --neon, and one set next to PGLITE_DATA_DIR stops the run.
 */

const argv = process.argv.slice(2);
const { values } = parseArgs({
  // pnpm 9 passes a literal `--` on: `pnpm db:migrate -- --neon`.
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    pglite: { type: 'string' },
    neon: { type: 'boolean', default: false },
  },
});

const handle = await openScriptDatabase(
  { pglite: values.pglite, neon: values.neon },
  { writes: true, lang: 'en', announce: (where) => console.log(`database: ${where}`) },
);
const ran = await runMigrations(handle);
console.log(ran.length === 0 ? 'already up to date' : `applied: ${ran.join(', ')}`);
await handle.close();
