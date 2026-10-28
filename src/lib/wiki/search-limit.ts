/**
 * A per-address ceiling on the wiki's content search, kept in memory.
 *
 * The search is public and costs a database query whose price grows with the
 * words in it, and the CDN only absorbs a query someone already asked. A
 * script sending a different long query every few milliseconds would keep
 * the metered database busy for everyone; a person typing sends one request
 * per pause, a few a minute even when searching hard.
 *
 * In memory rather than in `rate_limits`, unlike the chat's quotas: counting
 * there is one more database round trip on every search, which is the very
 * cost being bounded. Per process is enough for that purpose — production is
 * one container — and a restart forgetting the counts costs nothing.
 *
 * A request with no usable client address (`clientIp` → 'unknown': local
 * development, or no proxy in front) is not counted, since every visitor
 * would share one bucket. Behind Cloudflare every request has one.
 */

export type SearchDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export type SearchLimiter = {
  /** Counts a request from `key` and says whether it may go ahead. */
  take(key: string, now?: number): SearchDecision;
};

export type SearchLimitOptions = {
  /** Requests per window and address; 0 turns the ceiling off. */
  limit: number;
  windowMs: number;
  /** Addresses remembered at most; beyond it the oldest windows are forgotten. */
  maxKeys?: number;
};

export function createSearchLimiter({ limit, windowMs, maxKeys = 10_000 }: SearchLimitOptions): SearchLimiter {
  const windows = new Map<string, { start: number; count: number }>();

  /** Drops finished windows, then the oldest ones, until the map is back under its size. */
  const prune = (now: number): void => {
    for (const [key, window] of windows) {
      if (now - window.start >= windowMs) windows.delete(key);
    }
    for (const key of windows.keys()) {
      if (windows.size <= maxKeys) break;
      windows.delete(key);
    }
  };

  return {
    take(key, now = Date.now()) {
      if (limit <= 0 || key === 'unknown') return { allowed: true };

      let window = windows.get(key);
      if (!window || now - window.start >= windowMs) {
        // Re-inserted, so the map stays in order of when each window began.
        windows.delete(key);
        window = { start: now, count: 0 };
        windows.set(key, window);
        if (windows.size > maxKeys) prune(now);
      }
      // Every request counts, refused or not: hammering past the ceiling
      // keeps the window full rather than earning a retry.
      window.count += 1;
      if (window.count <= limit) return { allowed: true };
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + windowMs - now) / 1000)) };
    },
  };
}

/** Searches per minute per address unless `WIKI_SEARCH_PER_MINUTE` says otherwise (0: no ceiling). */
export function searchLimitFromEnv(env: Record<string, string | undefined> = process.env): SearchLimitOptions {
  const raw = env.WIKI_SEARCH_PER_MINUTE?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return { limit: Number.isFinite(parsed) && parsed >= 0 ? parsed : 60, windowMs: 60_000 };
}
