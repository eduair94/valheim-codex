import { sql } from 'drizzle-orm';
import { rawQuery, type Db } from '@/lib/db/create-db';

/**
 * Fixed-window quotas stored in Postgres (`rate_limits`).
 *
 * The same reasoning as the login limiter: the database is the only state
 * every process agrees on, and a fixed window is one upsert per bucket. A
 * request's own buckets (per identity, per address) are counted in a single
 * statement, and its shared ones in a second, so a quota check costs at most
 * two round trips however many ceilings apply.
 *
 * Every call counts against its own buckets, allowed or not: a client
 * hammering past its limit keeps its window full rather than earning a free
 * retry. A shared bucket (everyone's: `chat:guest-global`) counts only calls
 * that every narrower bucket allowed. Counted with the rest, one address past
 * its own limit could spend everyone's day: a thousand refused Puter sign-ins
 * from one client closed Puter sign-in for every reader until midnight.
 */

export type QuotaBucket = {
  /** What is being counted, e.g. `chat:guest-ip:203.0.113.7`. */
  name: string;
  /** Requests allowed per window. Zero shuts the bucket. */
  limit: number;
  windowMs: number;
};

export type QuotaDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** The bucket that ran out (its name, without the subject). */
      bucket: string;
      retryAfterSeconds: number;
    };

const PRUNE_EVERY = 64;
const RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

let tableEnsured = false;

/**
 * Creates `rate_limits` if a deployment skipped `pnpm db:migrate`.
 *
 * Deploys here are `git pull && docker compose up --build`; nothing runs
 * migrations, and a missing table would otherwise switch guest chat off with
 * no visible cause. Same DDL as drizzle/0005, so the migration still applies
 * cleanly afterwards. If the app's database role may not create tables, this
 * fails and the caller's fail-open/fail-closed rule decides.
 */
async function ensureTable(db: Db): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key          text        NOT NULL,
      window_start timestamptz NOT NULL,
      count        integer     NOT NULL DEFAULT 0,
      PRIMARY KEY (key, window_start)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start)`);
  tableEnsured = true;
}

/** Postgres SQLSTATE of an error, looking through driver wrappers. */
function sqlState(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The subject-free part of a bucket name: `chat:guest-ip:1.2.3.4` → `chat:guest-ip`. */
function bucketKind(name: string): string {
  return name.split(':').slice(0, 2).join(':');
}

/** A bucket that counts everyone (`chat:guest-global`), not one subject (`chat:guest-ip:203.0.113.7`). */
function isShared(bucket: QuotaBucket): boolean {
  return bucket.name.split(':').length <= 2;
}

export async function consumeQuota(db: Db, buckets: QuotaBucket[], now: Date = new Date()): Promise<QuotaDecision> {
  for (const bucket of buckets) {
    if (bucket.limit <= 0) {
      return { allowed: false, bucket: bucketKind(bucket.name), retryAfterSeconds: Math.ceil(bucket.windowMs / 1000) };
    }
  }
  // The subject's own buckets first; the shared ones only for a call they all allowed.
  const own = await countBuckets(
    db,
    buckets.filter((bucket) => !isShared(bucket)),
    now,
  );
  if (!own.allowed) return own;
  return countBuckets(
    db,
    buckets.filter((bucket) => isShared(bucket)),
    now,
  );
}

/** Adds one call to each bucket, in one statement, and decides from the counts. */
async function countBuckets(db: Db, buckets: QuotaBucket[], now: Date): Promise<QuotaDecision> {
  const rows = new Map<string, { bucket: QuotaBucket; windowStart: Date }>();
  for (const bucket of buckets) {
    const windowStart = new Date(Math.floor(now.getTime() / bucket.windowMs) * bucket.windowMs);
    rows.set(`${bucket.name}|${bucket.windowMs}`, { bucket, windowStart });
  }
  if (rows.size === 0) return { allowed: true };

  const values = sql.join(
    [...rows].map(([key, { windowStart }]) => sql`(${key}, ${windowStart.toISOString()}, 1)`),
    sql`, `,
  );
  const upsert = sql`
    INSERT INTO rate_limits (key, window_start, count)
    VALUES ${values}
    ON CONFLICT (key, window_start)
    DO UPDATE SET count = rate_limits.count + 1
    RETURNING key, count
  `;

  let counted: { key: string; count: number }[];
  try {
    counted = await rawQuery<{ key: string; count: number }>(db, upsert);
  } catch (error) {
    if (tableEnsured || sqlState(error) !== '42P01') throw error;
    await ensureTable(db);
    counted = await rawQuery<{ key: string; count: number }>(db, upsert);
  }

  if (Math.floor(Math.random() * PRUNE_EVERY) === 0) {
    const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
    void db.execute(sql`DELETE FROM rate_limits WHERE window_start < ${cutoff}`).catch(() => {});
  }

  let denied: Extract<QuotaDecision, { allowed: false }> | null = null;
  for (const { key, count } of counted) {
    const row = rows.get(key);
    if (!row || Number(count) <= row.bucket.limit) continue;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((row.windowStart.getTime() + row.bucket.windowMs - now.getTime()) / 1000),
    );
    if (!denied || retryAfterSeconds > denied.retryAfterSeconds) {
      denied = { allowed: false, bucket: bucketKind(row.bucket.name), retryAfterSeconds };
    }
  }
  return denied ?? { allowed: true };
}

/** A 429 carrying `Retry-After`, in the shape every JSON route uses. */
export function quotaExceededResponse(decision: Extract<QuotaDecision, { allowed: false }>): Response {
  return Response.json(
    { error: 'rate_limited', bucket: decision.bucket, retryAfter: decision.retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } },
  );
}
