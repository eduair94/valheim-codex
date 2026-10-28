import { APICallError, RetryError } from 'ai';
import type { ChatErrorData } from '@/lib/chat-types';
import { AllProvidersFailedError, EmptyResponseError, ResponseTimeoutError } from '@/lib/rag/fallback';
import type { Lang } from '@/lib/rag/prompt';

/**
 * Why an answer failed, as a code the client can act on and a sentence the
 * reader can read.
 *
 * The SDK's own error text is "An error occurred." — in English, in a Spanish
 * interface, for every cause alike. A reader can do something about most of
 * these causes: wait out a quota, fix a revoked key, pick a model their key
 * can use, rephrase a question a model refused. So each failure is classified
 * once, here, and the stream carries both the code (for the client to choose
 * an action) and the message (already in the reader's language, for anything
 * that just shows it).
 *
 * The sentences live here rather than in the UI copy because the server
 * writes them into the stream itself.
 */

export const CHAT_ERROR_CODES = [
  'providers_exhausted',
  'rate_limited',
  'timeout',
  'interrupted',
  'empty_answer',
  'byok_key_invalid',
  'byok_quota',
  'byok_model_unavailable',
  'byok_region_unavailable',
  'generic',
] as const;

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

export type ChatError = { code: ChatErrorCode; retryAfter?: number };

const MESSAGES: Record<Lang, Record<ChatErrorCode, string>> = {
  es: {
    providers_exhausted:
      'Los modelos están al límite ahora mismo. Esperá unos minutos y volvé a preguntar — la wiki se puede consultar igual.',
    rate_limited: 'Hiciste muchas consultas seguidas. Esperá un momento y volvé a preguntar.',
    timeout: 'El modelo tardó demasiado en responder. Probá de nuevo.',
    interrupted: 'Se cortó la respuesta. Probá de nuevo.',
    empty_answer: 'El modelo no pudo responder esta pregunta. Probá reformularla.',
    byok_key_invalid: 'Google rechazó tu clave de Gemini. Revisala o cargá otra.',
    byok_quota:
      'Tu clave de Gemini llegó a su límite. El cupo diario se renueva a la medianoche del Pacífico (EE. UU.).',
    byok_model_unavailable: 'Tu clave no tiene acceso a este modelo. Probá con Gemini 3.5 Flash-Lite.',
    byok_region_unavailable: 'Gemini no está disponible para tu clave en tu región o con tu plan.',
    generic: 'Algo falló. Probá de nuevo.',
  },
  en: {
    providers_exhausted:
      'The models are at their limit right now. Wait a few minutes and ask again — the wiki still works in the meantime.',
    rate_limited: 'You asked a lot in a short time. Wait a moment and ask again.',
    timeout: 'The model took too long to answer. Try again.',
    interrupted: 'The answer was cut off. Try again.',
    empty_answer: 'The model could not answer this question. Try rephrasing it.',
    byok_key_invalid: 'Google rejected your Gemini key. Check it or add another one.',
    byok_quota: 'Your Gemini key reached its limit. The daily quota resets at midnight Pacific time.',
    byok_model_unavailable: 'Your key has no access to this model. Try Gemini 3.5 Flash-Lite.',
    byok_region_unavailable: 'Gemini is not available for your key in your region or on your plan.',
    generic: 'Something broke. Try again.',
  },
};

/** "41 segundos", "1 second", "3 minutos": a wait as a reader would say it. */
function waitPhrase(seconds: number, lang: Lang): string {
  if (seconds < 120) {
    const unit = lang === 'es' ? (seconds === 1 ? 'segundo' : 'segundos') : seconds === 1 ? 'second' : 'seconds';
    return `${seconds} ${unit}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${lang === 'es' ? 'minutos' : 'minutes'}`;
}

/**
 * The reader-facing sentence for a code.
 *
 * A key's quota comes in two sizes, and they need different advice. Google's
 * free tier allows a handful of requests a minute and each question spends
 * two, so the common case is a wait of seconds, which Google states; only a
 * spent daily quota means "tomorrow". So a `byok_quota` that carries a wait
 * says how long, and one without a wait (which is how a daily limit is
 * classified) keeps the midnight sentence.
 */
export function chatErrorText(code: ChatErrorCode, lang: Lang, retryAfter?: number): string {
  if (code === 'byok_quota' && retryAfter !== undefined && retryAfter > 0) {
    const wait = waitPhrase(retryAfter, lang);
    return lang === 'es'
      ? `Tu clave de Gemini llegó a su límite de consultas por ahora. Esperá ${wait} y volvé a preguntar.`
      : `Your Gemini key hit its request limit for now. Wait ${wait} and ask again.`;
  }
  return MESSAGES[lang][code];
}

/** The transient part's payload. */
export function chatErrorData(error: ChatError): ChatErrorData {
  return error.retryAfter ? { code: error.code, retryAfter: error.retryAfter } : { code: error.code };
}

/** The error underneath the SDK's retry wrapper. */
function unwrap(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 4 && RetryError.isInstance(current); depth++) current = current.lastError;
  return current;
}

