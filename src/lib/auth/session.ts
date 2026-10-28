import { jwtVerify, SignJWT } from 'jose';

/**
 * Name for an auth cookie.
 *
 * `__Host-` in production. With that prefix the browser accepts the cookie
 * only when it is Secure, has `Path=/` and carries no `Domain`, so no sibling
 * subdomain of digitalshopuy.com can plant or overwrite it — the same-site
 * neighbour that `SameSite=Lax` does not keep out. Development runs on plain
 * http with `secure: false`, which the prefix forbids, so it keeps the bare
 * name there.
 */
export function authCookieName(base: string): string {
  return process.env.NODE_ENV === 'production' ? `__Host-${base}` : base;
}

export const SESSION_COOKIE = authCookieName('wv_session');
/** 30 days, in seconds. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Cookie names from before the `__Host-` prefix, cleared on logout so an old
 * browser does not keep a dead token around for a month.
 */
export const LEGACY_AUTH_COOKIES: readonly string[] =
  process.env.NODE_ENV === 'production' ? ['wv_session'] : [];

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

/**
 * Attributes shared by every auth cookie. `secure` is off on http://localhost
 * or the cookie is dropped.
 *
 * `Lax`, not `Strict`: arriving at the chat from a link in another site or an
 * installed-app shortcut must still carry the cookie. Lax already withholds it
 * from cross-site POSTs, and every mutating route checks the request origin on
 * top of that.
 */
export function authCookieOptions(isProduction: boolean, maxAge: number) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

/** Cookie attributes for the password session. */
export function sessionCookieOptions(isProduction: boolean) {
  return authCookieOptions(isProduction, SESSION_MAX_AGE);
}

/**
 * Attributes that delete an auth cookie.
 *
 * `cookies().delete(name)` writes a bare `name=; Expires=…` with no Secure
 * flag, which the browser refuses for a `__Host-` cookie — the cookie would
 * survive logout. Expiring it with the same attributes it was set with works
 * for both names.
 */
export function clearedCookieOptions(isProduction: boolean) {
  return authCookieOptions(isProduction, 0);
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
