import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDirLock, DatabaseLockedError } from '@/lib/db/dir-lock';
import { createDb } from '@/lib/db/create-db';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wv-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('acquireDirLock', () => {
  it('creates the directory and writes the owning pid', async () => {
    const dir = join(await tempDir(), 'nested', 'db');
    const release = await acquireDirLock(dir);
    expect(existsSync(join(dir, '.wv-lock'))).toBe(true);
    expect((await readFile(join(dir, '.wv-lock'), 'utf8')).trim()).toBe(String(process.pid));
    await release();
  });

  it('removes the lock on release', async () => {
    const dir = await tempDir();
    const release = await acquireDirLock(dir);
    await release();
    expect(existsSync(join(dir, '.wv-lock'))).toBe(false);
  });

  it('refuses a directory another live process holds', async () => {
    const dir = await tempDir();
    // A pid that is definitely alive but is not this process: the parent.
    const otherPid = process.ppid;
    await writeFile(join(dir, '.wv-lock'), String(otherPid));
    await expect(acquireDirLock(dir)).rejects.toBeInstanceOf(DatabaseLockedError);
  });

  it('takes over a stale lock left by a dead process', async () => {
    const dir = await tempDir();
    // 2^22 is above Linux's default pid_max and not a live Windows process.
    await writeFile(join(dir, '.wv-lock'), '4194303');
    const release = await acquireDirLock(dir);
    expect((await readFile(join(dir, '.wv-lock'), 'utf8')).trim()).toBe(String(process.pid));
    await release();
  });

  it('takes over a lock file that is empty or unparsable', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '.wv-lock'), 'not-a-pid');
    const release = await acquireDirLock(dir);
    await release();
    expect(existsSync(join(dir, '.wv-lock'))).toBe(false);
  });

  it('is idempotent on release', async () => {
    const dir = await tempDir();
    const release = await acquireDirLock(dir);
    await release();
    await expect(release()).resolves.toBeUndefined();
  });
});

describe('createDb with an on-disk database', () => {
  it('holds the lock while open and frees it on close', async () => {
    const dir = join(await tempDir(), 'pglite');
    const handle = await createDb({ pgliteDataDir: dir });
    expect(existsSync(join(dir, '.wv-lock'))).toBe(true);

    // This is the failure the lock exists to prevent: a second connection to
    // the same directory silently corrupts it.
    await expect(createDb({ pgliteDataDir: dir })).rejects.toBeInstanceOf(DatabaseLockedError);

    await handle.close();
    expect(existsSync(join(dir, '.wv-lock'))).toBe(false);
  });

  it('does not lock an in-memory database', async () => {
    const a = await createDb();
    const b = await createDb();
    expect(a.driver).toBe('pglite');
    expect(b.driver).toBe('pglite');
    await a.close();
    await b.close();
  });
});
