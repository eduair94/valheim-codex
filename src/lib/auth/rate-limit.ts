import { sql } from 'drizzle-orm';
import { rawQuery, type Db } from '@/lib/db/create-db';

/** Attempts allowed per IP per window. */
export const MAX_ATTEMPTS = 10;
/** Window length in milliseconds. */
export const WINDOW_MS = 15 * 60 * 1000;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** When the current window ends. */
  resetAt: Date;
};

/**
 * Fixed-window rate limit for the login route, stored in Postgres.
 *
 * A single shared password is exactly the shape brute force is good at, and
 * the app runs on serverless functions where an in-process counter resets with
 * every cold start and is not shared between instances. The database is the
 * only state all instances agree on.
 *
 * Fixed rather than sliding window: it allows a burst at a boundary, which for
 * a login gate is an acceptable trade for a single-row, index-only update.
 */
export async function checkLoginRateLimit(
  db: Db,
  ip: string,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const windowStart = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
  const resetAt = new Date(windowStart.getTime() + WINDOW_MS);

  const rows = await rawQuery<{ count: number }>(
    db,
    sql`
      INSERT INTO login_attempts (ip, window_start, count)
      VALUES (${ip}, ${windowStart.toISOString()}, 1)
      ON CONFLICT (ip, window_start)
      DO UPDATE SET count = login_attempts.count + 1
      RETURNING count
    `,
  );

  const count = Number(rows[0]?.count ?? 1);
  return {
    allowed: count <= MAX_ATTEMPTS,
    remaining: Math.max(0, MAX_ATTEMPTS - count),
    resetAt,
  };
}

/** Clears the counter for an IP after a successful login. */
export async function clearLoginRateLimit(db: Db, ip: string): Promise<void> {
  await db.execute(sql`DELETE FROM login_attempts WHERE ip = ${ip}`);
}

/** Drops windows that can no longer matter. Called opportunistically. */
export async function pruneLoginAttempts(db: Db, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - WINDOW_MS * 2);
  await db.execute(sql`DELETE FROM login_attempts WHERE window_start < ${cutoff.toISOString()}`);
}

/**
 * Best-effort client IP.
 *
 * Vercel sets `x-forwarded-for` and strips any client-supplied value, so the
 * first entry is trustworthy there. Behind a different proxy it is not, which
 * is why this only ever feeds a rate limit and never an authorisation decision.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || 'unknown';
}
