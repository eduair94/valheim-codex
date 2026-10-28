import { describe, expect, it } from 'vitest';
import { createSearchLimiter, searchLimitFromEnv } from '@/lib/wiki/search-limit';

describe('createSearchLimiter', () => {
  it('lets an address search up to the limit per window, then says when to come back', () => {
    const limiter = createSearchLimiter({ limit: 3, windowMs: 60_000 });
    const t0 = 1_000_000;
    expect([0, 1, 2].map((i) => limiter.take('203.0.113.7', t0 + i).allowed)).toEqual([true, true, true]);
    expect(limiter.take('203.0.113.7', t0 + 10_000)).toEqual({ allowed: false, retryAfterSeconds: 50 });
    // Another address has its own window.
    expect(limiter.take('198.51.100.2', t0 + 10_000).allowed).toBe(true);
    // A new window starts once the old one is over.
    expect(limiter.take('203.0.113.7', t0 + 60_001).allowed).toBe(true);
  });

  it('counts refused requests too, so hammering keeps the window full', () => {
    const limiter = createSearchLimiter({ limit: 1, windowMs: 1000 });
    limiter.take('a', 0);
    for (let t = 100; t < 1000; t += 100) expect(limiter.take('a', t).allowed).toBe(false);
  });

  it('never limits requests without a known address, which would all share one bucket', () => {
    const limiter = createSearchLimiter({ limit: 1, windowMs: 60_000 });
    for (let i = 0; i < 10; i += 1) expect(limiter.take('unknown', i).allowed).toBe(true);
  });

  it('is off at a limit of zero', () => {
    const limiter = createSearchLimiter({ limit: 0, windowMs: 60_000 });
    for (let i = 0; i < 10; i += 1) expect(limiter.take('a', i).allowed).toBe(true);
  });

  it('forgets the oldest addresses rather than growing without bound', () => {
    const limiter = createSearchLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100 });
    limiter.take('first', 0);
    expect(limiter.take('first', 1).allowed).toBe(false);
    for (let i = 0; i < 200; i += 1) limiter.take(`addr-${i}`, 2 + i);
    // "first" was pushed out, so it starts a fresh window.
    expect(limiter.take('first', 300).allowed).toBe(true);
  });
});

describe('searchLimitFromEnv', () => {
  it('defaults to sixty a minute and reads WIKI_SEARCH_PER_MINUTE', () => {
    expect(searchLimitFromEnv({})).toEqual({ limit: 60, windowMs: 60_000 });
    expect(searchLimitFromEnv({ WIKI_SEARCH_PER_MINUTE: '120' }).limit).toBe(120);
    expect(searchLimitFromEnv({ WIKI_SEARCH_PER_MINUTE: '0' }).limit).toBe(0);
    expect(searchLimitFromEnv({ WIKI_SEARCH_PER_MINUTE: 'lots' }).limit).toBe(60);
    expect(searchLimitFromEnv({ WIKI_SEARCH_PER_MINUTE: '-5' }).limit).toBe(60);
  });
});
