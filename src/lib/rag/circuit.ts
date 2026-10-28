import { logWarn } from '@/lib/log';

/**
 * Remembers providers that are refusing for a reason waiting will not fix,
 * and reads what a refusal says about when it will be fixed.
 *
 * The chain tries providers in order, so a dead one at the front taxes every
 * single question with a failed round trip before the working provider is even
 * asked. And "dead" is the normal state for an unfunded key: an xAI team with
 * no credit answers 403 to every request, for weeks, until someone pays.
 *
 * The distinction that matters is how long a refusal lasts:
 *
 * - **Permanent.** A 401/402/403 is a fact about the account, not the moment,
 *   so the provider is skipped for a while and the chain moves straight to one
 *   that can answer.
 * - **For the day.** A quota counted per day is spent until it resets, hours
 *   away. Gemini's free tier, twenty requests a day on this project's key,
 *   refused every batch of a production translation run after the first few,
 *   and the chain asked it again before each one. It is skipped until the
 *   reset: midnight Pacific time for Google, the wait the refusal states for
 *   a rolling window like Groq's, midnight UTC when it states none.
 * - **For the minute.** A rate limit counted per minute is temporary, and the
 *   provider deserves to be asked again in a moment — skipping it would give
 *   up the quota it is about to get back. Nothing is held against it here; the
 *   fallback chain waits out the wait it states (fallback.ts).
 *
 * A timeout sits in between. A provider that hung once is likely hanging for
 * everyone right now, and without a memory every question would pay the full
 * first-token deadline on it before reaching one that answers. So a timeout
 * demotes it too, but only for a minute: long enough to ride out an incident,
 * short enough that a single slow answer costs it almost nothing.
 *
 * Only the answer's own first-word deadline counts as that evidence, which is
 * why timeouts have their own entry point instead of going through
 * `recordFailure`. Rewrite, answer and translation share candidate names (by
 * default the rewrite and the answer even use the same model), so a
 * translation batch that outlived its own 60-second budget, or a rewrite that
 * missed its 6-second one, used to demote the operator's first provider for
 * chat answers too, and for that minute every reader was answered by the next,
 * free tier. A permanent refusal, by contrast, is a fact about the account and
 * true for every feature alike.
 *
 * Deliberately in-memory, and a demotion rather than a ban: a skipped provider
 * is still asked when every other one has failed (`orderByCircuit`). This is a
 * latency optimisation, not a source of truth: the worst case if it is wrong is
 * one wasted round trip, and a cooldown that outlived a top-up would be a far
 * more annoying bug than the one it fixes.
 */

const COOLDOWN_MS = 10 * 60 * 1000;
const TIMEOUT_COOLDOWN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const openUntil = new Map<string, number>();

/** What a refusal says about the provider: out for good, for the day, or for the minute. */
export type Refusal = 'permanent' | 'daily' | 'rate-limit';

type Link = {
  statusCode?: unknown;
  status?: unknown;
  message?: unknown;
  responseBody?: unknown;
  responseHeaders?: unknown;
  lastError?: unknown;
  cause?: unknown;
};

/**
 * The error and the errors inside it. The SDK reports the last provider of a
 * chain, once its own retries are spent, as a RetryError around the
 * provider's error, whose status and wording are the ones that matter.
 */
function links(error: unknown): Link[] {
  const found: Link[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth++) {
    const link = current as Link;
    found.push(link);
    current = link.lastError ?? link.cause;
  }
  return found;
}

/** HTTP status of a provider error, looking through the SDK's retry wrapper. */
export function statusOf(error: unknown): number | undefined {
  for (const link of links(error)) {
    if (typeof link.statusCode === 'number') return link.statusCode;
    if (typeof link.status === 'number') return link.status;
  }
  return undefined;
}

/**
 * What the provider said, with links left out: a URL to the docs on rate
 * limits is not a rate limit (Groq links them from its 413 "request too
 * large"). `bodies` adds the response bodies, where Google names the quota
 * that ran out and how long to wait.
 */
function wordsOf(error: unknown, bodies = false): string {
  if (typeof error === 'string') return error;
  return links(error)
    .flatMap((link) => (bodies ? [link.message, link.responseBody] : [link.message]))
    .filter((text): text is string => typeof text === 'string')
    .map((text) => text.slice(0, 8_000).replace(/https?:\/\/\S+/g, ''))
    .join('\n');
}

