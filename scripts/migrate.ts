import './_env';
import { createDb } from '../src/lib/db/create-db';
import { runMigrations } from '../src/lib/db/migrate';

const handle = await createDb({
  databaseUrl: process.env.DATABASE_URL || undefined,
  pgliteDataDir: process.env.DATABASE_URL ? undefined : process.env.PGLITE_DATA_DIR || '.data/pglite',
});

console.log(`driver: ${handle.driver}`);
const ran = await runMigrations(handle);
console.log(ran.length === 0 ? 'already up to date' : `applied: ${ran.join(', ')}`);
await handle.close();
