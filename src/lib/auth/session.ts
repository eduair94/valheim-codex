import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE = 'wv_session';
/** 30 days, in seconds. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

const ISSUER = 'wiki-valheim';
const AUDIENCE = 'wiki-valheim-app';

export type SessionPayload = {
  /** Profile name chosen at login; scopes the conversation history. */
  profile: string;
};

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Issues a signed session token. HS256 — one server, one shared secret. */
export async function createSessionToken(
  payload: SessionPayload,
  secret: string,
  maxAgeSeconds: number = SESSION_MAX_AGE,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ profile: payload.profile })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(now + maxAgeSeconds)
    .sign(secretKey(secret));
}

/**
 * Verifies a session token, returning null for anything not currently valid.
 *
 * `jose` checks the signature, the expiry and the issuer/audience pair. A
 * token signed with a different secret, expired, or minted for another app
 * fails here rather than being trusted for its claims.
 */
export async function verifySessionToken(
  token: string | undefined,
  secret: string,
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    const profile = payload['profile'];
    if (typeof profile !== 'string' || profile.length === 0) return null;
    return { profile };
  } catch {
    return null;
  }
}

/** Cookie attributes. `secure` is off on http://localhost or the cookie is dropped. */
export function sessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE,
  };
}

const PROFILE_MAX_LENGTH = 32;

/**
 * Normalises a profile name.
 *
 * The value ends up in a JWT claim and in a SQL filter, so it is restricted to
 * a conservative character set and a fixed length rather than trusted as typed.
 */
export function normaliseProfile(raw: string): string | null {
  const trimmed = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return null;
  const cleaned = trimmed.slice(0, PROFILE_MAX_LENGTH);
  if (!/^[\p{L}\p{N} _.-]+$/u.test(cleaned)) return null;
  return cleaned;
}