/**
 * Auth, payment and permission — the failures that a retry cannot fix. Read
 * from the words as well as the status: xAI reports a team that spent its
 * credit, or reached its monthly spending limit, with a 429, which read as
 * a per-minute limit kept it first in line for every request.
 */
function isPermanent(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 401 || status === 402 || status === 403) return true;
  return /permission-denied|insufficient[_ ]?credits|invalid[_ ]api[_ ]key|unauthorized|requires? (more )?credits|upgrade to a paid|used all available credits|spending limit/i.test(
    wordsOf(error),
  );
}

/**
 * A 429, or, from an error that carries no status, the wording of one. A
 * status that is not 429 is taken at its word: a 413 or a 500 is not a quota,
 * whatever its text mentions.
 */
function isRateLimited(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return status === 429;
  return /rate.?limit|too many requests|quota|resource.?exhausted/i.test(wordsOf(error));
}

const PER_DAY = /per[\s_-]?day|\b(?:rpd|tpd)\b|daily/i;
const PER_MINUTE = /per[\s_-]?minute|\b(?:rpm|tpm)\b/i;

/**
 * A limit counted per day: "requests per day", Groq's "(TPD)", OpenRouter's
 * "free-models-per-day", Google's `…PerDayPerProjectPerModel` quota. Google
 * names the metric, `generate_content_free_tier_requests`, the same for its
 * per-minute limit and its daily one, and says which in a description after
 * it; a message cut before the description is read as the daily one, which
 * on twenty requests a day is the one this key meets.
 */
function isDaily(error: unknown): boolean {
  const words = wordsOf(error, true);
  if (PER_DAY.test(words)) return true;
  return /free_tier_requests/i.test(words) && !PER_MINUTE.test(words);
}

/** What a failed request says about its provider, or null when it is not a refusal at all. */
export function refusalOf(error: unknown): Refusal | null {
  if (isPermanent(error)) return 'permanent';
  if (!isRateLimited(error)) return null;
  return isDaily(error) ? 'daily' : 'rate-limit';
}

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: HOUR_MS } as const;

/** `510ms`, `12.7875s`, `7m12.5s`: the durations Groq and Google write. */
function durationMs(text: string): number | undefined {
  let total: number | undefined;
  for (const [, value, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total = (total ?? 0) + Number(value) * UNIT_MS[unit as keyof typeof UNIT_MS];
  }
  return total;
}

function header(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value.trim();
  }
  return undefined;
}

/**
 * The waits a response's headers state: `retry-after-ms`; `retry-after`, in
 * seconds or as a date; and `x-ratelimit-reset`, which OpenRouter sends as the
 * instant in milliseconds since the epoch and others as seconds from now.
 */
function headerWaits(headers: unknown, now: number): number[] {
  const waits: number[] = [];
  const ms = header(headers, 'retry-after-ms');
  if (ms !== undefined && Number.isFinite(Number(ms))) waits.push(Number(ms));

  const after = header(headers, 'retry-after');
  if (after !== undefined) {
    if (Number.isFinite(Number(after))) waits.push(Number(after) * 1_000);
    else if (Number.isFinite(Date.parse(after))) waits.push(Date.parse(after) - now);
  }

  const reset = header(headers, 'x-ratelimit-reset');
  if (reset !== undefined) {
    const value = Number(reset);
    if (Number.isFinite(value)) waits.push(value >= 1e12 ? value - now : value >= 1e9 ? value * 1_000 - now : value * 1_000);
    else {
      const duration = durationMs(reset);
      if (duration !== undefined) waits.push(duration);
    }
  }
  return waits;
}

/**
 * How long a refusal says to wait before asking again, in milliseconds, or
 * undefined when it does not say. Read from the headers, from the message
 * ("Please try again in 510ms", Groq; "Please retry in 42.38s", Google) and
 * from Google's RetryInfo in the response body.
 *
 * When a refusal states its wait in more than one place, the longest is
 * taken: asked any sooner, the provider would only refuse again.
 */
