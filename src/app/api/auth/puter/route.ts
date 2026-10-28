import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { clientIp } from '@/lib/auth/client-ip';
import { puterExchangeBuckets } from '@/lib/auth/limits';
import { isSameOriginRequest } from '@/lib/auth/origin';
import { guestModes } from '@/lib/auth/principal';
import { createPuterSessionToken, PUTER_COOKIE, PUTER_MAX_AGE } from '@/lib/auth/puter';
import { PUTER_ERROR_STATUS, puterOrigins } from '@/lib/auth/puter-signin';
import { configuredPuterAppUids, verifyPuterToken } from '@/lib/auth/puter-verify';
import { consumeQuota, quotaExceededResponse } from '@/lib/auth/quota';
import { authError, authJson, clearAuthCookie, clearAuthCookies, noStore, setAuthCookie } from '@/lib/auth/responses';
import { purposeKey } from '@/lib/auth/secrets';
import { puterExchangeGlobalBuckets } from '@/lib/auth/signin-limits';
import { getDb } from '@/lib/db/client';
import { readJsonBody } from '@/lib/http/json-body';
import { logError } from '@/lib/log';

export const runtime = 'nodejs';

/**
 * Signing in with Puter.
 *
 * The browser hands over the Puter token it just got from `puter.auth`; this
 * asks Puter who it belongs to and whether it was issued to this site, then
 * issues this app's own one-day cookie. The Puter token itself is not kept:
 * the model runs in the reader's browser, on their Puter balance.
 */

const bodySchema = z.object({ token: z.string().min(1).max(4096) });

/** Seconds to wait when the quota store cannot be read. */
const QUOTA_RETRY_SECONDS = 30;

/** `{ token }` → `{ ok, mode: 'puter', name }`. */
export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return authError('forbidden_origin', 403);

  const sessionKey = guestModes().puter ? await purposeKey('puter-session') : null;
  if (!sessionKey) return authError('puter_disabled', 404);

  const body = await readJsonBody(request, bodySchema, 8 * 1024);
  if (!body.ok) return noStore(body.response);

  // Each exchange costs two calls to Puter, per address and in all; guests
  // fail closed when the count cannot be taken.
  try {
    const decision = await consumeQuota(await getDb(), [
      ...puterExchangeBuckets(clientIp(request.headers)),
      ...puterExchangeGlobalBuckets(),
    ]);
    if (!decision.allowed) return noStore(quotaExceededResponse(decision));
  } catch (error) {
    logError('puter', error, { step: 'quota' });
    return authJson({ error: 'unavailable', retryAfter: QUOTA_RETRY_SECONDS }, 503, {
      'Retry-After': String(QUOTA_RETRY_SECONDS),
    });
  }

  const check = await verifyPuterToken(body.data.token, {
    origins: puterOrigins(request.headers),
    allowedAppUids: configuredPuterAppUids(),
  });
  if (!check.ok) return authError(check.error, PUTER_ERROR_STATUS[check.error]);

  const name = check.identity.username;
  const token = await createPuterSessionToken({ sub: `puter:${check.identity.uuid}`, name }, sessionKey);

  const response = authJson({ ok: true, mode: 'puter', name });
  clearAuthCookies(response, PUTER_COOKIE);
  setAuthCookie(response, PUTER_COOKIE, token, PUTER_MAX_AGE);
  return response;
}

/** Disconnects Puter from this site. The reader's Puter account is untouched. */
export async function DELETE(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return authError('forbidden_origin', 403);
  const response = authJson({ ok: true });
  clearAuthCookie(response, PUTER_COOKIE);
  return response;
}
