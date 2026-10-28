import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeQuota } from '@/lib/auth/quota';
import { chatBuckets } from '@/lib/auth/limits';
import type { DbHandle } from '@/lib/db/create-db';
import { createDb } from '@/lib/db/create-db';
import { createTestDb } from '../helpers/db';

const MINUTE = 60_000;

describe('consumeQuota', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('allows up to the limit, then refuses with the time left in the window', async () => {
    const now = new Date('2026-10-26T12:00:30Z');
    const bucket = [{ name: 'test:a:1', limit: 2, windowMs: MINUTE }];
    expect(await consumeQuota(handle.db, bucket, now)).toEqual({ allowed: true });
    expect(await consumeQuota(handle.db, bucket, now)).toEqual({ allowed: true });
    expect(await consumeQuota(handle.db, bucket, now)).toEqual({
      allowed: false,
      bucket: 'test:a',
      retryAfterSeconds: 30,
    });
  });

  it('starts a fresh count in the next window', async () => {
    const bucket = [{ name: 'test:b:1', limit: 1, windowMs: MINUTE }];
    expect((await consumeQuota(handle.db, bucket, new Date('2026-10-26T12:00:10Z'))).allowed).toBe(true);
    expect((await consumeQuota(handle.db, bucket, new Date('2026-10-26T12:00:50Z'))).allowed).toBe(false);
    expect((await consumeQuota(handle.db, bucket, new Date('2026-10-26T12:01:10Z'))).allowed).toBe(true);
  });

  it('counts a minute and a day bucket for the same subject separately', async () => {
    // At midnight both windows start at the same instant; they must not share a row.
    const now = new Date('2026-10-27T00:00:00Z');
    const buckets = [
      { name: 'test:c:1', limit: 1, windowMs: MINUTE },
      { name: 'test:c:1', limit: 5, windowMs: 24 * 60 * MINUTE },
    ];
    expect((await consumeQuota(handle.db, buckets, now)).allowed).toBe(true);
    const second = await consumeQuota(handle.db, buckets, now);
    expect(second).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
  });

  it('reports the longest wait when several ceilings are hit', async () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const buckets = [
      { name: 'test:d:1', limit: 1, windowMs: MINUTE },
      { name: 'test:d:2', limit: 1, windowMs: 60 * MINUTE },
    ];
    await consumeQuota(handle.db, buckets, now);
    expect(await consumeQuota(handle.db, buckets, now)).toMatchObject({ allowed: false, retryAfterSeconds: 3600 });
  });

  it('treats a zero limit as switched off', async () => {
    expect(await consumeQuota(handle.db, [{ name: 'test:e:1', limit: 0, windowMs: MINUTE }])).toMatchObject({
      allowed: false,
    });
  });

  it('applies identity, address and global ceilings to guests', async () => {
    const principal = { kind: 'puter' as const, profile: 'puter:00000000-0000-4000-8000-000000000001', name: 'a' };
    const buckets = chatBuckets(principal, '203.0.113.7', { CHAT_GUEST_PER_MINUTE: '1' });
    expect(buckets.map((b) => b.name)).toEqual([
      'chat:guest:puter:00000000-0000-4000-8000-000000000001',
      'chat:guest:puter:00000000-0000-4000-8000-000000000001',
      'chat:guest-ip:203.0.113.7',
      'chat:guest-ip:203.0.113.7',
      'chat:guest-global',
    ]);
    const now = new Date('2026-10-26T13:00:00Z');
    expect((await consumeQuota(handle.db, buckets, now)).allowed).toBe(true);
    expect(await consumeQuota(handle.db, buckets, now)).toMatchObject({ allowed: false, bucket: 'chat:guest' });
  });

  it('spends a shared ceiling only on calls every narrower ceiling allowed', async () => {
    // One address hammering past its own limit must not use up everyone's day.
    const now = new Date('2026-10-26T14:00:00Z');
    const day = 24 * 60 * MINUTE;
    const from = (ip: string) => [
      { name: `test:g-ip:${ip}`, limit: 1, windowMs: MINUTE },
      { name: 'test:g-global', limit: 3, windowMs: day },
    ];
    expect((await consumeQuota(handle.db, from('203.0.113.9'), now)).allowed).toBe(true);
    for (let i = 0; i < 10; i++) {
      expect(await consumeQuota(handle.db, from('203.0.113.9'), now)).toMatchObject({ allowed: false, bucket: 'test:g-ip' });
    }
    expect((await consumeQuota(handle.db, from('198.51.100.2'), now)).allowed).toBe(true);
    expect((await consumeQuota(handle.db, from('198.51.100.3'), now)).allowed).toBe(true);
    expect(await consumeQuota(handle.db, from('198.51.100.4'), now)).toMatchObject({ allowed: false, bucket: 'test:g-global' });
  });

  it('creates its table when a deployment skipped the migration', async () => {
    const bare = await createDb();
    try {
      await bare.db.execute(sql`SELECT 1`);
      const result = await consumeQuota(bare.db, [{ name: 'test:f:1', limit: 1, windowMs: MINUTE }]);
      expect(result.allowed).toBe(true);
    } finally {
      await bare.close();
    }
  });
});
