import { APICallError, RetryError } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isTripped,
  recordFailure,
  recordSuccess,
  recordTimeout,
  refusalOf,
  resetCircuits,
  statedWaitMs,
} from '@/lib/rag/circuit';

/**
 * The point of the breaker is that an unfunded key is not a transient fault.
 * An xAI team with no credit answers 403 to every request for as long as it
 * takes someone to pay, and with that key first in the chain every question
 * pays a failed round trip. Getting the permanent/temporary distinction wrong
 * in the other direction is worse: skipping a merely rate-limited provider
 * gives up quota it is about to get back.
 */

const NAME = 'xai/grok';

beforeEach(() => resetCircuits());

describe('permanent failures', () => {
  it.each([
    ['403 status', { statusCode: 403 }],
    ['402 status', { statusCode: 402 }],
    ['401 status', { statusCode: 401 }],
    ['xAI wording', new Error("permission-denied: Your newly created team doesn't have any credits")],
    ['OpenRouter wording', new Error('Requires more credits and upgrade to a paid account')],
    ['a bad key', new Error('invalid_api_key: incorrect API key provided')],
    // A 429 by status, about the account and not the minute.
    [
      'xAI’s spent credit, which comes as a 429',
      Object.assign(
        new Error(
          'Your team c78cf634 has either used all available credits or reached its monthly spending limit. ' +
            'To continue making API requests, please purchase more credits or raise your spending limit.',
        ),
        { statusCode: 429 },
      ),
    ],
  ])('trips the circuit on %s', (_label, error) => {
    recordFailure(NAME, error);
    expect(isTripped(NAME)).toBe(true);
  });
});

describe('temporary failures', () => {
  it.each([
    ['429 status', { statusCode: 429 }],
    ['500 status', { statusCode: 500 }],
    ['quota wording', new Error('You exceeded your current quota, please check your plan')],
    ['a timeout', new Error('fetch failed: ETIMEDOUT')],
  ])('leaves the circuit closed on %s', (_label, error) => {
    recordFailure(NAME, error);
    // Waiting fixes these, and the provider is likely the best one available.
    expect(isTripped(NAME)).toBe(false);
  });
});

describe('recovery', () => {
  it('reopens after the cooldown rather than staying tripped', () => {
    const now = 1_000_000;
    recordFailure(NAME, { statusCode: 403 }, now);

    expect(isTripped(NAME, now + 9 * 60_000)).toBe(true);
    expect(isTripped(NAME, now + 11 * 60_000)).toBe(false);
  });

  it('clears immediately when the provider answers', () => {
    recordFailure(NAME, { statusCode: 403 });
    expect(isTripped(NAME)).toBe(true);

    recordSuccess(NAME);
    expect(isTripped(NAME)).toBe(false);
  });

  it('keeps providers independent', () => {
    recordFailure('xai/grok', { statusCode: 403 });
    expect(isTripped('groq/gpt-oss')).toBe(false);
  });
});

describe('timeouts', () => {
  /*
   * A provider that hung once is probably hanging for everyone at that
   * moment; without a memory every question would wait out the whole
   * first-token deadline on it before reaching one that answers.
   */
  it('demotes a provider that missed the answer’s deadline, but only for about a minute', () => {
    const now = 1_000_000;
    recordTimeout(NAME, now);

    expect(isTripped(NAME, now + 30_000)).toBe(true);
    expect(isTripped(NAME, now + 61_000)).toBe(false);
  });

  /*
   * Rewrite, answer and translation share candidate names. A translation
   * batch outliving its own 60-second timer, or a rewrite missing its
   * 6-second deadline, used to demote the operator's first provider for chat
   * answers as well.
   */
  it.each([
    ['the TimeoutError a caller’s own AbortSignal.timeout throws', new DOMException('The operation timed out.', 'TimeoutError')],
    ['a ResponseTimeoutError reported as an ordinary failure', Object.assign(new Error('late'), { name: 'ResponseTimeoutError' })],
  ])('does not demote on %s', (_label, error) => {
    recordFailure(NAME, error, 2_000_000);
    expect(isTripped(NAME, 2_000_000 + 1_000)).toBe(false);
  });

  it('never shortens a permanent cooldown already in force', () => {
    const now = 3_000_000;
    recordFailure(NAME, { statusCode: 403 }, now);
    recordTimeout(NAME, now + 1_000);
    expect(isTripped(NAME, now + 5 * 60_000)).toBe(true);
  });
});

