import { describe, expect, it } from 'vitest';
import {
  ChatRequestError,
  describeFailure,
  errorFromResponse,
  failureOf,
  isAbortError,
  isNetworkError,
  retryAfterFrom,
  waitPhrase,
  type ChatFailure,
} from '@/lib/chat/errors';
import { strings } from '@/lib/i18n/strings';

const es = strings('es');
const en = strings('en');

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('errorFromResponse', () => {
  it('reads the code and the wait from a JSON error body', async () => {
    const error = await errorFromResponse(json(429, { error: 'rate_limited', bucket: 'chat:ip', retryAfter: 41 }));
    expect(error).toBeInstanceOf(ChatRequestError);
    expect(error).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 41 });
  });

  it('falls back to the Retry-After header, in seconds or as a date', async () => {
    const seconds = await errorFromResponse(json(503, { error: 'unavailable' }, { 'retry-after': '30' }));
    expect(seconds.retryAfter).toBe(30);
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(retryAfterFrom('Tue, 27 Oct 2026 12:01:30 GMT', now)).toBe(90);
    expect(retryAfterFrom('soon', now)).toBeUndefined();
    expect(retryAfterFrom('0', now)).toBeUndefined();
  });

  it('carries the limit a too-long question was refused with', async () => {
    const error = await errorFromResponse(json(413, { error: 'question_too_long', max: 2000 }));
    expect(error).toMatchObject({ code: 'question_too_long', max: 2000 });
  });

  it('never takes an HTML page or an empty body for a code', async () => {
    const html = await errorFromResponse(
      new Response('<!DOCTYPE html><html><title>500: Internal error</title></html>', {
        status: 500,
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect(html.code).toBe('http_500');
    expect(html.message).toBe('http_500');
    const empty = await errorFromResponse(new Response(null, { status: 418 }));
    expect(empty.code).toBe('http_418');
  });

  it('reads a refusal that is not ours by what its status means', async () => {
    // An edge rate-limit rule answers with its own page; the wait still counts.
    const edge = await errorFromResponse(
      new Response('<html><h1>Error 1015: You are being rate limited</h1></html>', {
        status: 429,
        headers: { 'content-type': 'text/html', 'retry-after': '60' },
      }),
    );
    expect(edge).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 60 });
    expect(describeFailure(failureOf(edge, null), es)).toMatchObject({ actions: ['retry'], wait: 60 });

    const gateway = await errorFromResponse(new Response('<html>502 Bad gateway</html>', { status: 502 }));
    expect(gateway).toMatchObject({ code: 'unavailable', status: 502 });
    expect((await errorFromResponse(new Response('', { status: 504 }))).code).toBe('unavailable');
    expect((await errorFromResponse(new Response(null, { status: 503, headers: { 'retry-after': '30' } })))).toMatchObject({
      code: 'unavailable',
      retryAfter: 30,
    });

    const signedOut = await errorFromResponse(new Response('Unauthorized', { status: 401 }));
    expect(signedOut.code).toBe('unauthorized');
    expect(describeFailure(failureOf(signedOut, null), es).actions).toEqual(['signin']);

    // Our own code still wins over the status.
    expect((await errorFromResponse(json(429, { error: 'byok_key_rate_limited' }))).code).toBe('byok_key_rate_limited');
  });

  it('ignores an `error` that is not one of our codes', async () => {
    const odd = await errorFromResponse(json(400, { error: 'Something <b>broke</b>' }));
    expect(odd.code).toBe('http_400');
    const nested = await errorFromResponse(json(400, { error: { message: 'x' } }));
    expect(nested.code).toBe('http_400');
  });
});

describe('failureOf', () => {
  it('keeps a refused request as it was refused', () => {
    const error = new ChatRequestError({ code: 'unauthorized', status: 401 });
    expect(failureOf(error, null)).toEqual({ code: 'unauthorized', status: 401, retryAfter: undefined, max: undefined });
  });

  it('reads a TypeError as the network, in every browser’s wording', () => {
    for (const message of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
      expect(failureOf(new TypeError(message), null).code).toBe('network');
    }
    expect(isNetworkError(new ChatRequestError({ code: 'network' }))).toBe(true);
  });

  it('takes a stream error’s code from its data-error part, never its text', () => {
    const failure = failureOf(new Error('Tu clave de Gemini llegó a su límite…'), { code: 'byok_quota', retryAfter: 12 });
    expect(failure).toEqual({ code: 'byok_quota', status: null, retryAfter: 12 });
  });

  it('calls a stream error without a code generic', () => {
    expect(failureOf(new Error('An error occurred.'), null).code).toBe('generic');
  });

  it('recognises an abort', () => {
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
  });
});

