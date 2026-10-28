import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { rawQuery, type Db } from '@/lib/db/create-db';

/** Attempts allowed per client address (or known browser) per window. */
export const MAX_ATTEMPTS = 10;
/** Window length in milliseconds. */
export const WINDOW_MS = 15 * 60 * 1000;

/** One call in this many also deletes windows that can no longer matter. */
const PRUNE_EVERY = 16;

/** The counter of failed sign-ins from everyone together, in `login_attempts`. */
const FAILURES_KEY = 'failures:all';

type Env = Record<string, string | undefined>;

function envInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * The ceilings besides the per-address one, overridable like those in
 * `limits.ts`.
 *
 * - Per network (an IPv4 /24, an IPv6 /48), 30 per window: a /48 is 65,536
 *   /64s, each its own "address" to the per-address count, which made one
 *   server's allocation worth hundreds of thousands of guesses a window.
 * - Failed sign-ins from everyone, 50 per window: the only bound on an
 *   attacker who spreads over many networks. Past it, a sign-in from a
 *   browser that has never signed in is refused until the window ends;
 *   browsers that have (`login-device.ts`) are not affected. Friends
 *   mistyping a password do not come near it.
 */
export function loginLimits(env: Env = process.env): { perNetwork: number; failuresPerWindow: number } {
  return {
    perNetwork: envInt(env, 'LOGIN_NETWORK_ATTEMPTS_PER_15MIN', 30),
    failuresPerWindow: envInt(env, 'LOGIN_GLOBAL_FAILURES_PER_15MIN', 50),
  };
}

/**
 * The network an address belongs to, for the coarser count: IPv4 by /24,
 * IPv6 by /48 — the block one customer or one server is usually given.
 * Takes what `clientIp()` returns (IPv6 already reduced to its /64).
 */
export function networkOf(ip: string): string {
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  const v6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/i.exec(ip);
  return v6 ? `${v6[1]}:${v6[2]}:${v6[3]}::/48` : ip;
}

/** Who is trying to sign in, as far as the limiter is concerned. */
export type LoginSubject = {
  /** `clientIp()`. */
  ip: string;
  /** A known browser's id, verified (`verifyLoginDeviceToken`), or null. */
  device?: string | null;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** When the current window ends. */
  resetAt: Date;
  /**
   * The failed sign-ins from everyone have used up this window's budget, so
   * a browser that has never signed in should not be let try.
   */
  guarded: boolean;
};

function windowOf(now: Date): { start: Date; end: Date } {
  const start = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
  return { start, end: new Date(start.getTime() + WINDOW_MS) };
}

/** The counters an attempt adds to. A known browser is counted on its own. */
function countersFor(subject: LoginSubject): string[] {
  if (subject.device) return [`device:${subject.device}`];
  const network = `net:${networkOf(subject.ip)}`;
  return network === `net:${subject.ip}` ? [subject.ip] : [subject.ip, network];
}

/**
 * Fixed-window rate limit for the login route, stored in Postgres.
 *
 * A single shared password is exactly the shape brute force is good at. The
 * counts live in the database rather than in the process so they survive a
 * restart and hold for every process serving the app. Every attempt counts,
 * allowed or not.
 *
 * Keyed on `clientIp()`, which only ever returns a validated address — the
 * one Cloudflare saw, or the nearest proxy's hop, IPv6 grouped by /64. It
 * used to be the first `X-Forwarded-For` entry, which the client writes, so a
 * random value per request bought a fresh window and the limit never applied.
 *
 * A stranger is counted per address and per network; a known browser per
 * browser, so an attacker sharing its address or network cannot lock it out.
 * The same statement reads the window's failure count for the guard. One
 * round trip in all.
 *
 * Fixed rather than sliding window: it allows a burst at a boundary, which for
 * a login gate is an acceptable trade for single-row, index-only updates.
 */
export async function checkLoginRateLimit(
  db: Db,
  subject: LoginSubject,
  now: Date = new Date(),
  env: Env = process.env,
): Promise<RateLimitResult> {
  const { start, end } = windowOf(now);
  const windowStart = start.toISOString();
  const limits = loginLimits(env);
  const counters = countersFor(subject);

  const values = sql.join(
    counters.map((key) => sql`(${key}, ${windowStart}, 1)`),
    sql`, `,
  );
  const rows = await rawQuery<{ ip: string; count: number }>(
    db,
    sql`
      WITH counted AS (
        INSERT INTO login_attempts (ip, window_start, count)
        VALUES ${values}
        ON CONFLICT (ip, window_start)
        DO UPDATE SET count = login_attempts.count + 1
        RETURNING ip, count
      )
      SELECT ip, count FROM counted
      UNION ALL
      SELECT ip, count FROM login_attempts WHERE ip = ${FAILURES_KEY} AND window_start = ${windowStart}
    `,
  );

  /*
   * Pruning used to run only after a successful login, so a stretch of
   * nothing but failures — exactly what an attack looks like — left every row
   * in place, one per guessing address per window. Now any attempt may prune.
   */
  if (Math.floor(Math.random() * PRUNE_EVERY) === 0) {
    void pruneLoginAttempts(db, now).catch(() => {});
  }

  const count = (key: string) => Number(rows.find((row) => row.ip === key)?.count ?? 0);
  const [own, network] = counters;
  const ownCount = count(own!);
  const networkCount = network ? count(network) : 0;
  const allowed = ownCount <= MAX_ATTEMPTS && (!network || networkCount <= limits.perNetwork);

  return {
    allowed,
    remaining: Math.max(
      0,
      Math.min(MAX_ATTEMPTS - ownCount, network ? limits.perNetwork - networkCount : Number.POSITIVE_INFINITY),
    ),
    resetAt: end,
    guarded: count(FAILURES_KEY) >= limits.failuresPerWindow,
  };
}

/**
 * Adds a failed sign-in to the window's shared count. `guardClosed` is true
 * for the one failure that used up the budget, so the moment is logged once.
 */
export async function recordLoginFailure(
  db: Db,
  now: Date = new Date(),
  env: Env = process.env,
): Promise<{ failures: number; guardClosed: boolean }> {
  const rows = await rawQuery<{ count: number }>(
    db,
    sql`
      INSERT INTO login_attempts (ip, window_start, count)
      VALUES (${FAILURES_KEY}, ${windowOf(now).start.toISOString()}, 1)
      ON CONFLICT (ip, window_start)
      DO UPDATE SET count = login_attempts.count + 1
      RETURNING count
    `,
  );
  const failures = Number(rows[0]?.count ?? 1);
  return { failures, guardClosed: failures === loginLimits(env).failuresPerWindow };
}

/**
 * Clears the subject's own counter after a successful login: its address,
 * or the known browser's. The network count runs out on its own.
 */
export async function clearLoginRateLimit(db: Db, subject: LoginSubject): Promise<void> {
  const key = subject.device ? `device:${subject.device}` : subject.ip;
  await db.execute(sql`DELETE FROM login_attempts WHERE ip = ${key}`);
}

/** Drops windows that can no longer matter. */
export async function pruneLoginAttempts(db: Db, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - WINDOW_MS * 2);
  await db.execute(sql`DELETE FROM login_attempts WHERE window_start < ${cutoff.toISOString()}`);
}

export { clientIp } from './client-ip';
