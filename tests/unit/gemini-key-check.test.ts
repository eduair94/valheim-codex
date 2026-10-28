import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkGeminiKey, classifyGoogleFailure, GEMINI_KEY_ERROR_STATUS } from '@/lib/auth/gemini-key-check';

const KEY = 'AIzaSyTESTTESTTESTTESTTESTTESTTEST1234';
const MODEL = 'gemini-3.5-flash-lite';

/** Google's error body: `{ error: { code, message, status, details: [{ reason }] } }`. */
function googleError(code: number, status: string, reason?: string, message = 'refused') {
  return Response.json(
    {
      error: {
        code,
        message,
        status,
        ...(reason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } : {}),
      },
    },
    { status: code },
  );
}

/**
 * A fake Google: answers the metadata call, then the generation call. Each
 * answer is serialised once and rebuilt per call, so every call gets a
 * response of its own.
 */
function fakeGoogle(metadata: Response, generate: Response = Response.json({ candidates: [] })) {
  const frozen = [metadata, generate].map(async (r) => ({ status: r.status, text: await r.text() }));
  return vi.fn(async (url: string) => {
    const { status, text } = await frozen[url.endsWith(':generateContent') ? 1 : 0]!;
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkGeminiKey', () => {
  it('accepts a key that can read the model and run it', async () => {
    const fetchImpl = fakeGoogle(Response.json({ name: `models/${MODEL}` }));
    expect(await checkGeminiKey(KEY, MODEL, { fetchImpl })).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends the key in a header only, never in the URL', async () => {
    const fetchImpl = fakeGoogle(Response.json({}));
    await checkGeminiKey(KEY, MODEL, { fetchImpl });
    for (const [url, init] of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).not.toContain(KEY);
      expect(url).not.toContain('key=');
      expect(new Headers(init.headers).get('x-goog-api-key')).toBe(KEY);
    }
    const [, generate] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(generate.body))).toMatchObject({ generationConfig: { maxOutputTokens: 1 } });
  });

  it('rejects a key Google does not know without trying to generate', async () => {
    const fetchImpl = fakeGoogle(googleError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID', 'API key not valid.'));
    expect(await checkGeminiKey(KEY, MODEL, { fetchImpl })).toEqual({ ok: false, error: 'byok_key_invalid' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('rejects a key refused with %i', async (status) => {
    const fetchImpl = fakeGoogle(googleError(status, 'PERMISSION_DENIED'));
    expect(await checkGeminiKey(KEY, MODEL, { fetchImpl })).toEqual({ ok: false, error: 'byok_key_invalid' });
  });

  it('reports a model the key has no access to', async () => {
    const onMetadata = fakeGoogle(googleError(404, 'NOT_FOUND'));
    expect(await checkGeminiKey(KEY, MODEL, { fetchImpl: onMetadata })).toEqual({
      ok: false,
      error: 'byok_model_unavailable',
    });
    const onGenerate = fakeGoogle(Response.json({}), googleError(404, 'NOT_FOUND'));
    expect(await checkGeminiKey(KEY, MODEL, { fetchImpl: onGenerate })).toEqual({
      ok: false,
      error: 'byok_model_unavailable',
    });
  });

  it('reports a key that is over its quota', async () => {
    const fetchImpl = fakeGoogle(Response.json({}), googleError(429, 'RESOURCE_EXHAUSTED'));
    expect(await checkGeminiKey(KEY, MODEL, { fetchImpl })).toEqual({ ok: false, error: 'byok_key_rate_limited' });
  });

  it('reports a project in a region Gemini does not serve', async () => {
    const fetchImpl = fakeGoogle(
      Response.json({}),
      googleError(400, 'FAILED_PRECONDITION', undefined, 'User location is not supported for the API use.'),
    );
    expect(await checkGeminiKey(KEY, MODEL, { fetchImpl })).toEqual({ ok: false, error: 'byok_region_unavailable' });
  });

  it('treats a generation refused with 403 as a key problem', async () => {
    const fetchImpl = fakeGoogle(Response.json({}), googleError(403, 'PERMISSION_DENIED', 'SERVICE_DISABLED'));
    expect(await checkGeminiKey(KEY, MODEL, { fetchImpl })).toEqual({ ok: false, error: 'byok_key_invalid' });
  });

  it('reports Google being unreachable, or failing on its side', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await checkGeminiKey(KEY, MODEL, { fetchImpl: down })).toEqual({ ok: false, error: 'byok_unreachable' });
    const broken = fakeGoogle(Response.json({}), new Response('upstream', { status: 503 }));
    expect(await checkGeminiKey(KEY, MODEL, { fetchImpl: broken })).toEqual({ ok: false, error: 'byok_unreachable' });
  });

  it('gives up after its timeout instead of holding the request', async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    expect(await checkGeminiKey(KEY, MODEL, { fetchImpl: hang, timeoutMs: 50 })).toEqual({
      ok: false,
      error: 'byok_unreachable',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('never writes the key to the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = fakeGoogle(new Response(`bad gateway for ${KEY}`, { status: 502 }));
    await checkGeminiKey(KEY, MODEL, { fetchImpl: broken });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });
});

describe('classifyGoogleFailure', () => {
  it('reads a 400 by the step it happened on', () => {
    // The metadata call has no body to get wrong: a 400 there is the key.
    expect(classifyGoogleFailure('metadata', 400, null)).toBe('byok_key_invalid');
    expect(classifyGoogleFailure('generate', 400, null)).toBe('byok_model_unavailable');
    expect(
      classifyGoogleFailure('generate', 400, { error: { details: [{ reason: 'API_KEY_INVALID' }] } }),
    ).toBe('byok_key_invalid');
  });

  it('reports each failure with a status the client can act on', () => {
    expect(GEMINI_KEY_ERROR_STATUS).toEqual({
      byok_key_invalid: 400,
      byok_model_unavailable: 400,
      byok_key_rate_limited: 429,
      byok_region_unavailable: 400,
      byok_unreachable: 502,
    });
  });
});