export function statedWaitMs(error: unknown, now: number = Date.now()): number | undefined {
  const waits: number[] = [];
  for (const link of links(error)) waits.push(...headerWaits(link.responseHeaders, now));

  const words = wordsOf(error, true);
  for (const [, wait] of words.matchAll(/(?:try again|retry) in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/gi)) {
    const ms = durationMs(wait!);
    if (ms !== undefined) waits.push(ms);
  }
  for (const [, seconds] of words.matchAll(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/g)) waits.push(Number(seconds) * 1_000);

  const stated = waits.filter((wait) => Number.isFinite(wait));
  return stated.length > 0 ? Math.max(0, Math.ceil(Math.max(...stated))) : undefined;
}

/** Built on first use, inside `nextPacificMidnight`'s guard: a runtime without the time zone throws here. */
let pacific: Intl.DateTimeFormat | undefined;

function pacificClock(at: number): { year: number; month: number; day: number; hour: number } {
  pacific ??= new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(pacific.formatToParts(at).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) };
}

/** The next time the UTC clock reads `hour`:00. */
function nextUtcHour(now: number, hour: number): number {
  const date = new Date(now);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour);
  return today > now ? today : today + DAY_MS;
}

/**
 * The next midnight in Los Angeles, when Google resets daily quotas: 07:00
 * UTC while daylight saving time is in force, 08:00 the rest of the year.
 * Found by taking the next Pacific day's midnight at standard time, 08:00 UTC,
 * and stepping an hour back when the clock there reads one in the morning.
 */
function nextPacificMidnight(now: number): number {
  try {
    const today = pacificClock(now);
    const standard = Date.UTC(today.year, today.month - 1, today.day + 1, 8);
    return pacificClock(standard).hour === 0 ? standard : standard - HOUR_MS;
  } catch {
    // A runtime without time zone data: the later of the two is never too soon.
    return nextUtcHour(now, 8);
  }
}

/** When a provider's spent daily quota is back. */
function dailyResetAt(name: string, error: unknown, now: number): number {
  // Google's RetryInfo, seconds away, is its per-minute window's: the day's quota is back at midnight Pacific.
  if (name.startsWith('google/')) return nextPacificMidnight(now);
  const wait = statedWaitMs(error, now);
  return wait !== undefined && wait > 0 ? now + Math.min(wait, DAY_MS) : nextUtcHour(now, 0);
}

/** Skips a provider until `until`, never shortening a longer cooldown already in force. */
function trip(name: string, until: number): void {
  openUntil.set(name, Math.max(openUntil.get(name) ?? 0, until));
}

/** True while this provider is being skipped. */
export function isTripped(name: string, now: number = Date.now()): boolean {
  const until = openUntil.get(name);
  if (until === undefined) return false;
  if (until > now) return true;
  openUntil.delete(name);
  return false;
}

/**
 * Records a failure, opening the circuit only for the kinds waiting will not
 * fix soon: a permanent refusal for ten minutes, a spent daily quota until it
 * resets. A per-minute rate limit is not one of them, and neither is a
 * timeout, whatever its name: see `recordTimeout`.
 */
export function recordFailure(name: string, error: unknown, now: number = Date.now()): void {
  const refusal = refusalOf(error);
  if (refusal === 'permanent') {
    trip(name, now + COOLDOWN_MS);
    logWarn(
      'model',
      `${name} is refusing for a reason retrying will not fix; skipping it for ${COOLDOWN_MS / 60_000} minutes.`,
    );
  } else if (refusal === 'daily') {
    const until = dailyResetAt(name, error, now);
    trip(name, until);
    const at = new Date(until).toISOString().slice(0, 16).replace('T', ' ');
    logWarn('model', `${name} has spent its daily quota; asking the others first until ${at} UTC.`);
  }
}

/**
 * Demotes a provider that missed the answer's first-word deadline, for a
 * minute. Called by the fallback chain only when asked to (`demoteOnTimeout`),
 * which only the chat answer does.
 */
export function recordTimeout(name: string, now: number = Date.now()): void {
  trip(name, now + TIMEOUT_COOLDOWN_MS);
  logWarn('model', `${name} timed out; asking the others first for ${TIMEOUT_COOLDOWN_MS / 1000} seconds.`);
}

/** A provider that answers clears whatever was held against it. */
export function recordSuccess(name: string): void {
  openUntil.delete(name);
}

/** Test-only. */
export function resetCircuits(): void {
  openUntil.clear();
}
