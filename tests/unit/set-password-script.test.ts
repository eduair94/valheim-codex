import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePasswordHash, verifyPassword } from '@/lib/auth/password';

/**
 * The deployment script re-implements the hash format so it can run on a host
 * with nothing installed. These tests are what stop the two implementations
 * drifting: they run the real script and hand its output to the real verifier.
 */

const dirs: string[] = [];

function run(args: string[], cwd?: string): string {
  return execFileSync(process.execPath, ['scripts/set-password.mjs', ...args], {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf8',
  });
}

function tempEnv(contents = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'wv-pw-'));
  dirs.push(dir);
  const path = join(dir, '.env');
  writeFileSync(path, contents);
  return path;
}

function read(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('set-password.mjs', () => {
  it('writes a hash the application accepts', async () => {
    const path = tempEnv();
    run(['a-long-enough-password', path]);

    const env = read(path);
    expect(await verifyPassword('a-long-enough-password', env['APP_PASSWORD_HASH']!)).toBe(true);
    expect(await verifyPassword('the-wrong-password', env['APP_PASSWORD_HASH']!)).toBe(false);
  });

  it('writes the format the application parses, with the same parameters', async () => {
    const path = tempEnv();
    run(['a-long-enough-password', path]);

    const parsed = parsePasswordHash(read(path)['APP_PASSWORD_HASH']!);
    expect(parsed).not.toBeNull();
    expect(parsed!.N).toBe(65536);
    expect(parsed!.r).toBe(8);
    expect(parsed!.p).toBe(1);
  });

  it('writes a session secret long enough for the env schema', () => {
    const path = tempEnv();
    run(['a-long-enough-password', path]);
    expect(read(path)['SESSION_SECRET']!.length).toBeGreaterThanOrEqual(32);
  });

  it('never prints either value', () => {
    const path = tempEnv();
    const output = run(['a-long-enough-password', path]);
    const env = read(path);
    expect(output).not.toContain(env['APP_PASSWORD_HASH']);
    expect(output).not.toContain(env['SESSION_SECRET']);
    expect(output).not.toContain('a-long-enough-password');
  });

  it('keeps the other variables in the file', () => {
    const path = tempEnv('DATABASE_URL=postgresql://example\nEMBEDDING_PROVIDER=local\n');
    run(['a-long-enough-password', path]);

    const env = read(path);
    expect(env['DATABASE_URL']).toBe('postgresql://example');
    expect(env['EMBEDDING_PROVIDER']).toBe('local');
  });

  it('replaces on a re-run rather than leaving two values', () => {
    const path = tempEnv();
    run(['a-long-enough-password', path]);
    const first = read(path)['APP_PASSWORD_HASH'];

    run(['a-different-password', path]);
    const contents = readFileSync(path, 'utf8');

    expect(contents.match(/^APP_PASSWORD_HASH=/gm)).toHaveLength(1);
    expect(contents.match(/^SESSION_SECRET=/gm)).toHaveLength(1);
    expect(read(path)['APP_PASSWORD_HASH']).not.toBe(first);
  });

  it('refuses a password too short to be worth hashing', () => {
    const path = tempEnv();
    expect(() => run(['short', path])).toThrow();
  });
});
