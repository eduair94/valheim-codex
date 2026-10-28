import type { ChatErrorData } from '@/lib/chat-types';
import type { Strings } from '@/lib/i18n/strings';

/**
 * What went wrong with a question, in terms the reader can act on.
 *
 * The AI SDK's HTTP transport turns any failed response into
 * `new Error(await response.text())`, so the chat used to print whatever the
 * body was: `{"error":"unauthorized"}` when a session ran out, a whole
 * Cloudflare 502 page during a deploy, the browser's English "Failed to fetch"
 * in a Spanish interface. And "Reintentar" only hid the message.
 *
 * Now every failure is reduced to a code — the `{ error }` of a JSON body,
 * the transient `data-error` part a stream sends before its error, or one of
 * the codes the Puter transport maps Puter's refusals to — and the code
 * decides both the sentence (from the copy, in the language on screen now,
 * not the one the error arrived in) and what the reader can do next. No body,
 * header or provider message is ever shown as it came.
 */

/** A request that failed before an answer started, with what the server said about it. */
export class ChatRequestError extends Error {
  override readonly name = 'ChatRequestError';
  /** HTTP status; null when no response arrived (network) or the failure is the browser's own. */
  readonly status: number | null;
  /** The `{ error }` code, `network`, or a client code such as `puter_signed_out`. */
  readonly code: string;
  /** Seconds to wait, from the body's `retryAfter` or the `Retry-After` header. */
  readonly retryAfter: number | undefined;
  /** Extra detail some codes carry (`question_too_long` → `{ max }`). */
  readonly max: number | undefined;

  constructor(init: { code: string; status?: number | null; retryAfter?: number; max?: number }) {
    // The code, never a body: this message can end up in a log or a console.
    super(init.code);
    this.code = init.code;
    this.status = init.status ?? null;
    this.retryAfter = init.retryAfter;
    this.max = init.max;
  }
}

/** A code is a short snake_case word; anything else in `error` is not one of ours. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Bodies bigger than this are not error envelopes (a proxy's HTML page, most likely). */
const MAX_ERROR_BODY = 4096;

/** `Retry-After` in seconds: delta-seconds or an HTTP date. */
export function retryAfterFrom(header: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? seconds : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const seconds = Math.ceil((date - now) / 1000);
  return seconds > 0 ? seconds : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

/**
 * The code a status stands for when the body names none. Not every refusal
 * comes from this app: an edge rate-limit rule (spec §7 recommends one on
 * `/api/chat*` and `/api/auth/*`) answers 429 with its own HTML page, a
 * gateway answers 502 or 504 during a deploy. Read as `http_429` they got
 * "something went wrong" and an immediate retry, the very burst the limit
 * was there to stop, even though the `Retry-After` was read.
 */
function codeForStatus(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  return `http_${status}`;
}

/**
 * Reads a failed response into a `ChatRequestError`.
 *
 * The body is read as text and parsed only if it is a small JSON object with
 * a code in it. Otherwise — an HTML page, an empty body — the status decides
 * (`codeForStatus`): `http_<status>` for anything without a meaning of its
 * own, such as an empty 500.
 */
export async function errorFromResponse(response: Response): Promise<ChatRequestError> {
  let body: Record<string, unknown> | null = null;
  try {
    const text = await response.text();
    if (text.length <= MAX_ERROR_BODY && text.trimStart().startsWith('{')) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    }
  } catch {
    // Unreadable or not JSON: the status is all there is to go on.
  }
  const raw = body?.['error'];
  const code = typeof raw === 'string' && CODE.test(raw) ? raw : codeForStatus(response.status);
  return new ChatRequestError({
    code,
    status: response.status,
    retryAfter: positiveNumber(body?.['retryAfter']) ?? retryAfterFrom(response.headers.get('retry-after')),
    max: positiveNumber(body?.['max']),
  });
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * The browser could not reach the server: `fetch` rejects with a `TypeError`
 * ("Failed to fetch", Safari's "Load failed", Firefox's "NetworkError…"), and
 * a stream cut mid-answer fails the same way.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof ChatRequestError) return error.code === 'network';
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TypeError';
}

/** A failure, reduced to what the interface needs to know. */
export type ChatFailure = {
  code: string;
  status: number | null;
  retryAfter?: number;
  max?: number;
};

/**
 * The failure behind the chat's `error`.
 *
 * - A `ChatRequestError`: the request was refused before an answer started.
 * - A `TypeError`: the network.
 * - Anything else came from inside a stream, whose `data-error` part (passed
 *   in as `streamed`) carries the code. A stream error without one (the
 *   route's last-resort handler, a proxy cutting the stream) is `generic`.
 *
 * The error's own message is never used: for a stream error it is the
 * server's sentence in the language the question was asked in, which may no
 * longer be the one on screen.
 */
export function failureOf(error: unknown, streamed: ChatErrorData | null): ChatFailure {
  if (error instanceof ChatRequestError) {
    return { code: error.code, status: error.status, retryAfter: error.retryAfter, max: error.max };
  }
  if (isNetworkError(error)) return { code: 'network', status: null };
  if (streamed && CODE.test(streamed.code)) {
    return { code: streamed.code, status: null, retryAfter: positiveNumber(streamed.retryAfter) };
  }
  return { code: 'generic', status: null };
}

/**
 * What the reader can do about a failure.
 *
 * - `retry`: send the same question again (after `wait`, when there is one).
 * - `signin`: the session is gone; connect again and come back to this thread.
 * - `reconnect-puter`: sign in to Puter again in this browser (a click, so the
 *   popup is allowed).
 * - `change-key` / `change-model` / `change-method`: what a key, a model or a
 *   way of connecting cannot do, another one can.
 * - `new-chat`: this conversation is gone.
 * - `reload`: this page is out of step with the server (signed in another way
 *   in another tab, or a request the server refused as cross-site).
 * - `dismiss`: nothing to do now but read it.
 */
