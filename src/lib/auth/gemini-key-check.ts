import { logWarn } from '@/lib/log';
import type { ByokModel } from './byok';

/**
 * Asks Google whether a reader's Gemini key works, before it is sealed into
 * their cookie.
 *
 * Two calls, both with the key in the `x-goog-api-key` header — never in a
 * `?key=` parameter, which would put it in every URL an error message, a
 * proxy log or a stack trace prints:
 *
 * 1. `GET models/{model}` costs nothing and tells a key Google does not know
 *    (400 `API_KEY_INVALID`, 401, 403) from one it does.
 * 2. `generateContent` with a one-word prompt and a one-token answer is the
 *    only way to learn whether this key may run this model at all: a project
 *    in a country Gemini does not serve passes the first call and fails this
 *    one with `FAILED_PRECONDITION`, a project without access to the model
 *    gets 404, and one already over its quota gets 429.
 *
 * One timeout covers both, so a slow Google cannot hold the request open for
 * more than eight seconds.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 8_000;

export type GeminiKeyError =
  /** Google does not accept the key: unknown, revoked, or not allowed this API. */
  | 'byok_key_invalid'
  /** The key works, but not with this model. */
  | 'byok_model_unavailable'
  /** The key works but is over its quota right now. */
  | 'byok_key_rate_limited'
  /** Gemini is not offered where the key's project is. */
  | 'byok_region_unavailable'
  /** Google could not be reached, or answered with its own failure. */
  | 'byok_unreachable';

export type GeminiKeyCheck = { ok: true } | { ok: false; error: GeminiKeyError };

/** The status each failure is reported with. */
export const GEMINI_KEY_ERROR_STATUS: Record<GeminiKeyError, number> = {
  byok_key_invalid: 400,
  byok_model_unavailable: 400,
  byok_key_rate_limited: 429,
  byok_region_unavailable: 400,
  byok_unreachable: 502,
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GeminiKeyCheckOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

type Step = 'metadata' | 'generate';

/** `error.status` and the `ErrorInfo` reasons of a Google API error body. */
function googleError(body: unknown): { status: string | null; reasons: string[] } {
  const error = (body as { error?: { status?: unknown; details?: unknown } } | null)?.error;
  const status = typeof error?.status === 'string' ? error.status : null;
  const details = Array.isArray(error?.details) ? error.details : [];
  const reasons = details
    .map((detail) => (detail as { reason?: unknown } | null)?.reason)
    .filter((reason): reason is string => typeof reason === 'string');
  return { status, reasons };
}

/**
 * Maps a failed call onto what the reader can do about it.
 *
 * A 400 means different things on the two calls: the metadata call has no
 * body to get wrong, so any 400 there is the key; on the generation call a
 * 400 that is neither the key nor the region means this model refused the
 * request.
 */
export function classifyGoogleFailure(step: Step, httpStatus: number, body: unknown): GeminiKeyError {
  const { status, reasons } = googleError(body);
  if (reasons.includes('API_KEY_INVALID')) return 'byok_key_invalid';
  if (httpStatus === 400 && status === 'FAILED_PRECONDITION') return 'byok_region_unavailable';
  if (httpStatus === 401 || httpStatus === 403) return 'byok_key_invalid';
  if (httpStatus === 404) return 'byok_model_unavailable';
  if (httpStatus === 429) return 'byok_key_rate_limited';
  if (httpStatus === 400) return step === 'metadata' ? 'byok_key_invalid' : 'byok_model_unavailable';
  return 'byok_unreachable';
}

async function call(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<{ status: number; ok: boolean; body: unknown } | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, cache: 'no-store' });
  } catch {
    return null;
  }
  if (response.ok) {
    // The answer itself is of no use; release the connection. Not awaited:
    // nothing here depends on when the stream finishes closing.
    void response.body?.cancel().catch(() => {});
    return { status: response.status, ok: true, body: null };
  }
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: false, body };
}

export async function checkGeminiKey(
  key: string,
  model: ByokModel,
  options: GeminiKeyCheckOptions = {},
): Promise<GeminiKeyCheck> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
  const auth = { 'x-goog-api-key': key };

  const steps: [Step, string, RequestInit][] = [
    ['metadata', `${API}/models/${model}`, { method: 'GET', headers: auth, signal }],
    [
      'generate',
      `${API}/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
        signal,
      },
    ],
  ];

  for (const [step, url, init] of steps) {
    const result = await call(fetchImpl, url, init);
    if (!result) return { ok: false, error: 'byok_unreachable' };
    if (result.ok) continue;
    const error = classifyGoogleFailure(step, result.status, result.body);
    if (error === 'byok_unreachable') {
      // Google's own failure, worth knowing about. Status and step only: the
      // body is Google's, and the request carried the reader's key.
      logWarn('byok', `Gemini answered ${result.status} while checking a key (${step})`, { model });
    }
    return { ok: false, error };
  }
  return { ok: true };
}
