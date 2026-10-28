import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkLoginRateLimit,
  clearLoginRateLimit,
  loginLimits,
  MAX_ATTEMPTS,
  networkOf,
  pruneLoginAttempts,
  recordLoginFailure,
  WINDOW_MS,
} from '@/lib/auth/rate-limit';
import { rawQuery, type DbHandle } from '@/lib/db/create-db';
import { createTestDb } from '../helpers/db';

describe('login rate limit', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.db.execute(sql`DELETE FROM login_attempts`);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function rows(ip: string): Promise<number> {
    const result = await rawQuery<{ n: string }>(handle.db, sql`SELECT count(*)::text AS n FROM login_attempts WHERE ip = ${ip}`);
    return Number(result[0]?.n ?? 0);
  }

  const at = (ip: string) => ({ ip });

  it('allows ten attempts per window and refuses the eleventh until it ends', async () => {
    const now = new Date('2026-10-26T12:05:00Z');
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const result = await checkLoginRateLimit(handle.db, at('198.51.100.1'), now);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(MAX_ATTEMPTS - i);
    }
    const refused = await checkLoginRateLimit(handle.db, at('198.51.100.1'), now);
    expect(refused.allowed).toBe(false);
    expect(refused.resetAt.toISOString()).toBe('2026-10-26T12:15:00.000Z');

    const nextWindow = new Date(now.getTime() + WINDOW_MS);
    expect((await checkLoginRateLimit(handle.db, at('198.51.100.1'), nextWindow)).allowed).toBe(true);
  });

  it('counts each address separately and forgets one after a successful login', async () => {
    const now = new Date('2026-10-26T13:00:00Z');
    for (let i = 0; i < MAX_ATTEMPTS; i++) await checkLoginRateLimit(handle.db, at('198.51.100.2'), now);
    expect((await checkLoginRateLimit(handle.db, at('198.51.100.3'), now)).allowed).toBe(true);

    await clearLoginRateLimit(handle.db, at('198.51.100.2'));
    expect((await checkLoginRateLimit(handle.db, at('198.51.100.2'), now)).allowed).toBe(true);
  });

  describe('per network', () => {
    it('groups IPv4 by /24 and IPv6 (already a /64) by /48', () => {
      expect(networkOf('203.0.113.77')).toBe('203.0.113.0/24');
      expect(networkOf('2001:db8:1:2::/64')).toBe('2001:db8:1::/48');
      expect(networkOf('0:0:0:0::/64')).toBe('0:0:0::/48');
      expect(networkOf('unknown')).toBe('unknown');
    });

    it('stops a /48 that rotates through its /64s, each under its own limit', async () => {
      // One server's allocation is 65,536 /64s: per address alone, that was
      // hundreds of thousands of guesses a window.
      const now = new Date('2026-10-26T14:00:00Z');
      const { perNetwork } = loginLimits({});
      for (let i = 0; i < perNetwork; i++) {
        const result = await checkLoginRateLimit(handle.db, at(`2001:db8:1:${i.toString(16)}::/64`), now);
        expect(result.allowed, `attempt ${i + 1}`).toBe(true);
      }
      expect((await checkLoginRateLimit(handle.db, at('2001:db8:1:ffff::/64'), now)).allowed).toBe(false);
      // A neighbouring /48 is somebody else.
      expect((await checkLoginRateLimit(handle.db, at('2001:db8:2:0::/64'), now)).allowed).toBe(true);
    });

    it('does the same for an IPv4 /24', async () => {
      const now = new Date('2026-10-26T14:20:00Z');
      for (let i = 1; i <= 30; i++) await checkLoginRateLimit(handle.db, at(`192.0.2.${i}`), now);
      expect((await checkLoginRateLimit(handle.db, at('192.0.2.200'), now)).allowed).toBe(false);
      expect((await checkLoginRateLimit(handle.db, at('192.0.3.1'), now)).allowed).toBe(true);
    });

    it('can be loosened or tightened from the environment', async () => {
      const now = new Date('2026-10-26T14:40:00Z');
      const env = { LOGIN_NETWORK_ATTEMPTS_PER_15MIN: '2' };
      expect((await checkLoginRateLimit(handle.db, at('198.18.0.1'), now, env)).allowed).toBe(true);
      expect((await checkLoginRateLimit(handle.db, at('198.18.0.2'), now, env)).allowed).toBe(true);
      expect((await checkLoginRateLimit(handle.db, at('198.18.0.3'), now, env)).allowed).toBe(false);
    });
  });

  describe('known browsers', () => {
    const device = '6f1c2a10-1234-4abc-9def-0123456789ab';

    it('are counted on their own, so a burned address or network does not lock them out', async () => {
      const now = new Date('2026-10-26T15:00:00Z');
      for (let i = 0; i <= MAX_ATTEMPTS; i++) await checkLoginRateLimit(handle.db, at('198.51.100.9'), now);
      expect((await checkLoginRateLimit(handle.db, at('198.51.100.9'), now)).allowed).toBe(false);
      expect((await checkLoginRateLimit(handle.db, { ip: '198.51.100.9', device }, now)).allowed).toBe(true);
    });

    it('still get only ten attempts a window, from wherever they come', async () => {
      const now = new Date('2026-10-26T15:20:00Z');
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        expect((await checkLoginRateLimit(handle.db, { ip: `192.0.2.${i}`, device }, now)).allowed).toBe(true);
      }
      expect((await checkLoginRateLimit(handle.db, { ip: '203.0.113.250', device }, now)).allowed).toBe(false);

      await clearLoginRateLimit(handle.db, { ip: '203.0.113.250', device });
      expect((await checkLoginRateLimit(handle.db, { ip: '203.0.113.250', device }, now)).allowed).toBe(true);
    });
  });

  describe('the shared failure budget', () => {
    it('closes the guard when failures from everyone reach it, until the window ends', async () => {
      const now = new Date('2026-10-26T16:00:00Z');
      const env = { LOGIN_GLOBAL_FAILURES_PER_15MIN: '3' };
      expect((await checkLoginRateLimit(handle.db, at('198.51.100.20'), now, env)).guarded).toBe(false);

      expect(await recordLoginFailure(handle.db, now, env)).toEqual({ failures: 1, guardClosed: false });
      expect(await recordLoginFailure(handle.db, now, env)).toEqual({ failures: 2, guardClosed: false });
      // The failure that spends the budget says so, once.
      expect(await recordLoginFailure(handle.db, now, env)).toEqual({ failures: 3, guardClosed: true });
      expect(await recordLoginFailure(handle.db, now, env)).toEqual({ failures: 4, guardClosed: false });

      // From an address that never failed: the budget is everyone's.
      const guarded = await checkLoginRateLimit(handle.db, at('192.0.2.99'), now, env);
      expect(guarded).toMatchObject({ allowed: true, guarded: true });

      const later = new Date(now.getTime() + WINDOW_MS);
      expect((await checkLoginRateLimit(handle.db, at('192.0.2.99'), later, env)).guarded).toBe(false);
    });

    it('defaults to fifty failures a window', () => {
      expect(loginLimits({})).toEqual({ perNetwork: 30, failuresPerWindow: 50 });
    });
  });

  it('drops windows that can no longer matter', async () => {
    const old = new Date('2026-10-26T08:00:00Z');
    await checkLoginRateLimit(handle.db, at('198.51.100.4'), old);
    expect(await rows('198.51.100.4')).toBe(1);
    expect(await rows('net:198.51.100.0/24')).toBe(1);
    await pruneLoginAttempts(handle.db, new Date(old.getTime() + WINDOW_MS));
    expect(await rows('198.51.100.4')).toBe(1);
    await pruneLoginAttempts(handle.db, new Date(old.getTime() + 3 * WINDOW_MS));
    expect(await rows('198.51.100.4')).toBe(0);
    expect(await rows('net:198.51.100.0/24')).toBe(0);
  });

  it('prunes on failed attempts too, not only after a success', async () => {
    // A run of nothing but failures — what an attack looks like — used to leave every row in place.
    const old = new Date('2026-10-25T08:00:00Z');
    await checkLoginRateLimit(handle.db, at('198.51.100.5'), old);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await checkLoginRateLimit(handle.db, at('198.51.100.6'), new Date('2026-10-25T12:00:00Z'));
    await vi.waitFor(async () => expect(await rows('198.51.100.5')).toBe(0));
    expect(await rows('198.51.100.6')).toBe(1);
  });
});
