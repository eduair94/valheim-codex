import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt parameters.
 *
 * N=2^16 with r=8 costs roughly 100 ms and 64 MB per verification, which is
 * heavy for an attacker and unnoticeable on a login that happens once a month.
 * `maxmem` must be raised explicitly or Node refuses these parameters.
 */
const PARAMS = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * Shortest password the setup scripts accept. It is the one credential
 * between the internet and the operator's model budget, shared among friends
 * and guessed against from anywhere. `scripts/set-password.mjs` keeps its own
 * copy of this number because it runs with no dependencies.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Field separator.
 *
 * A dot, not the conventional `$`. The hash is carried in `APP_PASSWORD_HASH`,
 * and Next.js expands `$NAME` references when it reads `.env` files — so
 * `scrypt$65536$8$1$…` arrives at the server as the single word `scrypt`, and
 * every login fails with "wrong password" and no clue why. A dot is outside
 * the base64url alphabet, so it cannot collide with the salt or the digest.
 */
const SEP = '.';

/**
 * Hashes a password into a self-describing string:
 * `scrypt.N.r.p.<salt-b64url>.<hash-b64url>`.
 *
 * scrypt from `node:crypto` rather than argon2: no native module to build on
 * Windows or to ship to Vercel, and the parameters above put it in the same
 * bracket for a single shared password.
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error('Password must not be empty');
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join(SEP);
}

type ParsedHash = { N: number; r: number; p: number; salt: Buffer; digest: Buffer };

/**
 * Parses a stored hash, accepting both the dot form and the legacy `$` form so
 * a hash from a secrets manager that never passed through a `.env` file still
 * works. Returns null for anything malformed.
 */
export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.includes(SEP) ? stored.split(SEP) : stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N <= 1 || r <= 0 || p <= 0) return null;

  const salt = Buffer.from(saltRaw!, 'base64url');
  const digest = Buffer.from(hashRaw!, 'base64url');
  if (salt.length === 0 || digest.length === 0) return null;

  return { N, r, p, salt, digest };
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a broken
 * `APP_PASSWORD_HASH` must deny access, never crash the login route into a
 * state that leaks which half of the check failed. Callers that want to tell
 * "wrong password" from "misconfigured server" use {@link parsePasswordHash}.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parsed = parsePasswordHash(stored);
    if (!parsed) return false;

    const actual = await scrypt(password.normalize('NFKC'), parsed.salt, parsed.digest.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: PARAMS.maxmem,
    });
    if (actual.length !== parsed.digest.length) return false;
    return timingSafeEqual(actual, parsed.digest);
  } catch {
    return false;
  }
}

/**
 * How many verifications run at once in this process, and how many may wait.
 *
 * Each one holds a libuv thread and 64 MB for about 150 ms, and Node has four
 * such threads, shared with file reads and DNS lookups. A burst of guesses
 * from many addresses — each still under its own rate limit — queued there
 * without bound and stalled everything else: with sixteen in flight, a file
 * read went from 2 ms to 676 ms, public wiki included. Two at a time leaves
 * the other threads free; past a short queue the request is turned away as
 * busy rather than left waiting.
 *
 * A full queue turns everyone away, so the queue is shared out: one network
 * may hold two places at most, and browsers that have signed in before
 * (`login-device.ts`) have places of their own and are served first. A flood
 * from one network cannot fill the queue, and a flood from many — which the
 * limiter's shared failure budget stops soon after — cannot keep a returning
 * reader out while it lasts.
 */
const MAX_CONCURRENT_VERIFICATIONS = 2;
const MAX_WAITING_VERIFICATIONS = 8;
const MAX_WAITING_KNOWN = 4;
const MAX_IN_FLIGHT_PER_NETWORK = 2;

let running = 0;
const waiting: (() => void)[] = [];
const waitingKnown: (() => void)[] = [];
const inFlight = new Map<string, number>();

export type ThrottleOptions = {
  /** The caller's network (`networkOf`), so that one network cannot fill the queue. */
  network?: string;
  /** A browser that has signed in before: its own places, served first, no network share. */
  known?: boolean;
};

function track(network: string | undefined, delta: number): void {
  if (network === undefined) return;
  const value = (inFlight.get(network) ?? 0) + delta;
  if (value > 0) inFlight.set(network, value);
  else inFlight.delete(network);
}

/**
 * {@link verifyPassword} behind the per-process queue above.
 *
 * Resolves to null, without verifying anything, when there is no place for
 * the request: its network already holds its share, or its line is full.
 */
export async function verifyPasswordThrottled(
  password: string,
  stored: string,
  options: ThrottleOptions = {},
): Promise<boolean | null> {
  const known = options.known === true;
  const network = known ? undefined : options.network;
  if (network !== undefined && (inFlight.get(network) ?? 0) >= MAX_IN_FLIGHT_PER_NETWORK) return null;

  if (running >= MAX_CONCURRENT_VERIFICATIONS) {
    const line = known ? waitingKnown : waiting;
    if (line.length >= (known ? MAX_WAITING_KNOWN : MAX_WAITING_VERIFICATIONS)) return null;
    track(network, 1);
    // Woken by a finishing verification, which hands its slot over.
    await new Promise<void>((resolve) => line.push(resolve));
  } else {
    running++;
    track(network, 1);
  }
  try {
    return await verifyPassword(password, stored);
  } finally {
    track(network, -1);
    const next = waitingKnown.shift() ?? waiting.shift();
    if (next) next();
    else running--;
  }
}
