import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { verifyPassword } from '@/lib/auth/password';

/**
 * `pnpm auth:hash`, the route the README documents, used to hash any
 * password at all while the deployment scripts demanded twelve characters.
 */

function run(password: string): string {
  return execFileSync(process.execPath, ['--import', 'tsx', 'scripts/hash-password.ts', password], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('scripts/hash-password.ts', () => {
  it('refuses a password shorter than twelve characters', () => {
    expect(() => run('short')).toThrow(/at least 12/);
  });

  it('prints a hash the application accepts and a session secret long enough to use', async () => {
    const output = run('a-long-enough-password');
    const hash = /^APP_PASSWORD_HASH=(\S+)$/m.exec(output)?.[1];
    const secret = /^SESSION_SECRET=(\S+)$/m.exec(output)?.[1];
    expect(await verifyPassword('a-long-enough-password', hash!)).toBe(true);
    expect(secret!.length).toBeGreaterThanOrEqual(32);
  }, 30_000);
});