/** A provider's refusal the way the SDK reports it. */
function refused(
  status: number,
  message: string,
  extra: { headers?: Record<string, string>; body?: string } = {},
): APICallError {
  return new APICallError({
    message,
    url: 'https://provider.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: extra.headers,
    responseBody: extra.body,
    isRetryable: false,
  });
}

/*
 * Worded as the providers worded them in the production translation run of
 * 2026-10-28, which stopped on the first of these: Groq's per-minute limit,
 * with every other provider out of credit or out of its day.
 */
const groqPerMinute = (wait: string) =>
  refused(
    429,
    'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_test` service tier `on_demand` on ' +
      `tokens per minute (TPM): Limit 8000, Used 6176, Requested 1892. Please try again in ${wait}. ` +
      'Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
  );
const GROQ_PER_DAY = refused(
  429,
  'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_test` service tier `on_demand` on ' +
    'tokens per day (TPD): Limit 200000, Used 199644, Requested 1892. Please try again in 12m37.248s. ' +
    'Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
);
const gemini = (per: 'day' | 'minute', limit: number) =>
  refused(
    429,
    'You exceeded your current quota, please check your plan and billing details. For more information on this ' +
      'error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: ' +
      'https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/' +
      `generate_content_free_tier_requests, limit: ${limit}, model: gemini-2.5-flash-lite, description: Generate ` +
      `content requests per ${per} limit exceeded on Free Tier. See https://ai.google.dev/gemini-api/docs/rate-limits\n` +
      'Please retry in 42.380233168s.',
  );
const OPENROUTER_CREDIT = refused(
  402,
  'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford ' +
    '15993. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account',
);
const BAD_JSON = refused(400, "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.");

describe('what a refusal says about the provider', () => {
  it.each([
    ['Groq’s tokens-per-minute limit', groqPerMinute('510ms'), 'rate-limit'],
    ['Gemini’s per-minute limit', gemini('minute', 10), 'rate-limit'],
    ['a bare 429', { statusCode: 429 }, 'rate-limit'],
    ['Groq’s tokens-per-day limit', GROQ_PER_DAY, 'daily'],
    ['Gemini’s free tier, spent for the day', gemini('day', 20), 'daily'],
    [
      'OpenRouter’s free models, spent for the day',
      refused(429, 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day'),
      'daily',
    ],
    [
      'a daily quota named only in the response body',
      refused(429, 'You exceeded your current quota', {
        body: JSON.stringify({
          error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] },
        }),
      }),
      'daily',
    ],
    ['an account out of credit (OpenRouter)', OPENROUTER_CREDIT, 'permanent'],
    ['an unpaid team (xAI)', refused(403, "permission-denied: Your newly created team doesn't have any credits."), 'permanent'],
    ['a server error', refused(503, 'The model is overloaded.'), null],
    ['a reply that failed the schema', BAD_JSON, null],
  ])('reads %s as %s', (_label, error, expected) => {
    expect(refusalOf(error)).toBe(expected);
  });

  it('looks through the SDK’s retry wrapper to the refusal inside', () => {
    const wrapped = new RetryError({ message: 'Failed after 3 attempts.', reason: 'maxRetriesExceeded', errors: [GROQ_PER_DAY] });
    expect(refusalOf(wrapped)).toBe('daily');
  });
});

