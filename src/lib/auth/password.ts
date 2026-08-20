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
