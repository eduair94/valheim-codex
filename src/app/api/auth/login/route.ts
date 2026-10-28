import type { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  createLoginDeviceToken,
  LOGIN_DEVICE_COOKIE,
  loginDeviceCookieOptions,
  verifyLoginDeviceToken,
} from '@/lib/auth/login-device';
import { isSameOriginRequest } from '@/lib/auth/origin';
import { parsePasswordHash, verifyPasswordThrottled } from '@/lib/auth/password';
import {
  checkLoginRateLimit,
  clearLoginRateLimit,
  clientIp,
  networkOf,
  recordLoginFailure,
  type RateLimitResult,
} from '@/lib/auth/rate-limit';
import { authError, authJson, clearAuthCookies, isProduction, noStore, setAuthCookie } from '@/lib/auth/responses';
import { MIN_SESSION_SECRET_LENGTH, PASSWORD_HASH_REMEDY, sessionSecret } from '@/lib/auth/secrets';
import { createSessionToken, normaliseProfile, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/auth/session';
import { getDb } from '@/lib/db/client';
import { readJsonBody } from '@/lib/http/json-body';
import { logError, logWarn } from '@/lib/log';

export const runtime = 'nodejs';

const bodySchema = z.object({
  password: z.string().min(1).max(1024),
  profile: z.string().min(1).max(256),
});

/** Seconds a client is told to wait when every verification slot is taken. */
const BUSY_RETRY_SECONDS = 5;

/** The 429 for a spent window, the same whichever ceiling was reached. */
function windowSpent(limit: RateLimitResult): Response {
  const retryAfter = Math.max(1, Math.ceil((limit.resetAt.getTime() - Date.now()) / 1000));
  return authJson(
    { error: 'rate_limited', resetAt: limit.resetAt.toISOString(), retryAfter },
    429,
    { 'Retry-After': String(retryAfter) },
  );
}

/**
 * Signs in with the shared password.
 *
 * `{ password, profile }` → `{ ok, mode: 'password', profile }`, and the
 * session cookie. Any Gemini-key or Puter cookie is cleared: one way of being
 * signed in at a time. The browser also gets, or renews, the known-browser
 * cookie (`login-device.ts`) that keeps it out of the limiter's lockouts.
 */
export async function POST(request: NextRequest): Promise<Response> {
  // Login CSRF: a forged sign-in would file the victim's next questions under
  // a profile the attacker chose.
  if (!isSameOriginRequest(request.headers)) return authError('forbidden_origin', 403);

  /*
   * Report an unusable configuration as such, never as a wrong password. The
   * failure this guards against is quiet and confusing: a hash pasted into
   * `.env` with `$` separators is mangled by env-var expansion, or a secret
   * too short to sign with is refused, and every login then fails with
   * nothing to debug. The details go to the log, not to the visitor.
   */
  const passwordHash = process.env.APP_PASSWORD_HASH;
  const secret = sessionSecret();
  if (!passwordHash || !secret || !parsePasswordHash(passwordHash)) {
    console.error(
      '[auth] Password sign-in is misconfigured: APP_PASSWORD_HASH must be a scrypt hash and SESSION_SECRET ' +
        `at least ${MIN_SESSION_SECRET_LENGTH} characters. ${PASSWORD_HASH_REMEDY}`,
    );
    return authError('server_misconfigured', 500);
  }

  const body = await readJsonBody(request, bodySchema, 4 * 1024);
  if (!body.ok) return noStore(body.response);

  const profile = normaliseProfile(body.data.profile);
  if (!profile) return authError('invalid_profile', 400);

  const db = await getDb();
  const ip = clientIp(request.headers);
  const device = await verifyLoginDeviceToken(request.cookies.get(LOGIN_DEVICE_COOKIE)?.value, passwordHash, secret);
  const subject = { ip, device };

  let limit: RateLimitResult;
  try {
    limit = await checkLoginRateLimit(db, subject);
  } catch (error) {
    // Without a count there is no brute-force ceiling: refuse rather than
    // let guesses through uncounted.
    logError('auth', error, { step: 'login-rate-limit' });
    return authError('unavailable', 503);
  }
  if (!limit.allowed) return windowSpent(limit);
  /*
   * The window's shared budget of failures is spent — guessing from many
   * networks at once. A browser that has never signed in waits for the next
   * window; one that has is let through, counted on its own.
   */
  if (limit.guarded && !device) return windowSpent(limit);

  const ok = await verifyPasswordThrottled(body.data.password, passwordHash, {
    network: networkOf(ip),
    known: device !== null,
  });
  if (ok === null) {
    return authJson({ error: 'rate_limited', retryAfter: BUSY_RETRY_SECONDS }, 429, {
      'Retry-After': String(BUSY_RETRY_SECONDS),
    });
  }
  if (!ok) {
    try {
      const { failures, guardClosed } = await recordLoginFailure(db);
      if (guardClosed) {
        logWarn(
          'auth',
          'Password sign-in is guarded until the end of this 15-minute window: too many failed attempts. ' +
            'Browsers that have signed in before still can.',
          { failures, until: limit.resetAt.toISOString() },
        );
      }
    } catch (error) {
      logError('auth', error, { step: 'login-failure-count' });
    }
    // Deliberately vague: the response must not distinguish a wrong password
    // from an unknown profile, since the profile is not a credential. No
    // attempts-remaining count either: it only told a guesser whether each
    // spoofed address had bought a fresh window.
    return authError('invalid_credentials', 401);
  }

  await clearLoginRateLimit(db, subject).catch((error: unknown) => logError('auth', error, { step: 'login-clear' }));

  const token = await createSessionToken({ profile }, secret);
  const response = authJson({ ok: true, mode: 'password', profile });
  clearAuthCookies(response, SESSION_COOKIE);
  setAuthCookie(response, SESSION_COOKIE, token, SESSION_MAX_AGE);
  response.cookies.set(
    LOGIN_DEVICE_COOKIE,
    await createLoginDeviceToken(passwordHash, secret, device ?? undefined),
    loginDeviceCookieOptions(isProduction()),
  );
  return response;
}