describe('daily quotas', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const GEMINI = 'google/gemini-2.5-flash-lite';
  const GROQ = 'groq/openai/gpt-oss-120b';

  it('skip Gemini until its quota resets at midnight Pacific: 07:00 UTC in October, 08:00 in December', () => {
    recordFailure(GEMINI, gemini('day', 20), Date.parse('2026-10-28T10:00:00Z'));
    // Not ten minutes, and not the 42 seconds its message suggests: that is the per-minute window's.
    expect(isTripped(GEMINI, Date.parse('2026-10-29T06:59:00Z'))).toBe(true);
    expect(isTripped(GEMINI, Date.parse('2026-10-29T07:00:00Z'))).toBe(false);

    recordFailure(GEMINI, gemini('day', 20), Date.parse('2026-12-01T10:00:00Z'));
    expect(isTripped(GEMINI, Date.parse('2026-12-02T07:59:00Z'))).toBe(true);
    expect(isTripped(GEMINI, Date.parse('2026-12-02T08:00:00Z'))).toBe(false);
  });

  it('bring Gemini back at the coming midnight, not a day later, when the quota ran out just before it', () => {
    // 23:50 in Los Angeles.
    recordFailure(GEMINI, gemini('day', 20), Date.parse('2026-10-29T06:50:00Z'));
    expect(isTripped(GEMINI, Date.parse('2026-10-29T06:59:00Z'))).toBe(true);
    expect(isTripped(GEMINI, Date.parse('2026-10-29T07:00:00Z'))).toBe(false);
  });

  it('skip Groq for the wait its rolling daily window states', () => {
    const now = 5_000_000;
    recordFailure(GROQ, GROQ_PER_DAY, now);
    expect(isTripped(GROQ, now + 12 * 60_000)).toBe(true);
    expect(isTripped(GROQ, now + 13 * 60_000)).toBe(false);
  });

  it('skip a provider that names no reset until midnight UTC', () => {
    const daily = refused(429, 'Daily request limit reached.');
    recordFailure('cerebras/gpt-oss-120b', daily, Date.parse('2026-10-28T10:00:00Z'));
    expect(isTripped('cerebras/gpt-oss-120b', Date.parse('2026-10-28T23:59:00Z'))).toBe(true);
    expect(isTripped('cerebras/gpt-oss-120b', Date.parse('2026-10-29T00:00:00Z'))).toBe(false);
  });

  it.each([
    ['Groq’s per-minute limit', groqPerMinute('12.7875s')],
    ['Gemini’s per-minute limit', gemini('minute', 10)],
  ])('leave out %s, which never skips the provider: its quota is back within the minute', (_label, error) => {
    recordFailure(GROQ, error, 6_000_000);
    expect(isTripped(GROQ, 6_000_001)).toBe(false);
  });

  it('end as soon as the provider answers again', () => {
    recordFailure(GEMINI, gemini('day', 20));
    recordSuccess(GEMINI);
    expect(isTripped(GEMINI)).toBe(false);
  });
});

describe('how long a refusal says to wait', () => {
  it.each([
    ['510ms', 510],
    ['12.7875s', 12_788],
    ['1.430999999s', 1_431],
    ['7m12.5s', 432_500],
    ['1h2m3s', 3_723_000],
  ])('reads Groq’s "try again in %s" as %i ms', (wait, ms) => {
    expect(statedWaitMs(groqPerMinute(wait))).toBe(ms);
  });

  it('reads Gemini’s "Please retry in", and its RetryInfo in the response body', () => {
    expect(statedWaitMs(gemini('minute', 10))).toBe(42_381);
    const body = JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' }] } });
    expect(statedWaitMs(refused(429, 'Quota exceeded', { body }))).toBe(41_000);
  });

  it('reads Retry-After in seconds or as a date, retry-after-ms, and x-ratelimit-reset as an instant or seconds', () => {
    const now = Date.parse('2026-10-28T10:00:00Z');
    const withHeaders = (headers: Record<string, string>) => refused(429, 'Too Many Requests', { headers });
    expect(statedWaitMs(withHeaders({ 'retry-after': '7' }), now)).toBe(7_000);
    expect(statedWaitMs(withHeaders({ 'retry-after': new Date(now + 30_000).toUTCString() }), now)).toBe(30_000);
    expect(statedWaitMs(withHeaders({ 'retry-after-ms': '250' }), now)).toBe(250);
    // OpenRouter's: the instant, in milliseconds since the epoch.
    expect(statedWaitMs(withHeaders({ 'x-ratelimit-reset': String(now + 45_000) }), now)).toBe(45_000);
    expect(statedWaitMs(withHeaders({ 'X-RateLimit-Reset': '20' }), now)).toBe(20_000);
  });

  it('takes the longest wait when a refusal states one in several places: asking sooner is refused again', () => {
    const error = refused(429, groqPerMinute('510ms').message, { headers: { 'retry-after': '1' } });
    expect(statedWaitMs(error)).toBe(1_000);
  });

  it('looks through the SDK’s retry wrapper', () => {
    const wrapped = new RetryError({ message: 'Failed after 3 attempts.', reason: 'maxRetriesExceeded', errors: [groqPerMinute('2s')] });
    expect(statedWaitMs(wrapped)).toBe(2_000);
  });

  it('says nothing when the refusal says nothing', () => {
    expect(statedWaitMs(refused(429, 'Too Many Requests'))).toBeUndefined();
    expect(statedWaitMs({ statusCode: 429 })).toBeUndefined();
  });
});