export type FailureAction =
  | 'retry'
  | 'signin'
  | 'reconnect-puter'
  | 'change-key'
  | 'change-model'
  | 'change-method'
  | 'new-chat'
  | 'reload'
  | 'dismiss';

export type FailureView = {
  text: string;
  /** In order of importance; the first is the main one. */
  actions: FailureAction[];
  /** Seconds before `retry` makes sense. */
  wait?: number;
};

/**
 * A notice about something the reader did — an index update queued, a
 * conversation that could not be opened. Kept as a function of the copy, not
 * as a sentence, so switching language changes it too.
 */
export type Notice = { text: (t: Strings) => string; actions?: FailureAction[] };

/**
 * "41 segundos", "3 minutos", "5 horas": a wait as a reader says it. Hours
 * because a daily allowance answers with a wait until midnight, which in
 * minutes reads as a malfunction.
 */
export function waitPhrase(seconds: number, t: Strings): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s === 1) return t.chatWaitSecond;
  if (s < 120) return t.chatWaitSeconds.replace('{n}', String(s));
  if (s < 2 * 3600) return t.chatWaitMinutes.replace('{n}', String(Math.ceil(s / 60)));
  return t.chatWaitHours.replace('{n}', String(Math.ceil(s / 3600)));
}

function withWait(template: string, wait: number | undefined, t: Strings, fallback: string): string {
  return wait ? template.replace('{wait}', waitPhrase(wait, t)) : fallback;
}

/** The sentence and the actions for a failure, in the language on screen. */
export function describeFailure(failure: ChatFailure, t: Strings): FailureView {
  const { code, retryAfter: wait } = failure;
  switch (code) {
    case 'network':
      return { text: t.errorNetwork, actions: ['retry'] };

    // The session ended (expired, signed out in another tab, a rotated
    // secret), or Puter's session could not be renewed.
    case 'unauthorized':
      return { text: t.chatErrorSessionEnded, actions: ['signin'] };
    case 'forbidden_origin':
      return { text: t.authErrorForbiddenOrigin, actions: ['reload'] };
    case 'forbidden':
      return { text: t.chatErrorForbidden, actions: ['change-method'] };
    case 'use_puter_transport':
    case 'use_server_transport':
      return { text: t.chatErrorMethodChanged, actions: ['reload'] };

    case 'question_too_long':
    case 'payload_too_large':
      return {
        text: failure.max ? t.chatErrorTooLongMax.replace('{n}', String(failure.max)) : t.chatErrorTooLong,
        actions: ['dismiss'],
      };
    case 'conversation_not_found':
    case 'not_found':
      return { text: t.chatErrorNotFound, actions: ['new-chat'] };

    case 'rate_limited':
      return {
        text: withWait(t.chatErrorRateLimitedWait, wait, t, t.chatErrorRateLimited),
        actions: ['retry'],
        wait,
      };
    case 'quota_unavailable':
    case 'unavailable':
      return { text: t.chatErrorUnavailable, actions: ['retry'], wait };

    // Streamed failures (`data-error` codes, src/lib/chat-server/errors.ts).
    case 'providers_exhausted':
      // "Wait a few minutes": an immediate retry button would contradict it
      // and invite the loop the limit exists to stop. The failed answer keeps
      // its own retry for later.
      return { text: t.errorRateLimited, actions: ['dismiss'] };
    case 'timeout':
      return { text: t.chatErrorTimeout, actions: ['retry'] };
    case 'interrupted':
      return { text: t.chatErrorInterrupted, actions: ['retry'] };
    case 'empty_answer':
      return { text: t.chatErrorEmptyAnswer, actions: ['dismiss', 'retry'] };
    case 'byok_key_invalid':
      return { text: t.chatErrorByokKeyInvalid, actions: ['change-key'] };
    case 'byok_quota':
      // A short limit says how long; a spent daily allowance has no wait and
      // renews at midnight Pacific time.
      return wait
        ? { text: withWait(t.chatErrorByokQuotaWait, wait, t, t.chatErrorByokQuotaDaily), actions: ['retry', 'change-key'], wait }
        : { text: t.chatErrorByokQuotaDaily, actions: ['change-key', 'dismiss'] };
    // The model menu is in the sidebar; the retry stays here for after.
    case 'byok_model_unavailable':
      return { text: t.chatErrorByokModel, actions: ['change-model', 'retry'] };
    case 'byok_region_unavailable':
      return { text: t.chatErrorByokRegion, actions: ['change-method'] };

    // The Puter transport's own codes (`./puter-errors.ts`).
    case 'puter_signed_out':
      return { text: t.chatErrorPuterSignedOut, actions: ['reconnect-puter'] };
    case 'puter_popup_blocked':
      return { text: t.authErrorPuterPopupBlocked, actions: ['reconnect-puter'] };
    case 'puter_auth_closed':
      return { text: t.authErrorPuterWindowClosed, actions: ['reconnect-puter'] };
    case 'puter_insufficient_funds':
      return { text: t.chatErrorPuterFunds, actions: ['change-method', 'dismiss'] };
    case 'puter_subscription_required':
      return { text: t.chatErrorPuterSubscription, actions: ['change-model', 'retry'] };
    case 'puter_rate_limited':
      return { text: t.chatErrorPuterRateLimited, actions: ['retry'], wait };
    case 'puter_failed':
      return { text: t.chatErrorPuterFailed, actions: ['retry'] };

    default:
      return { text: t.errorGeneric, actions: ['retry'] };
  }
}
