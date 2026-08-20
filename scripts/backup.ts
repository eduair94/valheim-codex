import './_env';
import { cp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

/**
 * Copies the embedded database aside, or restores it.
 *
 * PGlite's data directory does not survive a force-kill: it aborts on the next
 * open with no repair path, and rebuilding it means re-downloading and
 * re-embedding the whole wiki. A copy after a successful ingest turns that from
 * six minutes into two seconds.
 *
 * Take the backup while nothing holds the database, or the copy captures a
 * half-written state.
 */
const { values } = parseArgs({
  options: {
    restore: { type: 'boolean', default: false },
    dir: { type: 'string', default: process.env.PGLITE_DATA_DIR || '.data/pglite' },
    to: { type: 'string', default: '.data/pglite-backup' },
  },
});

const { dir, to, restore } = values as { dir: string; to: string; restore: boolean };

if (restore) {
  if (!existsSync(to)) {
    console.error(`No backup at ${to}. Run \`pnpm db:backup\` after an ingest.`);
    process.exit(1);
  }

  /*
   * Windows keeps file handles open for a moment after a process is killed, so
   * deleting and re-copying immediately afterwards can leave a directory that
   * is half old and half new — which opens once and then aborts. Retrying the
   * delete until it succeeds is what makes restore reliable right after a hard
   * stop, which is exactly when it is needed.
   */
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  await cp(to, dir, { recursive: true });
  // The lock belongs to whichever process held the source; it must not travel.
  await rm(`${dir}/.wv-lock`, { force: true });

  // Prove the restored copy actually opens, rather than reporting success and
  // failing on the next start.
  const { createDb } = await import('../src/lib/db/create-db');
  const handle = await createDb({ pgliteDataDir: dir });
  await handle.close();

  console.log(`restored ${dir} from ${to}, and it opens cleanly`);
} else {
  if (!existsSync(dir)) {
    console.error(`No database at ${dir}.`);
    process.exit(1);
  }
  if (existsSync(`${dir}/.wv-lock`)) {
    console.error(
      `${dir} is currently open (lock present). Stop the dev server or ingest first:\n` +
        'a copy taken mid-write is not usable.',
    );
    process.exit(1);
  }
  await rm(to, { recursive: true, force: true });
  await cp(dir, to, { recursive: true });
  const size = (await stat(to)).isDirectory() ? '' : '';
  console.log(`backed up ${dir} -> ${to}${size}`);
}
