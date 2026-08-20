import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_FILE = '.wv-lock';

/** Whether a pid is a live process on this machine. */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class DatabaseLockedError extends Error {
  constructor(dir: string, pid: number | 'this process') {
    super(
      `The embedded database at ${dir} is already open in ${
        pid === 'this process' ? 'this process' : `process ${pid}`
      }.\n` +
        'PGlite is single-process: a second connection corrupts the data directory.\n' +
        'Stop the other process (an ingest or a dev server), or point this one at ' +
        'a different PGLITE_DATA_DIR.',
    );
    this.name = 'DatabaseLockedError';
  }
}

/**
 * Directories this process already holds.
 *
 * The pid check alone cannot catch a second open from inside the same process,
 * which corrupts the directory just as thoroughly as one from outside.
 */
const held = new Set<string>();

/**
 * Exclusive lock on a PGlite data directory.
 *
 * Two processes opening one PGlite directory does not fail loudly — it
 * corrupts the directory, and the corruption only surfaces on the next start
 * as an unrecoverable WASM abort. A lockfile turns that into a clear error
 * before any damage is done.
 *
 * A lock whose pid is no longer running is treated as stale and taken over,
 * so a crash does not require manual cleanup.
 */
export async function acquireDirLock(dir: string): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, LOCK_FILE);

  const { resolve } = await import('node:path');
  const key = resolve(dir);
  if (held.has(key)) throw new DatabaseLockedError(dir, 'this process');
  held.add(key);

  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    const owner = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim());
    if (isAlive(owner) && owner !== process.pid) {
      held.delete(key);
      throw new DatabaseLockedError(dir, owner);
    }
    await writeFile(lockPath, String(process.pid));
  }

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    held.delete(key);
    process.off('exit', onExit);
    await rm(lockPath, { force: true });
  };

  // Best-effort cleanup on abrupt exit; sync because handlers cannot await.
  function onExit(): void {
    if (released) return;
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // A leftover lock is recovered as stale on the next start.
    }
  }
  process.once('exit', onExit);

  return release;
}