describe('waitPhrase', () => {
  it('says a wait the way a reader would', () => {
    expect(waitPhrase(1, es)).toBe('1 segundo');
    expect(waitPhrase(41, es)).toBe('41 segundos');
    expect(waitPhrase(41.2, en)).toBe('42 seconds');
    expect(waitPhrase(900, es)).toBe('15 minutos');
    expect(waitPhrase(5 * 3600, en)).toBe('5 hours');
  });
});

describe('describeFailure', () => {
  const view = (failure: Partial<ChatFailure> & { code: string }, t = es) =>
    describeFailure({ status: null, ...failure }, t);

  it('never offers a bare retry for an ended session', () => {
    const ended = view({ code: 'unauthorized', status: 401 });
    expect(ended.actions).toEqual(['signin']);
    expect(ended.text).toBe(es.chatErrorSessionEnded);
  });

  it('says the network, in the language on screen', () => {
    expect(view({ code: 'network' }).text).toBe(es.errorNetwork);
    expect(view({ code: 'network' }, en).text).toBe(en.errorNetwork);
  });

  it('shows the wait on a rate limit and holds the retry until then', () => {
    const limited = view({ code: 'rate_limited', status: 429, retryAfter: 41 });
    expect(limited.text).toContain('41 segundos');
    expect(limited).toMatchObject({ actions: ['retry'], wait: 41 });
    expect(view({ code: 'rate_limited', status: 429 }).text).toBe(es.chatErrorRateLimited);
  });

  it('does not invite a retry loop when every model is at its limit', () => {
    expect(view({ code: 'providers_exhausted' }).actions).toEqual(['dismiss']);
  });

  it('separates a key’s short limit from its spent day', () => {
    const short = view({ code: 'byok_quota', retryAfter: 30 });
    expect(short.text).toContain('30 segundos');
    expect(short.actions).toEqual(['retry', 'change-key']);
    const daily = view({ code: 'byok_quota' });
    expect(daily.text).toBe(es.chatErrorByokQuotaDaily);
    expect(daily.actions[0]).toBe('change-key');
  });

  it('offers what fixes each key problem', () => {
    expect(view({ code: 'byok_key_invalid' }).actions).toEqual(['change-key']);
    expect(view({ code: 'byok_model_unavailable' }).actions).toEqual(['change-model', 'retry']);
    expect(view({ code: 'byok_region_unavailable' }).actions).toEqual(['change-method']);
  });

  it('offers a Puter reconnect, a gesture, when Puter’s session is gone', () => {
    for (const code of ['puter_signed_out', 'puter_popup_blocked', 'puter_auth_closed']) {
      expect(view({ code }).actions).toEqual(['reconnect-puter']);
    }
    expect(view({ code: 'puter_subscription_required' }).actions).toEqual(['change-model', 'retry']);
    expect(view({ code: 'puter_insufficient_funds' }).actions[0]).toBe('change-method');
  });

  it('sends a reader whose conversation is gone to a new one', () => {
    expect(view({ code: 'conversation_not_found', status: 404 }).actions).toEqual(['new-chat']);
  });

  it('asks for a reload when this tab is out of step', () => {
    expect(view({ code: 'use_puter_transport', status: 409 }).actions).toEqual(['reload']);
    expect(view({ code: 'forbidden_origin', status: 403 }).actions).toEqual(['reload']);
  });

  it('names the limit of a question that is too long', () => {
    expect(view({ code: 'question_too_long', status: 413, max: 2000 }).text).toContain('2000');
    expect(view({ code: 'payload_too_large', status: 413 }).text).toBe(es.chatErrorTooLong);
  });

  it('falls back to the plain sentence, with a retry, for anything unknown', () => {
    for (const code of ['http_500', 'internal_error', 'generic', 'something_new']) {
      expect(view({ code })).toEqual({ text: es.errorGeneric, actions: ['retry'] });
    }
  });
});
