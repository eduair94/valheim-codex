import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, redact } from '@/lib/log';
import { configuredPuterAppUids, resetPuterAppUidCache, verifyPuterToken } from '@/lib/auth/puter-verify';

describe('redact', () => {
  it('removes Google keys, key parameters, bearer tokens and JWTs', () => {
    const text = [
      'key AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'https://generativelanguage.googleapis.com/v1beta/models/x?key=SECRET123&alt=sse',
      'Authorization: Bearer abcdefghijklmnop',
      'x-goog-api-key: AQ.service-account-key',
      'cookie eyJhbGciOiJIUzI1NiJ9.eyJwcm9maWxlIjoiYSJ9.c2lnbmF0dXJlc2ln',
    ].join('\n');
    const out = redact(text);
    expect(out).not.toContain('AIzaSyA1234567890');
    expect(out).not.toContain('SECRET123');
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).not.toContain('service-account-key');
    expect(out).not.toContain('eyJwcm9maWxlIjoiYSJ9');
    expect(out).toContain('alt=sse');
  });

  it('redacts a token glued to a name, or deep in a long path, keeping what came before it', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJwcm9maWxlIjoiYSJ9.c2lnbmF0dXJlc2ln';
    for (const prefix of ['', 'session_', 'a-', 'x', 'tok-', '/wiki/a/']) {
      expect(redact(`${prefix}${jwt} after`), prefix).toBe(`${prefix}[token redacted] after`);
    }
    expect(redact(`/x/eyJhbGciOiJIUzI1NiJ9.eyJ${'A'.repeat(3000)}.sig`)).toBe('/x/[token redacted]');
  });

  it('redacts exactly what the plain token pattern did', () => {
    const plain = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){2,4}/g;
    // Deterministic: a small generator over the pieces the two patterns could disagree on, and
    // none of the other patterns' trigger words, so only the token rule can change the text.
    const atoms = ['eyJ', 'eyJ', 'e', 'y', 'J', 'a', 'Z', '0', '_', '-', '.', '.', '!', ' ', '/', 'aaaaaaaa', 'eyJhbGciOi'];
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 20_000; n++) {
      let text = '';
      for (let i = 1 + Math.floor(random() * 24); i > 0; i--) text += atoms[Math.floor(random() * atoms.length)];
      expect(redact(text), JSON.stringify(text)).toBe(text.replace(plain, '[token redacted]'));
    }
  });

  it('takes linear time on the runs that made the token pattern backtrack', () => {
    // Each of these took the plain pattern about two seconds (150 ms already at 16 KB);
    // a linear scan takes about one millisecond.
    for (const run of ['eyJ'.repeat(20_000), '-eyJ'.repeat(15_000), 'xeyJ'.repeat(15_000), `${'eyJ'.repeat(20_000)}.x`]) {
      const started = performance.now();
      expect(redact(run)).toBe(run);
      expect(performance.now() - started, run.slice(0, 8)).toBeLessThan(200);
    }
  });

  it('summarises an API error without its request body', () => {
    const error = Object.assign(new Error('Quota exceeded for key AIzaSyA1234567890abcdefghijklmnopqrstuv'), {
      name: 'AI_APICallError',
      statusCode: 429,
      url: 'https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?key=K&alt=sse',
      requestBodyValues: { contents: [{ parts: [{ text: 'the reader’s private question' }] }] },
    });
    const summary = describeError(error);
    expect(summary).toMatchObject({ name: 'AI_APICallError', statusCode: 429 });
    expect(summary.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent');
    expect(JSON.stringify(summary)).not.toContain('private question');
    expect(JSON.stringify(summary)).not.toContain('AIzaSyA1234567890');
  });

  it('summarises the plain objects Puter rejects with', () => {
    expect(describeError({ status: 402, code: 'insufficient_funds', message: 'No credit' })).toMatchObject({
      statusCode: 402,
      code: 'insufficient_funds',
    });
  });
});

describe('verifyPuterToken', () => {
  const ORIGIN = 'https://valheim.digitalshopuy.com';
  const OUR_APP = 'app-fe863ae9-c35c-5395-b025-d5b42c52e609';
  const USER = '6f1c2a10-1234-4abc-9def-0123456789ab';

  afterEach(() => {
    resetPuterAppUidCache();
    vi.restoreAllMocks();
  });

  function fakePuter(whoami: { status: number; body?: unknown }, appUid = OUR_APP) {
    return vi.fn(async (url: string) => {
      if (url.endsWith('/whoami')) return Response.json(whoami.body ?? {}, { status: whoami.status });
      if (url.endsWith('/auth/app-uid-from-origin')) return Response.json({ uid: appUid });
      return new Response('not found', { status: 404 });
    });
  }

  it('accepts a real account’s token issued to this site', async () => {
    const fetchImpl = fakePuter({ status: 200, body: { uuid: USER, username: 'ana', is_temp: false, app_name: OUR_APP } });
    const result = await verifyPuterToken('tok', { origins: [ORIGIN], fetchImpl });
    expect(result).toEqual({ ok: true, identity: { uuid: USER, username: 'ana' } });
  });

  it('rejects a token issued to another Puter-enabled site', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = fakePuter({
      status: 200,
      body: { uuid: USER, username: 'ana', is_temp: false, app_name: 'app-00000000-0000-5000-8000-000000000000' },
    });
    expect(await verifyPuterToken('tok', { origins: [ORIGIN], fetchImpl })).toEqual({
      ok: false,
      error: 'wrong_audience',
    });
  });

  it('rejects full-session tokens that carry no app id', async () => {
    const fetchImpl = fakePuter({ status: 200, body: { uuid: USER, username: 'ana', is_temp: false } });
    expect(await verifyPuterToken('tok', { origins: [ORIGIN], fetchImpl })).toEqual({
      ok: false,
      error: 'wrong_audience',
    });
  });

  it('rejects temporary guest accounts', async () => {
    const fetchImpl = fakePuter({ status: 200, body: { uuid: USER, username: 'guest', is_temp: true, app_name: OUR_APP } });
    expect(await verifyPuterToken('tok', { origins: [ORIGIN], fetchImpl })).toEqual({
      ok: false,
      error: 'puter_account_required',
    });
  });

  it('maps Puter’s refusals and outages', async () => {
    expect(await verifyPuterToken('tok', { origins: [ORIGIN], fetchImpl: fakePuter({ status: 401 }) })).toEqual({
      ok: false,
      error: 'puter_token_invalid',
    });
    expect(await verifyPuterToken('tok', { origins: [ORIGIN], fetchImpl: fakePuter({ status: 503 }) })).toEqual({
      ok: false,
      error: 'puter_unavailable',
    });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await verifyPuterToken('tok', { origins: [ORIGIN], fetchImpl: down })).toEqual({
      ok: false,
      error: 'puter_unreachable',
    });
  });

  it('accepts an explicitly configured app id without asking Puter for it', async () => {
    const fetchImpl = fakePuter({ status: 200, body: { uuid: USER, username: 'ana', app_name: OUR_APP } }, 'app-other');
    const result = await verifyPuterToken('tok', { origins: [ORIGIN], allowedAppUids: [OUR_APP], fetchImpl });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads PUTER_APP_UIDS and drops malformed entries', () => {
    expect(configuredPuterAppUids({ PUTER_APP_UIDS: `${OUR_APP}, junk ,` })).toEqual([OUR_APP]);
  });
});
