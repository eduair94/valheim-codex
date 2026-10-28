import { beforeEach, describe, expect, it } from 'vitest';
import { isTripped, recordFailure, recordSuccess, recordTimeout, resetCircuits } from '@/lib/rag/circuit';

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
