import { base64url } from 'jose';

/**
 * The secrets auth runs on, validated in one place.
 *
 * `src/lib/env.ts` used to check SESSION_SECRET's length, but nothing called
 * it: the auth paths read `process.env` directly and accepted any non-empty
 * value. An HS256 secret short enough to brute-force offline can be attacked
 * from any token a password holder already has, so a short one is now treated
 * as missing — the chat refuses to start a session and says why in the log —
 * rather than quietly signing tokens with it. The public wiki is unaffected.
 */

/** Shortest SESSION_SECRET accepted. The rotation scripts generate 43 characters. */
export const MIN_SESSION_SECRET_LENGTH = 32;

/*
 * What to do about an unusable password hash or session secret, as every log
 * line that reports one says it — one wording, so they cannot point different
 * ways. The tool is the host's: production is a Docker container reading
 * `.env` on the host, and `scripts/set-password.mjs` needs nothing but Node,
 * where `pnpm server:password` needs the dev toolchain and `pnpm
 * deploy:secrets` writes to Fly, which serves nothing. The container reads
 * `.env` only when it is created, hence `up -d`.
 */
const RECREATE = 'then recreate the container with `docker compose up -d` (`docker compose restart` keeps the old values).';

/** The fix for a hash that does not parse: regenerate it on the host. */
export const PASSWORD_HASH_REMEDY =
  'On the host, run `node scripts/set-password.mjs "<password>"`, which rewrites APP_PASSWORD_HASH and ' +
  `SESSION_SECRET in .env; ${RECREATE}`;

/** The fix for a session secret that is too short: the same tool, or a secret of your own. */
export const SESSION_SECRET_REMEDY =
  'On the host, run `node scripts/set-password.mjs "<password>"`, which rewrites APP_PASSWORD_HASH and ' +
  `SESSION_SECRET in .env, or set SESSION_SECRET to ${MIN_SESSION_SECRET_LENGTH}+ random characters; ${RECREATE}`;

type Env = Record<string, string | undefined>;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(message);
}

/** SESSION_SECRET, or null when it is missing or too short to trust. */
export function sessionSecret(env: Env = process.env): string | null {
  const secret = env.SESSION_SECRET;
  if (!secret) return null;
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    warnOnce(
      'short-session-secret',
      `[auth] SESSION_SECRET is ${secret.length} characters; at least ${MIN_SESSION_SECRET_LENGTH} are required. ` +
        `Sign-in is disabled until it is replaced. ${SESSION_SECRET_REMEDY}`,
    );
    return null;
  }
  return secret;
}

const encoder = new TextEncoder();
const derived = new Map<string, Promise<Uint8Array>>();

/**
 * Derives a sub-key from SESSION_SECRET with HKDF-SHA256.
 *
 * A separate `info` per purpose keeps the keys independent: a token signed for
 * one purpose can never be decrypted or verified as another, and knowing one
 * derived key reveals nothing about the session secret or its siblings.
 * WebCrypto rather than `node:crypto` so the proxy can use it too.
 */
function deriveKey(secret: string, purpose: string): Promise<Uint8Array> {
  const cacheKey = `${purpose}\u0000${secret}`;
  let key = derived.get(cacheKey);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('wiki-valheim'), info: encoder.encode(purpose) },
        base,
        256,
      );
      return new Uint8Array(bits);
    })();
    derived.set(cacheKey, key);
  }
  return key;
}

/**
 * The 256-bit key that encrypts a reader's own Gemini key in their cookie.
 *
 * `BYOK_SECRET` (32 random bytes, base64url) when set, so it can be rotated —
 * forcing everyone to paste their key again — without signing every password
 * holder out. Otherwise derived from SESSION_SECRET, so the feature works on
 * an existing deployment with no new configuration. Null when neither is
 * usable, which turns the feature off.
 */
export async function byokEncryptionKey(env: Env = process.env): Promise<Uint8Array | null> {
  const explicit = env.BYOK_SECRET;
  if (explicit) {
    let key: Uint8Array;
    try {
      key = base64url.decode(explicit.trim());
    } catch {
      key = new Uint8Array(0);
    }
    if (key.length !== 32) {
      warnOnce(
        'bad-byok-secret',
        '[auth] BYOK_SECRET must be 32 random bytes encoded as base64url (43 characters). ' +
          'Gemini-key sign-in is disabled until it is fixed.',
      );
      return null;
    }
    return key;
  }
  const secret = sessionSecret(env);
  return secret ? deriveKey(secret, 'byok-cookie-a256gcm-v1') : null;
}

/**
 * Key for HS256 tokens of one purpose (Puter sessions, answer grants).
 *
 * Derived rather than the raw SESSION_SECRET so that no token minted for a
 * guest can ever verify as a password session, even if an audience check were
 * dropped somewhere by mistake.
 */
export async function purposeKey(purpose: string, env: Env = process.env): Promise<Uint8Array | null> {
  const secret = sessionSecret(env);
  return secret ? deriveKey(secret, `hs256-${purpose}-v1`) : null;
}
