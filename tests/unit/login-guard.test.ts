import { describe, expect, it } from 'vitest';
import {
  createLoginDeviceToken,
  loginDeviceCookieOptions,
  verifyLoginDeviceToken,
} from '@/lib/auth/login-device';
import { hashPassword, verifyPasswordThrottled } from '@/lib/auth/password';
import { createSessionToken } from '@/lib/auth/session';

const SECRET = 'k'.repeat(48);

describe('known-browser tokens', () => {
  it('round-trip the browser id for the password they were issued under', async () => {
    const hash = await hashPassword('Valhalla-2026!');
    const id = '6f1c2a10-1234-4abc-9def-0123456789ab';
    const token = await createLoginDeviceToken(hash, SECRET, id);
    expect(await verifyLoginDeviceToken(token, hash, SECRET)).toBe(id);
    expect(await verifyLoginDeviceToken(await createLoginDeviceToken(hash, SECRET), hash, SECRET)).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('are retired by a new password, so a former holder keeps no head start', async () => {
    const before = await hashPassword('Valhalla-2026!');
    // Same password, new salt: a rotation all the same.
    const after = await hashPassword('Valhalla-2026!');
    const token = await createLoginDeviceToken(before, SECRET);
    expect(await verifyLoginDeviceToken(token, after, SECRET)).toBeNull();
  });

  it('refuse anything not minted here for this purpose', async () => {
    const hash = await hashPassword('Valhalla-2026!');
    expect(await verifyLoginDeviceToken(undefined, hash, SECRET)).toBeNull();
    expect(await verifyLoginDeviceToken('garbage', hash, SECRET)).toBeNull();
    expect(await verifyLoginDeviceToken(await createLoginDeviceToken(hash, 'o'.repeat(48)), hash, SECRET)).toBeNull();
    expect(await verifyLoginDeviceToken(await createLoginDeviceToken(hash, SECRET, undefined, -1), hash, SECRET)).toBeNull();
    // A session token is signed with the same secret but for another audience.
    expect(await verifyLoginDeviceToken(await createSessionToken({ profile: 'x' }, SECRET), hash, SECRET)).toBeNull();
  });

  it('live in an httpOnly, same-site-strict cookie, Secure in production', () => {
    expect(loginDeviceCookieOptions(true)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 180,
    });
    expect(loginDeviceCookieOptions(false).secure).toBe(false);
  });
});

describe('verifyPasswordThrottled, shared out', () => {
  it('gives one network two places at most', async () => {
    const hash = await hashPassword('Valhalla-2026!');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => verifyPasswordThrottled('wrong', hash, { network: '203.0.113.0/24' })),
    );
    expect(results.filter((r) => r === null)).toHaveLength(3);
    expect(results.filter((r) => r === false)).toHaveLength(2);
    // Its places come back once those finish.
    expect(await verifyPasswordThrottled('Valhalla-2026!', hash, { network: '203.0.113.0/24' })).toBe(true);
  }, 30_000);

  it('keeps places for known browsers and serves them before waiting strangers', async () => {
    const hash = await hashPassword('Valhalla-2026!');
    const finished: string[] = [];
    const attempt = (label: string, known: boolean, network: string) =>
      verifyPasswordThrottled(known ? 'Valhalla-2026!' : 'wrong', hash, { network, known }).then((result) => {
        finished.push(label);
        return result;
      });

    // Two running and eight waiting, from ten networks: the strangers' line is full.
    const strangers = Array.from({ length: 10 }, (_, i) => attempt(`stranger-${i}`, false, `198.51.${i}.0/24`));
    const turnedAway = await verifyPasswordThrottled('wrong', hash, { network: '192.0.2.0/24' });
    expect(turnedAway).toBeNull();

    const returning = attempt('known', true, '198.51.0.0/24');
    expect(await returning).toBe(true);
    await Promise.all(strangers);

    /*
     * It took the first slot to come free, ahead of the eight strangers
     * waiting. Finishing order is not exactly start order — a stranger handed
     * the other slot a moment later can finish first under load — but served
     * last, it would have finished around tenth.
     */
    expect(finished.indexOf('known')).toBeGreaterThanOrEqual(2);
    expect(finished.indexOf('known')).toBeLessThan(5);
  }, 60_000);
});
