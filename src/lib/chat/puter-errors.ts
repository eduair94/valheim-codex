/**
 * Puter's refusals, mapped to the codes the chat acts on.
 *
 * puter.js rejects with plain objects rather than `Error`s, in several shapes
 * (`networkUtils.js` in puter.js 2.6.4):
 *
 * - `{ status: 401, message: 'Unauthorized' }` for a bad or expired token;
 * - the API's error body, `{ error, message, code[, errorCode] }`, sometimes
 *   wrapped as `{ success: false, error: { code, message } }`;
 * - `{ error: { code: 'auth_canceled' } }` when it opened its own sign-in and
 *   the reader dismissed it;
 * - the `XMLHttpRequest` itself when the network failed;
 * - and inside a stream, an `{ type: 'error', message, code?, status? }` chunk.
 *
 * So the codes and statuses are gathered from wherever they sit, and matched
 * on meaning. Nothing Puter says is shown to the reader as it came.
 */

export type PuterChatCode =
  /** No usable Puter session in this browser: sign in again (a click). */
  | 'puter_signed_out'
  /** HTTP 402: the reader's Puter balance is spent. */
  | 'puter_insufficient_funds'
  /** HTTP 402 for a model that needs a paid Puter plan. */
  | 'puter_subscription_required'
  /** HTTP 429, or credit held by the reader's other running requests. */
  | 'puter_rate_limited'
  | 'puter_failed';

export type PuterSignInCode =
  | 'puter_popup_blocked'
  | 'puter_auth_closed'
  /** Puter cannot sign in from this page (an app frame, an opaque origin). */
  | 'puter_unsupported'
  | 'puter_auth_timeout'
  | 'puter_failed';

type Signals = { codes: Set<string>; statuses: Set<number> };

function collect(value: unknown, signals: Signals, depth = 0): void {
  if (depth > 3 || typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  for (const key of ['code', 'errorCode', 'error'] as const) {
    const field = record[key];
    if (typeof field === 'string') signals.codes.add(field.toLowerCase());
  }
  for (const key of ['status', 'statusCode'] as const) {
    const field = record[key];
    if (typeof field === 'number' && field > 0) signals.statuses.add(field);
  }
  collect(record['error'], signals, depth + 1);
}

function signalsOf(error: unknown): Signals {
  const signals: Signals = { codes: new Set(), statuses: new Set() };
  collect(error, signals);
  return signals;
}

const SIGNED_OUT = ['token_auth_failed', 'reauth_required', 'token_missing', 'unauthorized', 'auth_canceled'];
const RATE_LIMITED = ['too_many_requests', 'credits_reserved', 'rate_limited'];

/** A rejection from `puter.ai.chat`, or an error chunk from its stream. */
export function puterChatErrorCode(error: unknown): PuterChatCode {
  const { codes, statuses } = signalsOf(error);
  const has = (list: string[]) => list.some((code) => codes.has(code));
  if (has(SIGNED_OUT) || statuses.has(401)) return 'puter_signed_out';
  if (codes.has('subscription_required')) return 'puter_subscription_required';
  if (codes.has('insufficient_funds') || statuses.has(402)) return 'puter_insufficient_funds';
  if (has(RATE_LIMITED) || statuses.has(429)) return 'puter_rate_limited';
  return 'puter_failed';
}

/**
 * A rejection from `puter.auth.signIn()`: `{ error: 'popup_blocked' |
 * 'auth_window_closed' | 'not_available_in_app' | 'unsupported_origin' |
 * 'auth_timeout', msg }`.
 */
export function puterSignInErrorCode(error: unknown): PuterSignInCode {
  const { codes } = signalsOf(error);
  if (codes.has('popup_blocked')) return 'puter_popup_blocked';
  if (codes.has('auth_window_closed') || codes.has('auth_canceled')) return 'puter_auth_closed';
  if (codes.has('not_available_in_app') || codes.has('unsupported_origin')) return 'puter_unsupported';
  if (codes.has('auth_timeout')) return 'puter_auth_timeout';
  return 'puter_failed';
}
