/**
 * Reading `POST /api/wiki/translate`'s answers, and deciding when to ask.
 *
 * Kept apart from the component so every answer the endpoint can give is
 * tested without a browser. The contract is the handler's header comment
 * (`src/app/api/wiki/translate/handler.ts`); the branch is on the status,
 * not on `ok`, because a 202 is "ok" and is not a translation.
 */

/** Why a translation could be asked for on this page view. */
export type TranslateMode =
  /** Nothing stored: the page is in English. Asked for on its own. */
  | 'missing'
  /** The English changed since the translation was made. Asked for on request. */
  | 'stale'
  /** Some strings are still English and a request could still add them. On request. */
  | 'partial';

export function translateMode(
  translation: { stale: boolean; partial: boolean; retryable: boolean } | null,
): TranslateMode | null {
  if (!translation) return 'missing';
  if (translation.stale) return 'stale';
  if (translation.partial && translation.retryable) return 'partial';
  return null;
}

export type TranslateOutcome =
  /** Stored, and better than what the page shows: the page has something new to render. */
  | { kind: 'refresh' }
  /** Nothing new for this reader right now. */
  | { kind: 'current' }
  /** Progress stored, or someone else is translating it: not shown yet. */
  | { kind: 'pending'; translated: number; total: number }
  /** An allowance is spent; `retryAfter` in seconds when the server said. */
  | { kind: 'limited'; retryAfter: number | null }
  /** Translation is switched off for this reader, or the request was refused. */
  | { kind: 'disabled' }
  /** It was tried and failed, or the request itself was wrong. Try later. */
  | { kind: 'failed' };

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

async function body(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * What an answer means for a page that shows `shown`.
 *
 * A 200 is a stored translation. `cached: false` says it was stored just now.
 * `cached: true` says this reader could add nothing to what was stored — but
 * what was stored can still be more than the page shows: the page is served
 * from a cache that can be up to an hour behind, and a translation written by
 * another process (the operator's script, another server) does not reach it.
 * The page then refreshes rather than tell a reader looking at English that
 * there is nothing to translate.
 */
export async function readTranslateResponse(response: Response, shown: TranslateMode): Promise<TranslateOutcome> {
  if (response.status === 200) {
    const data = await body(response);
    if (data.cached === false) return { kind: 'refresh' };
    const better =
      shown === 'missing' ? Boolean(data.doc) : shown === 'stale' ? data.stale !== true : data.partial !== true;
    return better ? { kind: 'refresh' } : { kind: 'current' };
  }
  if (response.status === 202) {
    const data = await body(response);
    return { kind: 'pending', translated: count(data.translated), total: count(data.total) };
  }
  if (response.status === 429) {
    const data = await body(response);
    const header = Number(response.headers.get('Retry-After'));
    const seconds = typeof data.retryAfter === 'number' ? data.retryAfter : header;
    return { kind: 'limited', retryAfter: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null };
  }
  if (response.status === 403) return { kind: 'disabled' };
  return { kind: 'failed' };
}

/** A wait in seconds as the reader would say it: "5 min", "2 h". Never "0 min". */
export function waitParts(seconds: number): { unit: 'minutes' | 'hours'; n: number } {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 90) return { unit: 'minutes', n: minutes };
  return { unit: 'hours', n: Math.ceil(minutes / 60) };
}

/**
 * How often an in-progress translation is asked about again: ten seconds
 * apart at the least, and twice at most while the page is in view. Past that
 * the reader is told to come back, rather than the page polling for ever.
 */
export const PENDING_RETRY_MS = 12_000;
export const PENDING_RETRIES = 2;
