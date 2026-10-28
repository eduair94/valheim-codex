import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  BYOK_COOKIE,
  BYOK_MAX_AGE,
  DEFAULT_BYOK_MODEL,
  isByokModel,
  isPlausibleApiKey,
  keyHint,
  newByokSubject,
  openByok,
  sealByok,
} from '@/lib/auth/byok';
import {
  BYOK_OWNER_COOKIE,
  byokKeyTag,
  byokOwnerCookieOptions,
  openByokOwners,
  rememberByokOwner,
  sealByokOwners,
  type ByokOwner,
} from '@/lib/auth/byok-owner';
import { clientIp } from '@/lib/auth/client-ip';
import { checkGeminiKey, GEMINI_KEY_ERROR_STATUS } from '@/lib/auth/gemini-key-check';
import { byokRegisterBuckets } from '@/lib/auth/limits';
import { isSameOriginRequest } from '@/lib/auth/origin';
import { guestModes } from '@/lib/auth/principal';
import { consumeQuota, quotaExceededResponse } from '@/lib/auth/quota';
import {
  authError,
  authJson,
  clearAuthCookie,
  clearAuthCookies,
  isProduction,
  noStore,
  setAuthCookie,
} from '@/lib/auth/responses';
import { byokEncryptionKey } from '@/lib/auth/secrets';
import { byokRegisterGlobalBuckets } from '@/lib/auth/signin-limits';
import { getDb } from '@/lib/db/client';
import { readJsonBody } from '@/lib/http/json-body';
import { logError } from '@/lib/log';

export const runtime = 'nodejs';

/**
 * Signing in with your own Gemini API key.
 *
 * The key is checked with Google, then sealed — AES-256-GCM, with a key only
 * this server holds — into an httpOnly cookie. It is never stored anywhere
 * else, never logged, and never sent back: the browser only ever learns its
 * last four characters. Forgetting the key is deleting the cookie. Which
 * history the key opens is remembered beside it, without the key
 * (`byok-owner.ts`), so signing in with it again here finds that history.
 */

const registerSchema = z.object({
  key: z.string().max(512),
  model: z.string().max(64).optional(),
});

const modelSchema = z.object({ model: z.string().max(64) });

/** Seconds to wait when the quota store cannot be read. */
const QUOTA_RETRY_SECONDS = 30;

/** The cookie's encryption key, or null when this deployment does not offer the feature. */
async function enabledKey(): Promise<Uint8Array | null> {
  if (!guestModes().byok) return null;
  return byokEncryptionKey();
}

/**
 * Records in the browser which history this key opens (`byok-owner.ts`),
 * whenever the key's own cookie is sealed. Renewing the record with it means
 * the record cannot run out while the key is still in use.
 */
async function rememberOwner(
  response: NextResponse,
  remembered: ByokOwner[],
  owner: ByokOwner,
  encryptionKey: Uint8Array,
): Promise<void> {
  const record = await sealByokOwners(rememberByokOwner(remembered, owner), encryptionKey);
  response.cookies.set(BYOK_OWNER_COOKIE, record, byokOwnerCookieOptions(isProduction()));
}

/**
 * `{ key, model? }` → `{ ok, mode: 'byok', keyHint, model }`.
 *
 * Order matters: nothing reaches Google until the request is same-origin,
 * well-formed, plausibly a key, for a model on offer, and within this
 * address's quota and the global one — without those ceilings the route
 * would be a free validity oracle for stolen keys.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return authError('forbidden_origin', 403);

  const encryptionKey = await enabledKey();
  if (!encryptionKey) return authError('byok_disabled', 404);

  const body = await readJsonBody(request, registerSchema, 4 * 1024);
  if (!body.ok) return noStore(body.response);

  // Pasted keys often carry a stray space or newline.
  const key = body.data.key.trim();
  if (!isPlausibleApiKey(key)) return authError('byok_key_invalid', 400);

  const model = body.data.model ?? DEFAULT_BYOK_MODEL;
  if (!isByokModel(model)) return authError('invalid_request', 400);

  // Guests fail closed: if the count cannot be taken, nothing goes to Google.
  try {
    const decision = await consumeQuota(await getDb(), [
      ...byokRegisterBuckets(clientIp(request.headers)),
      ...byokRegisterGlobalBuckets(),
    ]);
    if (!decision.allowed) return noStore(quotaExceededResponse(decision));
  } catch (error) {
    logError('byok', error, { step: 'quota' });
    return authJson({ error: 'unavailable', retryAfter: QUOTA_RETRY_SECONDS }, 503, {
      'Retry-After': String(QUOTA_RETRY_SECONDS),
    });
  }

  const check = await checkGeminiKey(key, model);
  if (!check.ok) return authError(check.error, GEMINI_KEY_ERROR_STATUS[check.error]);

  /*
   * Whose history this is. Signed in already, a new key keeps the history it
   * replaces: the subject that owns the conversations survives, only the key
   * and model inside change. Otherwise a key this browser has signed in with
   * before — before a sign-out, a "Forget key", a switch to another method,
   * or the 30 days running out — finds the history it had. Any other key
   * starts one of its own.
   */
  const previous = await openByok(request.cookies.get(BYOK_COOKIE)?.value, encryptionKey);
  const remembered = await openByokOwners(request.cookies.get(BYOK_OWNER_COOKIE)?.value, encryptionKey);
  const tag = await byokKeyTag(key, encryptionKey);
  const sub = previous?.sub ?? remembered.find((owner) => owner.tag === tag)?.sub ?? newByokSubject();
  const sealed = await sealByok({ sub, key, model }, encryptionKey);

  const response = authJson({ ok: true, mode: 'byok', keyHint: keyHint(key), model });
  clearAuthCookies(response, BYOK_COOKIE);
  setAuthCookie(response, BYOK_COOKIE, sealed, BYOK_MAX_AGE);
  await rememberOwner(response, remembered, { sub, tag }, encryptionKey);
  return response;
}

/**
 * `{ model }` → the same cookie, re-sealed with another model. The key is
 * unchanged, so Google is not asked again; a model the key cannot use shows
 * up on the next question as `byok_model_unavailable`.
 */
export async function PATCH(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return authError('forbidden_origin', 403);

  const encryptionKey = await enabledKey();
  if (!encryptionKey) return authError('byok_disabled', 404);

  const body = await readJsonBody(request, modelSchema, 1024);
  if (!body.ok) return noStore(body.response);
  const { model } = body.data;
  if (!isByokModel(model)) return authError('invalid_request', 400);

  const current = await openByok(request.cookies.get(BYOK_COOKIE)?.value, encryptionKey);
  if (!current) return authError('unauthorized', 401);

  const sealed = await sealByok({ ...current, model }, encryptionKey);
  const response = authJson({ ok: true, mode: 'byok', keyHint: keyHint(current.key), model });
  setAuthCookie(response, BYOK_COOKIE, sealed, BYOK_MAX_AGE);
  const remembered = await openByokOwners(request.cookies.get(BYOK_OWNER_COOKIE)?.value, encryptionKey);
  const tag = await byokKeyTag(current.key, encryptionKey);
  await rememberOwner(response, remembered, { sub: current.sub, tag }, encryptionKey);
  return response;
}

/**
 * Forgets the key: the cookie was its only copy. The record of which history
 * it opened stays (`byok-owner.ts`) — it holds no key — so typing the key
 * again in this browser brings the history back.
 */
export async function DELETE(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return authError('forbidden_origin', 403);
  const response = authJson({ ok: true });
  clearAuthCookie(response, BYOK_COOKIE);
  return response;
}