function statusOf(error: unknown): number | undefined {
  if (APICallError.isInstance(error)) return error.statusCode;
  if (typeof error === 'object' && error !== null) {
    const status = (error as { statusCode?: unknown; status?: unknown }).statusCode ?? (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** Everything a provider said about the failure, as one searchable string. */
function detailText(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  if (APICallError.isInstance(error)) {
    if (typeof error.responseBody === 'string') parts.push(error.responseBody);
    if (error.data !== undefined) {
      try {
        parts.push(JSON.stringify(error.data));
      } catch {
        /* unserialisable data carries nothing to match */
      }
    }
  } else if (!(error instanceof Error)) {
    parts.push(String(error));
  }
  return parts.join('\n');
}

/** Google's canonical status (`INVALID_ARGUMENT`, `FAILED_PRECONDITION`, …), when it sent one. */
function googleStatus(detail: string): string | undefined {
  return /"status"\s*:\s*"([A-Z_]+)"/.exec(detail)?.[1];
}

/**
 * True when a quota Google says was exceeded is a daily one
 * (`QuotaFailure.violations[].quotaId`, e.g.
 * `GenerateRequestsPerDayPerProjectPerModel-FreeTier`). Such a refusal still
 * carries a `RetryInfo` of a few seconds, and passing that on would have the
 * reader retry, fail and retry again until midnight Pacific time.
 */
function isDailyQuota(detail: string): boolean {
  for (const match of detail.matchAll(/"quotaId"\s*:\s*"([^"]+)"/g)) {
    if (/PerDay/i.test(match[1] ?? '')) return true;
  }
  return false;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof ResponseTimeoutError ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError')
  );
}

function isEmpty(error: unknown): boolean {
  return error instanceof EmptyResponseError;
}

/** A provider out of quota or credit for now: waiting is the remedy. */
function isExhausted(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429 || status === 402 || status === 403) return true;
  return /429|RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests|credits?/i.test(detailText(error));
}

/** Seconds to wait, from a `Retry-After` header or Google's `RetryInfo`. */
function retryAfterOf(error: unknown): number | undefined {
  if (APICallError.isInstance(error)) {
    const header = error.responseHeaders?.['retry-after'];
    const seconds = header === undefined ? Number.NaN : Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  }
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(detailText(error))?.[1];
  return delay ? Math.max(1, Math.ceil(Number(delay))) : undefined;
}

/**
 * A Gemini API error against a reader's own key, mapped to what they can do.
 * Null when nothing about it is specific to the key.
 */
function classifyGoogle(error: unknown): ChatError | null {
  const status = statusOf(error);
  const detail = detailText(error);
  const canonical = googleStatus(detail);

  if (/API_KEY_INVALID|API key not valid|API_KEY_SERVICE_BLOCKED/i.test(detail)) return { code: 'byok_key_invalid' };
  if (status === 401 || status === 403 || canonical === 'PERMISSION_DENIED' || canonical === 'UNAUTHENTICATED') {
    return { code: 'byok_key_invalid' };
  }
  if (status === 429 || canonical === 'RESOURCE_EXHAUSTED') {
    if (isDailyQuota(detail)) return { code: 'byok_quota' };
    const retryAfter = retryAfterOf(error);
    return retryAfter ? { code: 'byok_quota', retryAfter } : { code: 'byok_quota' };
  }
  if (status === 404 || canonical === 'NOT_FOUND') return { code: 'byok_model_unavailable' };
  if (canonical === 'FAILED_PRECONDITION') return { code: 'byok_region_unavailable' };
  return null;
}

export type ClassifyContext = {
  /** The answer ran on the reader's own Gemini key. */
  byok: boolean;
  /** Text had already reached the reader when this happened. */
  streamed: boolean;
};

/** One failure, already unwrapped. */
function classifyOne(error: unknown, context: ClassifyContext): ChatError {
  if (isTimeout(error)) return { code: 'timeout' };
  if (isEmpty(error)) return { code: 'empty_answer' };
  if (context.byok) {
    const google = classifyGoogle(error);
    if (google) return google;
  }
  return { code: context.streamed ? 'interrupted' : 'generic' };
}

export function classifyChatError(error: unknown, context: ClassifyContext): ChatError {
  const root = unwrap(error);
  if (!(root instanceof AllProvidersFailedError)) return classifyOne(root, context);

  const failures = root.failures.map((failure) => unwrap(failure.error));
  if (failures.length === 0) return { code: 'generic' };

  // A reader's own key is one provider: its failure is the answer's.
  if (context.byok) return classifyOne(failures.at(-1), context);

  /*
   * The operator's chain. "The models are at their limit, wait" is only true
   * when a provider actually said so; a chain that failed for any other
   * reason (a malformed request every provider rejects alike) gets the plain
   * message rather than advice to wait that will not help.
   */
  if (failures.every(isEmpty)) return { code: 'empty_answer' };
  if (failures.every(isTimeout)) return { code: 'timeout' };
  if (failures.some(isExhausted)) return { code: 'providers_exhausted' };
  if (failures.every((failure) => isEmpty(failure) || isTimeout(failure))) return { code: 'timeout' };
  return { code: 'generic' };
}
