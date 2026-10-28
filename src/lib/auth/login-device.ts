import { createHash, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { authCookieName } from './session';

/**
 * "This browser has signed in with the password before."
 *
 * The login limiter's last line is a budget of failed attempts shared by
 * everyone (`rate-limit.ts`). On its own that budget is a lockout switch: an
 * attacker spends it from a few addresses and nobody gets in. A browser that
 * has signed in successfully carries this cookie, and with it a sign-in is
 * counted against the browser instead — not against its address, its network
 * or the shared budget — and gets its own places in the verification queue.
 * Returning readers keep getting in while a flood from everywhere else is
 * held to the budget. (OWASP's "device cookie" defence against online
 * guessing.)
 *
 * It proves the *current* password was known: the token carries a
 * fingerprint of the stored hash, so rotating the password retires every
 * one of them, and a former holder keeps no head start on the new one. It
 * authorises nothing by itself — the password is still checked — so it is
 * not one of the auth cookies, and signing out leaves it in place.
 */

export const LOGIN_DEVICE_COOKIE = authCookieName('wv_device');
/** 180 days, in seconds; renewed on every successful sign-in. */
export const LOGIN_DEVICE_MAX_AGE = 60 * 60 * 24 * 180;

const ISSUER = 'wiki-valheim';
/** Its own audience, so a session token can never pass for one, nor the reverse. */
const AUDIENCE = 'wiki-valheim-login-device';

/**
 * A short digest of the stored hash. The hash embeds a random salt, so this
 * says nothing about the password: a guess cannot be checked against it
 * without the salt, which never leaves the server.
 */
function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('base64url').slice(0, 22);
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Issues the token for a browser that just signed in; `id` is kept across renewals. */
export async function createLoginDeviceToken(
  passwordHash: string,
  secret: string,
  id: string = randomUUID(),
  maxAgeSeconds: number = LOGIN_DEVICE_MAX_AGE,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ pw: passwordFingerprint(passwordHash) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(id)
    .setIssuedAt(now)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(now + maxAgeSeconds)
    .sign(secretKey(secret));
}

/**
 * The browser's id when its token is valid for the current password, or null:
 * missing, forged, expired, minted for another purpose, or from before the
 * password changed.
 */
export async function verifyLoginDeviceToken(
  token: string | undefined,
  passwordHash: string,
  secret: string,
): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (payload['pw'] !== passwordFingerprint(passwordHash)) return null;
    const id = payload.sub;
    return typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * `Strict`: only the sign-in request itself, from this site, ever needs it.
 * The rest as for the auth cookies (`__Host-` in production, so Secure,
 * `Path=/`, no Domain).
 */
export function loginDeviceCookieOptions(isProduction: boolean, maxAge: number = LOGIN_DEVICE_MAX_AGE) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict' as const,
    path: '/',
    maxAge,
  };
}
