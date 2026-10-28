import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { CHAT_ERROR_CODES, chatErrorData, chatErrorText, classifyChatError } from '@/lib/chat-server/errors';
import { AllProvidersFailedError, EmptyResponseError, ResponseTimeoutError } from '@/lib/rag/fallback';

/**
 * The reader can act on most failures — wait out a quota, fix a key, pick a
 * model their key can use, rephrase — but only if the failure is named. The
 * SDK names every one of them "An error occurred.", in English.
 */

function googleError(statusCode: number, body: unknown, headers: Record<string, string> = {}): APICallError {
  return new APICallError({
    message: 'Google said no',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent',
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    responseBody: JSON.stringify(body),
    data: body,
  });
}

const BYOK = { byok: true, streamed: false };
const OPERATOR = { byok: false, streamed: false };

describe('a reader’s own Gemini key', () => {
  it('names a key Google rejects', () => {
    const invalid = googleError(400, {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
      },
    });
    expect(classifyChatError(invalid, BYOK)).toEqual({ code: 'byok_key_invalid' });
    expect(classifyChatError(googleError(403, { error: { status: 'PERMISSION_DENIED' } }), BYOK).code).toBe(
      'byok_key_invalid',
    );
  });

  it('names an exhausted quota, with the wait Google asked for', () => {
    const exhausted = googleError(429, {
      error: {
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }],
      },
    });
    expect(classifyChatError(exhausted, BYOK)).toEqual({ code: 'byok_quota', retryAfter: 37 });
    expect(classifyChatError(googleError(429, {}, { 'retry-after': '12' }), BYOK)).toEqual({
      code: 'byok_quota',
      retryAfter: 12,
    });
  });

  /*
   * Google sends a RetryInfo of seconds with a spent daily quota too. Passed
   * on, it had the reader retry, fail and retry until midnight Pacific.
   */
  it('passes no wait on for a daily quota, whatever RetryInfo says', () => {
    const daily = googleError(429, {
      error: {
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' },
        ],
      },
    });
    expect(classifyChatError(daily, BYOK)).toEqual({ code: 'byok_quota' });

    const perMinute = googleError(429, {
      error: {
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '15' }],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' },
        ],
      },
    });
    expect(classifyChatError(perMinute, BYOK)).toEqual({ code: 'byok_quota', retryAfter: 41 });
  });

  it('names a model the key cannot use, and a region or plan that cannot use Gemini', () => {
    expect(classifyChatError(googleError(404, { error: { status: 'NOT_FOUND' } }), BYOK).code).toBe(
      'byok_model_unavailable',
    );
    expect(classifyChatError(googleError(400, { error: { status: 'FAILED_PRECONDITION' } }), BYOK).code).toBe(
      'byok_region_unavailable',
    );
  });

  it('looks through the retry wrapper and the one-provider chain', () => {
    const exhausted = googleError(429, { error: { status: 'RESOURCE_EXHAUSTED' } });
    const retried = new RetryError({ message: 'gave up', reason: 'maxRetriesExceeded', errors: [exhausted, exhausted] });
    const chain = new AllProvidersFailedError([{ name: 'byok/gemini-3.5-flash-lite', error: retried }]);
    expect(classifyChatError(chain, BYOK).code).toBe('byok_quota');
  });
});

describe('the operator’s chain', () => {
  it('says the models are at their limit only when a provider said so', () => {
    const chain = new AllProvidersFailedError([
      { name: 'xai', error: { statusCode: 403 } },
      { name: 'google', error: new Error('429 RESOURCE_EXHAUSTED') },
    ]);
    expect(classifyChatError(chain, OPERATOR).code).toBe('providers_exhausted');

    // Every provider rejecting a malformed request is not a reason to wait.
    const malformed = new AllProvidersFailedError([
      { name: 'xai', error: googleError(400, { error: { status: 'INVALID_ARGUMENT' } }) },
    ]);
    expect(classifyChatError(malformed, OPERATOR).code).toBe('generic');
  });

  it('tells a refusal to answer apart from a quota', () => {
    const empty = new AllProvidersFailedError([
      { name: 'xai', error: new EmptyResponseError('content-filter') },
      { name: 'google', error: new EmptyResponseError('other') },
    ]);
    expect(classifyChatError(empty, OPERATOR).code).toBe('empty_answer');
  });

  it('names a chain that timed out everywhere', () => {
    const slow = new AllProvidersFailedError([
      { name: 'xai', error: new ResponseTimeoutError(15_000) },
      { name: 'google', error: new DOMException('timed out', 'TimeoutError') },
    ]);
    expect(classifyChatError(slow, OPERATOR).code).toBe('timeout');
  });

  it('calls a failure after text started an interruption', () => {
    expect(classifyChatError(new Error('socket hang up'), { byok: false, streamed: true }).code).toBe('interrupted');
    expect(classifyChatError(new Error('socket hang up'), OPERATOR).code).toBe('generic');
  });
});

describe('messages', () => {
  it('has a sentence for every code, in both languages', () => {
    for (const code of CHAT_ERROR_CODES) {
      expect(chatErrorText(code, 'es')).toMatch(/\S/);
      expect(chatErrorText(code, 'en')).toMatch(/\S/);
      expect(chatErrorText(code, 'es')).not.toBe(chatErrorText(code, 'en'));
    }
  });

  it('speaks the rioplatense of the rest of the interface', () => {
    expect(chatErrorText('interrupted', 'es')).toMatch(/Probá/);
    expect(chatErrorText('providers_exhausted', 'es')).toMatch(/Esperá/);
  });

  /*
   * A per-minute limit is the common case — each question spends two of a
   * free key's few requests a minute — and a reader told the daily quota
   * resets at midnight would give up on a 41-second wait.
   */
  it('tells a key out of quota how long to wait, or that it resets at midnight', () => {
    expect(chatErrorText('byok_quota', 'es', 41)).toBe(
      'Tu clave de Gemini llegó a su límite de consultas por ahora. Esperá 41 segundos y volvé a preguntar.',
    );
    expect(chatErrorText('byok_quota', 'en', 1)).toBe(
      'Your Gemini key hit its request limit for now. Wait 1 second and ask again.',
    );
    expect(chatErrorText('byok_quota', 'es', 300)).toMatch(/Esperá 5 minutos/);
    expect(chatErrorText('byok_quota', 'es')).toMatch(/medianoche del Pacífico/);
    expect(chatErrorText('byok_quota', 'en')).toMatch(/midnight Pacific/);
    // Other codes ignore a wait they have no sentence for.
    expect(chatErrorText('timeout', 'es', 30)).toBe(chatErrorText('timeout', 'es'));
  });

  it('carries the wait only when there is one', () => {
    expect(chatErrorData({ code: 'byok_quota', retryAfter: 30 })).toEqual({ code: 'byok_quota', retryAfter: 30 });
    expect(chatErrorData({ code: 'timeout' })).toEqual({ code: 'timeout' });
  });
});
