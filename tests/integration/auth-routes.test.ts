import { sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@/lib/db/create-db';
import { createTestDb } from '../helpers/db';

/*
 * The sign-in routes end to end, minus the network: a real database for the
 * quotas and the login limiter, real cookies, and `fetch` stubbed for Google
 * and Puter. `server-only` and the process-wide database handle are the only
 * modules replaced.
 */

vi.mock('server-only', () => ({}));

const state: { db: DbHandle | null; dbFails: boolean } = { db: null, dbFails: false };
vi.mock('@/lib/db/client', () => ({
  getDb: async () => {
    if (state.dbFails) throw new Error('database unavailable');
    return state.db!.db;
  },
}));

const { hashPassword } = await import('@/lib/auth/password');
const { createLoginDeviceToken, LOGIN_DEVICE_COOKIE, verifyLoginDeviceToken } = await import('@/lib/auth/login-device');
const { BYOK_COOKIE, openByok, sealByok, newByokSubject } = await import('@/lib/auth/byok');
const { BYOK_OWNER_COOKIE, byokKeyTag, openByokOwners, sealByokOwners } = await import('@/lib/auth/byok-owner');
const { PUTER_COOKIE, verifyPuterSessionToken, createPuterSessionToken } = await import('@/lib/auth/puter');
const { resetPuterAppUidCache } = await import('@/lib/auth/puter-verify');
const { byokEncryptionKey, purposeKey } = await import('@/lib/auth/secrets');
const { SESSION_COOKIE, createSessionToken, verifySessionToken } = await import('@/lib/auth/session');
const login = await import('@/app/api/auth/login/route');
const logout = await import('@/app/api/auth/logout/route');
const session = await import('@/app/api/auth/session/route');
const byok = await import('@/app/api/auth/byok/route');
const puter = await import('@/app/api/auth/puter/route');
const ingest = await import('@/app/api/ingest/route');

const SECRET = 'r'.repeat(48);
const PASSWORD = 'correct horse battery staple';
const GEMINI_KEY = 'AIzaSyTESTTESTTESTTESTTESTTESTTEST1234';
const PUTER_USER = '6f1c2a10-1234-4abc-9def-0123456789ab';
const OUR_APP = 'app-fe863ae9-c35c-5395-b025-d5b42c52e609';

let passwordHash: string;
let ipCounter = 0;
/**
 * A fresh client address per test, each in its own /24, so neither the
 * per-address nor the per-network windows leak between tests.
 */
let ip: string;

beforeAll(async () => {
  state.db = await createTestDb();
  passwordHash = await hashPassword(PASSWORD);
});

afterAll(async () => {
  await state.db?.close();
});

beforeEach(async () => {
  ip = `10.20.${++ipCounter}.7`;
  state.dbFails = false;
  // The shared counters (failed sign-ins, global sign-in ceilings) are everyone's: each test starts at zero.
  await state.db!.db.execute(sql`DELETE FROM login_attempts`);
  await state.db!.db.execute(sql`DELETE FROM rate_limits WHERE key LIKE '%-global|%'`);
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('APP_PASSWORD_HASH', passwordHash);
  vi.stubEnv('GUEST_CHAT_MODES', 'byok,puter');
  vi.stubEnv('APP_ORIGIN', 'https://valheim.digitalshopuy.com');
  vi.stubEnv('ADMIN_PROFILES', '');
  vi.stubEnv('GITHUB_TOKEN', '');
  vi.stubEnv('GITHUB_REPO', '');
  resetPuterAppUidCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Init = { method?: string; body?: unknown; cookies?: Record<string, string>; headers?: Record<string, string> };

function request(path: string, init: Init = {}): NextRequest {
  const headers: Record<string, string> = {
    'cf-connecting-ip': ip,
    'sec-fetch-site': 'same-origin',
    host: 'localhost:3100',
    ...init.headers,
  };
  if (init.cookies) {
    headers.cookie = Object.entries(init.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    headers['content-type'] ??= 'application/json';
  }
  return new NextRequest(`http://localhost:3100${path}`, { method: init.method ?? 'GET', headers, body });
}

type SetCookie = { value: string; maxAge: number | null; attributes: string };

/** `Set-Cookie` headers by cookie name. */
function setCookies(response: Response): Map<string, SetCookie> {
  const out = new Map<string, SetCookie>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = '', ...attrs] = header.split(';');
    const at = pair.indexOf('=');
    const maxAge = /max-age=(\d+)/i.exec(header)?.[1];
    out.set(pair.slice(0, at).trim(), {
      value: decodeURIComponent(pair.slice(at + 1)),
      maxAge: maxAge === undefined ? null : Number(maxAge),
      attributes: attrs.join(';'),
    });
  }
  return out;
}

function expectCleared(response: Response, ...names: string[]): void {
  const cookies = setCookies(response);
  for (const name of names) {
    expect(cookies.get(name), name).toMatchObject({ value: '', maxAge: 0 });
    expect(cookies.get(name)?.attributes, name).toMatch(/path=\//i);
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** Google answering both calls of the key check with `status`. */
function stubGoogle(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Puter's `/whoami` and app-id lookup. */
function stubPuter(whoami: { status: number; body?: unknown }, appUid = OUR_APP) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/whoami')) return Response.json(whoami.body ?? {}, { status: whoami.status });
    if (url.endsWith('/auth/app-uid-from-origin')) return Response.json({ uid: appUid });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function sealedKey(model: 'gemini-3.5-flash-lite' | 'gemini-3.1-flash-lite' = 'gemini-3.5-flash-lite') {
  const key = (await byokEncryptionKey())!;
  const sub = newByokSubject();
  return { sub, cookie: await sealByok({ sub, key: GEMINI_KEY, model }, key) };
}

describe('GET /api/auth/session', () => {
  it('answers 200 with the whole contract when nobody is signed in', async () => {
    const response = await session.GET(request('/api/auth/session'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await json(response)).toEqual({
      authenticated: false,
      mode: null,
      profile: null,
      name: null,
      keyHint: null,
      model: null,
      modes: { password: true, byok: true, puter: true },
      byokModels: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'],
      defaultByokModel: 'gemini-3.5-flash-lite',
    });
  });

  it('describes each kind of sign-in without revealing a credential', async () => {
    const password = await createSessionToken({ profile: 'Ragnar' }, SECRET);
    expect(await json(await session.GET(request('/api/auth/session', { cookies: { [SESSION_COOKIE]: password } })))).toMatchObject({
      authenticated: true,
      mode: 'password',
      profile: 'Ragnar',
      name: 'Ragnar',
      keyHint: null,
    });

    const { sub, cookie } = await sealedKey('gemini-3.1-flash-lite');
    const asByok = await session.GET(request('/api/auth/session', { cookies: { [BYOK_COOKIE]: cookie } }));
    const byokBody = await json(asByok);
    expect(byokBody).toMatchObject({ mode: 'byok', profile: sub, name: null, keyHint: '…1234', model: 'gemini-3.1-flash-lite' });
    expect(JSON.stringify(byokBody)).not.toContain(GEMINI_KEY);

    const puterToken = await createPuterSessionToken({ sub: `puter:${PUTER_USER}`, name: 'ana' }, (await purposeKey('puter-session'))!);
    expect(await json(await session.GET(request('/api/auth/session', { cookies: { [PUTER_COOKIE]: puterToken } })))).toMatchObject({
      mode: 'puter',
      profile: `puter:${PUTER_USER}`,
      name: 'ana',
    });
  });

  it('reports the methods this deployment offers', async () => {
    vi.stubEnv('GUEST_CHAT_MODES', 'none');
    vi.stubEnv('APP_PASSWORD_HASH', 'scrypt$65536');
    expect((await json(await session.GET(request('/api/auth/session')))).modes).toEqual({
      password: false,
      byok: false,
      puter: false,
    });
  });
});

describe('POST /api/auth/login', () => {
  const post = (body: unknown, init: Init = {}) => login.POST(request('/api/auth/login', { method: 'POST', body, ...init }));

  it('signs in, sets the session and clears the other kinds of sign-in', async () => {
    const response = await post({ password: PASSWORD, profile: '  Ragnar  ' });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true, mode: 'password', profile: 'Ragnar' });

    const cookies = setCookies(response);
    const token = cookies.get(SESSION_COOKIE);
    expect(token?.maxAge).toBe(60 * 60 * 24 * 30);
    expect(token?.attributes).toMatch(/httponly/i);
    expect(token?.attributes).toMatch(/samesite=lax/i);
    expect(await verifySessionToken(token?.value, SECRET)).toEqual({ profile: 'Ragnar' });
    expectCleared(response, BYOK_COOKIE, PUTER_COOKIE);
  });

  it('says nothing beyond "wrong" about a failed attempt', async () => {
    const response = await post({ password: 'not the password', profile: 'Ragnar' });
    expect(response.status).toBe(401);
    // No attempts-remaining count: it told a guesser each spoofed address had a fresh window.
    expect(await json(response)).toEqual({ error: 'invalid_credentials' });
    expect(setCookies(response).size).toBe(0);
  });

  it('stops guessing after ten attempts from one address', async () => {
    for (let i = 0; i < 10; i++) expect((await post({ password: `guess ${i}`, profile: 'x' })).status).toBe(401);
    const blocked = await post({ password: PASSWORD, profile: 'x' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await json(blocked)).toMatchObject({ error: 'rate_limited' });
  }, 30_000);

  it('cannot be reset by spoofing X-Forwarded-For', async () => {
    for (let i = 0; i < 10; i++) {
      await post({ password: `guess ${i}`, profile: 'x' }, { headers: { 'x-forwarded-for': `10.0.0.${i}, ${ip}` } });
    }
    const blocked = await post({ password: PASSWORD, profile: 'x' }, { headers: { 'x-forwarded-for': `10.9.9.9, ${ip}` } });
    expect(blocked.status).toBe(429);
  }, 30_000);

  it('refuses a cross-site form, and anything that is not JSON', async () => {
    const forged = await post(
      { password: PASSWORD, profile: 'mallory' },
      { headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } },
    );
    expect(forged.status).toBe(403);
    expect(setCookies(forged).size).toBe(0);

    const textPlain = await login.POST(
      request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: PASSWORD, profile: 'x' }),
        headers: { 'content-type': 'text/plain' },
      }),
    );
    expect(textPlain.status).toBe(415);
  });

  it('reports an unusable secret or hash as a server fault, not a wrong password', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('SESSION_SECRET', 'too-short');
    expect(await json(await post({ password: PASSWORD, profile: 'x' }))).toEqual({ error: 'server_misconfigured' });
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv('APP_PASSWORD_HASH', 'scrypt');
    const response = await post({ password: PASSWORD, profile: 'x' });
    expect(response.status).toBe(500);
  });

  it('rejects a profile name that could not be stored safely', async () => {
    const response = await post({ password: PASSWORD, profile: "Robert'); DROP TABLE users;--" });
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'invalid_profile' });
  });

  describe('the ceiling on guessing', () => {
    /** Signs in and returns the known-browser cookie the response set. */
    async function knownBrowser(): Promise<string> {
      const response = await post({ password: PASSWORD, profile: 'Ragnar' });
      expect(response.status).toBe(200);
      return setCookies(response).get(LOGIN_DEVICE_COOKIE)!.value;
    }

    it('marks a browser that signed in as known, for six months, and signing out leaves it', async () => {
      const response = await post({ password: PASSWORD, profile: 'Ragnar' });
      const device = setCookies(response).get(LOGIN_DEVICE_COOKIE);
      expect(device?.maxAge).toBe(60 * 60 * 24 * 180);
      expect(device?.attributes).toMatch(/httponly/i);
      expect(device?.attributes).toMatch(/samesite=strict/i);
      expect(await verifyLoginDeviceToken(device?.value, passwordHash, SECRET)).toMatch(/^[0-9a-f-]{36}$/);

      // It authorises nothing, so signing out has no reason to take it.
      const signedOut = await logout.POST(request('/api/auth/logout', { method: 'POST' }));
      expect(setCookies(signedOut).has(LOGIN_DEVICE_COOKIE)).toBe(false);
    });

    it('keeps the same browser id when a known browser signs in again', async () => {
      const first = await knownBrowser();
      const again = await post({ password: PASSWORD, profile: 'Ragnar' }, { cookies: { [LOGIN_DEVICE_COOKIE]: first } });
      const renewed = setCookies(again).get(LOGIN_DEVICE_COOKIE)?.value;
      expect(await verifyLoginDeviceToken(renewed, passwordHash, SECRET)).toBe(
        await verifyLoginDeviceToken(first, passwordHash, SECRET),
      );
    });

    it('holds one network to its share, however many addresses it uses', async () => {
      vi.stubEnv('LOGIN_NETWORK_ATTEMPTS_PER_15MIN', '2');
      const from = (last: number) => ({ headers: { 'cf-connecting-ip': `10.30.${ipCounter}.${last}` } });
      expect((await post({ password: 'guess 1', profile: 'x' }, from(1))).status).toBe(401);
      expect((await post({ password: 'guess 2', profile: 'x' }, from(2))).status).toBe(401);
      const blocked = await post({ password: PASSWORD, profile: 'x' }, from(3));
      expect(blocked.status).toBe(429);
      expect(await json(blocked)).toMatchObject({ error: 'rate_limited' });
    }, 30_000);

    it('closes to unknown browsers once everyone together has failed too often', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const known = await knownBrowser();
      vi.stubEnv('LOGIN_GLOBAL_FAILURES_PER_15MIN', '3');

      // Three networks, one guess each: no address or network is near its own limit.
      for (const n of [1, 2, 3]) {
        const guess = await post({ password: `guess ${n}`, profile: 'x' }, { headers: { 'cf-connecting-ip': `10.40.${n}.1` } });
        expect(guess.status).toBe(401);
      }
      // The moment the budget ran out is logged once, with no address in it.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.join(' ')).toContain('guarded');
      expect(warn.mock.calls[0]?.join(' ')).not.toContain('10.40.');

      // A stranger, even with the right password, waits for the window to end...
      const stranger = await post({ password: PASSWORD, profile: 'x' }, { headers: { 'cf-connecting-ip': '10.40.9.1' } });
      expect(stranger.status).toBe(429);
      expect(Number(stranger.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await json(stranger)).toMatchObject({ error: 'rate_limited' });

      // ...while a browser that has signed in before gets in, from the same address.
      const returning = await post(
        { password: PASSWORD, profile: 'Ragnar' },
        { cookies: { [LOGIN_DEVICE_COOKIE]: known }, headers: { 'cf-connecting-ip': '10.40.9.1' } },
      );
      expect(returning.status).toBe(200);
    }, 30_000);

    it('treats a known-browser cookie from before a password change as a stranger', async () => {
      vi.stubEnv('LOGIN_GLOBAL_FAILURES_PER_15MIN', '0');
      const stale = await createLoginDeviceToken(await hashPassword('the old password'), SECRET);
      const response = await post({ password: PASSWORD, profile: 'x' }, { cookies: { [LOGIN_DEVICE_COOKIE]: stale } });
      expect(response.status).toBe(429);
    });

    it('does not let an address someone else burned lock a known browser out', async () => {
      const known = await knownBrowser();
      for (let i = 0; i < 10; i++) await post({ password: `guess ${i}`, profile: 'x' });
      expect((await post({ password: PASSWORD, profile: 'x' })).status).toBe(429);
      const returning = await post({ password: PASSWORD, profile: 'Ragnar' }, { cookies: { [LOGIN_DEVICE_COOKIE]: known } });
      expect(returning.status).toBe(200);
    }, 30_000);
  });
});

describe('POST /api/auth/logout', () => {
  it('signs out of every method at once', async () => {
    const response = await logout.POST(request('/api/auth/logout', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true });
    expectCleared(response, SESSION_COOKIE, BYOK_COOKIE, PUTER_COOKIE);
  });

  it('cannot be triggered from another site', async () => {
    const response = await logout.POST(
      request('/api/auth/logout', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }),
    );
    expect(response.status).toBe(403);
    expect(setCookies(response).size).toBe(0);
  });
});

describe('POST /api/auth/byok', () => {
  const post = (body: unknown, init: Init = {}) => byok.POST(request('/api/auth/byok', { method: 'POST', body, ...init }));

  it('checks the key with Google, seals it into the cookie and shows only its last four characters', async () => {
    const google = stubGoogle(200);
    const response = await post({ key: ` ${GEMINI_KEY}\n`, model: 'gemini-3.1-flash-lite' });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toEqual({ ok: true, mode: 'byok', keyHint: '…1234', model: 'gemini-3.1-flash-lite' });
    expect(google).toHaveBeenCalledTimes(2);

    const cookies = setCookies(response);
    const sealed = cookies.get(BYOK_COOKIE)!;
    expect(sealed.value).not.toContain(GEMINI_KEY);
    expect(sealed.attributes).toMatch(/httponly/i);
    const opened = await openByok(sealed.value, (await byokEncryptionKey())!);
    expect(opened).toMatchObject({ key: GEMINI_KEY, model: 'gemini-3.1-flash-lite' });
    expect(opened?.sub).toMatch(/^byok:/);
    expectCleared(response, SESSION_COOKIE, PUTER_COOKIE);
  });

  it('keeps the same history owner when a reader replaces their key', async () => {
    stubGoogle(200);
    const { sub, cookie } = await sealedKey();
    const response = await post({ key: 'AIzaSyNEWNEWNEWNEWNEWNEWNEWNEWNEWN9876' }, { cookies: { [BYOK_COOKIE]: cookie } });
    const opened = await openByok(setCookies(response).get(BYOK_COOKIE)?.value, (await byokEncryptionKey())!);
    expect(opened).toMatchObject({ sub, key: 'AIzaSyNEWNEWNEWNEWNEWNEWNEWNEWNEWN9876', model: 'gemini-3.5-flash-lite' });
  });

  it('turns away a key Google refuses, without saving anything', async () => {
    stubGoogle(400, { error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
    const response = await post({ key: GEMINI_KEY });
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'byok_key_invalid' });
    expect(setCookies(response).size).toBe(0);
  });

  it('maps the rest of what Google can say', async () => {
    stubGoogle(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
    expect(await post({ key: GEMINI_KEY })).toMatchObject({ status: 429 });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const down = await post({ key: GEMINI_KEY });
    expect(down.status).toBe(502);
    expect(await json(down)).toEqual({ error: 'byok_unreachable' });
  });

  it('never asks Google about something that is not a key, or a model not on offer', async () => {
    const google = stubGoogle(200);
    expect(await json(await post({ key: 'short' }))).toEqual({ error: 'byok_key_invalid' });
    expect(await json(await post({ key: 'has spaces inside of it, so not a key' }))).toEqual({ error: 'byok_key_invalid' });
    expect(await json(await post({ key: GEMINI_KEY, model: 'gemini-3-pro' }))).toEqual({ error: 'invalid_request' });
    expect(google).not.toHaveBeenCalled();
  });

  it('is a limited validity oracle: five checks a minute per address', async () => {
    stubGoogle(400, { error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
    for (let i = 0; i < 5; i++) expect((await post({ key: GEMINI_KEY })).status).toBe(400);
    const limited = await post({ key: GEMINI_KEY });
    expect(limited.status).toBe(429);
    expect(await json(limited)).toMatchObject({ error: 'rate_limited' });
    expect(limited.headers.get('retry-after')).not.toBeNull();
  });

  it('has a daily ceiling for everyone together, not only per address', async () => {
    // Per address alone, one IPv6 /48 is 65,536 addresses' worth of key checks.
    vi.stubEnv('BYOK_REGISTER_GLOBAL_PER_DAY', '2');
    const google = stubGoogle(200);
    for (const n of [1, 2]) {
      expect((await post({ key: GEMINI_KEY }, { headers: { 'cf-connecting-ip': `10.50.${n}.1` } })).status).toBe(200);
    }
    const calls = google.mock.calls.length;
    const limited = await post({ key: GEMINI_KEY }, { headers: { 'cf-connecting-ip': '10.50.3.1' } });
    expect(limited.status).toBe(429);
    expect(await json(limited)).toMatchObject({ error: 'rate_limited', bucket: 'byok:register-global' });
    expect(google.mock.calls.length).toBe(calls);
  });

  it('fails closed when the quota cannot be counted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const google = stubGoogle(200);
    state.dbFails = true;
    const response = await post({ key: GEMINI_KEY });
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({ error: 'unavailable' });
    expect(google).not.toHaveBeenCalled();
  });

  it('is off when the deployment does not offer it', async () => {
    vi.stubEnv('GUEST_CHAT_MODES', 'puter');
    const response = await post({ key: GEMINI_KEY });
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: 'byok_disabled' });
  });

  it('refuses a cross-site request before reading it', async () => {
    const google = stubGoogle(200);
    const response = await post({ key: GEMINI_KEY }, { headers: { 'sec-fetch-site': 'same-site' } });
    expect(response.status).toBe(403);
    expect(google).not.toHaveBeenCalled();
  });
});

describe('PATCH and DELETE /api/auth/byok', () => {
  it('changes the model and nothing else', async () => {
    const { sub, cookie } = await sealedKey();
    const response = await byok.PATCH(
      request('/api/auth/byok', { method: 'PATCH', body: { model: 'gemini-2.5-flash-lite' }, cookies: { [BYOK_COOKIE]: cookie } }),
    );
    expect(await json(response)).toEqual({ ok: true, mode: 'byok', keyHint: '…1234', model: 'gemini-2.5-flash-lite' });
    const opened = await openByok(setCookies(response).get(BYOK_COOKIE)?.value, (await byokEncryptionKey())!);
    expect(opened).toEqual({ sub, key: GEMINI_KEY, model: 'gemini-2.5-flash-lite' });
  });

  it('needs a saved key to change', async () => {
    const response = await byok.PATCH(request('/api/auth/byok', { method: 'PATCH', body: { model: 'gemini-2.5-flash-lite' } }));
    expect(response.status).toBe(401);
  });

  it('forgets the key', async () => {
    const response = await byok.DELETE(request('/api/auth/byok', { method: 'DELETE' }));
    expect(await json(response)).toEqual({ ok: true });
    expectCleared(response, BYOK_COOKIE);
  });
});

describe('the history a Gemini key opens', () => {
  const OTHER_KEY = 'AIzaSyOTHEROTHEROTHEROTHEROTHEROTH5678';
  type Jar = Record<string, string>;

  /** The cookies a browser holds after `response`: set ones replaced, expired ones gone. */
  function after(jar: Jar, response: Response): Jar {
    const next = { ...jar };
    for (const [name, cookie] of setCookies(response)) {
      if (cookie.maxAge === 0) delete next[name];
      else next[name] = cookie.value;
    }
    return next;
  }

  /** Signs in with `key` from a browser holding `jar`; the owner it signed in as, and the browser's cookies after. */
  async function signInWith(key: string, jar: Jar = {}): Promise<{ sub: string; jar: Jar; response: Response }> {
    stubGoogle(200);
    const response = await byok.POST(request('/api/auth/byok', { method: 'POST', body: { key }, cookies: jar }));
    expect(response.status).toBe(200);
    const opened = await openByok(setCookies(response).get(BYOK_COOKIE)?.value, (await byokEncryptionKey())!);
    return { sub: opened!.sub, jar: after(jar, response), response };
  }

  async function signOut(jar: Jar): Promise<Jar> {
    return after(jar, await logout.POST(request('/api/auth/logout', { method: 'POST', cookies: jar })));
  }

  it('comes back when the same key signs in again in this browser, however the reader left', async () => {
    const first = await signInWith(GEMINI_KEY);
    // A conversation of theirs, which no way of leaving deletes (what the chat's copy promises).
    const { beginTurn, getConversation } = await import('@/lib/db/repo');
    const conversationId = `byok-history-${ipCounter}`;
    await beginTurn(state.db!.db, {
      conversationId,
      profile: first.sub,
      title: 'Bonemass',
      lang: 'es',
      userMessageId: `${conversationId}:q1`,
      answerId: `${conversationId}:q1:a`,
      question: '¿Cómo invoco a Bonemass?',
    });

    // Signing out.
    let jar = await signOut(first.jar);
    expect(jar[BYOK_COOKIE]).toBeUndefined();
    expect((await signInWith(GEMINI_KEY, jar)).sub).toBe(first.sub);

    // "Forget key".
    jar = after(jar, await byok.DELETE(request('/api/auth/byok', { method: 'DELETE', cookies: jar })));
    expect((await signInWith(GEMINI_KEY, jar)).sub).toBe(first.sub);

    // Switching to the password and back.
    const password = await login.POST(
      request('/api/auth/login', { method: 'POST', body: { password: PASSWORD, profile: 'Ragnar' }, cookies: jar }),
    );
    expect(password.status).toBe(200);
    jar = after(jar, password);
    expect(jar[BYOK_COOKIE]).toBeUndefined();
    const back = await signInWith(GEMINI_KEY, jar);
    expect(back.sub).toBe(first.sub);

    // Switching to Puter and back.
    stubPuter({ status: 200, body: { uuid: PUTER_USER, username: 'ana', is_temp: false, app_name: OUR_APP } });
    const viaPuter = await puter.POST(request('/api/auth/puter', { method: 'POST', body: { token: 'puter-token' }, cookies: back.jar }));
    expect(viaPuter.status).toBe(200);
    jar = after(back.jar, viaPuter);
    expect(jar[BYOK_COOKIE]).toBeUndefined();
    expect(jar[PUTER_COOKIE]).toBeDefined();
    expect((await signInWith(GEMINI_KEY, jar)).sub).toBe(first.sub);

    // And the conversation was there all along, still the key's.
    expect(await getConversation(state.db!.db, conversationId, first.sub)).toMatchObject({ id: conversationId });
  });

  it('comes back after the key’s own cookie has run out', async () => {
    const first = await signInWith(GEMINI_KEY);
    // Gone, as an expired cookie is from a browser, or sent but past its date.
    const { [BYOK_COOKIE]: _expired, ...withoutKey } = first.jar;
    expect((await signInWith(GEMINI_KEY, withoutKey)).sub).toBe(first.sub);
    const stale = await sealByok({ sub: first.sub, key: GEMINI_KEY, model: 'gemini-3.5-flash-lite' }, (await byokEncryptionKey())!, -10);
    expect((await signInWith(GEMINI_KEY, { ...withoutKey, [BYOK_COOKIE]: stale })).sub).toBe(first.sub);
  });

  it('gives another key in the same browser its own history, and keeps the two apart', async () => {
    const ana = await signInWith(GEMINI_KEY);
    const bo = await signInWith(OTHER_KEY, await signOut(ana.jar));
    expect(bo.sub).not.toBe(ana.sub);

    const anaAgain = await signInWith(GEMINI_KEY, await signOut(bo.jar));
    expect(anaAgain.sub).toBe(ana.sub);
    expect((await signInWith(OTHER_KEY, await signOut(anaAgain.jar))).sub).toBe(bo.sub);
  });

  it('never follows a key to another browser', async () => {
    const here = await signInWith(GEMINI_KEY);
    expect((await signInWith(GEMINI_KEY, {})).sub).not.toBe(here.sub);
  });

  it('follows the key that replaced the old one', async () => {
    const first = await signInWith(GEMINI_KEY);
    // Replaced while signed in: the history stays (spec §3.2), and now opens with the new key.
    const replaced = await signInWith(OTHER_KEY, first.jar);
    expect(replaced.sub).toBe(first.sub);
    const jar = await signOut(replaced.jar);
    expect((await signInWith(OTHER_KEY, jar)).sub).toBe(first.sub);
    expect((await signInWith(GEMINI_KEY, jar)).sub).not.toBe(first.sub);
  });

  it('is remembered without the key, outside the auth cookies, and renewed with them', async () => {
    const { sub, jar, response } = await signInWith(GEMINI_KEY);
    const record = setCookies(response).get(BYOK_OWNER_COOKIE)!;
    expect(record.value).not.toContain(GEMINI_KEY);
    expect(record.maxAge).toBe(60 * 60 * 24 * 180);
    expect(record.attributes).toMatch(/httponly/i);
    expect(record.attributes).toMatch(/samesite=strict/i);
    expect(record.attributes).toMatch(/path=\//i);
    const key = (await byokEncryptionKey())!;
    expect(await openByokOwners(record.value, key)).toEqual([{ sub, tag: await byokKeyTag(GEMINI_KEY, key) }]);

    // It signs nobody in, and it cannot pass for the key's cookie, nor the reverse.
    const recordOnly = await json(await session.GET(request('/api/auth/session', { cookies: { [BYOK_OWNER_COOKIE]: record.value } })));
    expect(recordOnly).toMatchObject({ authenticated: false });
    expect(await openByok(record.value, key)).toBeNull();
    expect(await openByokOwners(jar[BYOK_COOKIE], key)).toEqual([]);

    // Signing out and the other sign-ins leave it alone.
    const signedOut = await logout.POST(request('/api/auth/logout', { method: 'POST', cookies: jar }));
    expect(setCookies(signedOut).has(BYOK_OWNER_COOKIE)).toBe(false);

    // A model change renews it, so it cannot run out while the key is in use.
    const patched = await byok.PATCH(
      request('/api/auth/byok', { method: 'PATCH', body: { model: 'gemini-2.5-flash-lite' }, cookies: jar }),
    );
    const renewed = setCookies(patched).get(BYOK_OWNER_COOKIE)!;
    expect(renewed.maxAge).toBe(60 * 60 * 24 * 180);
    expect(await openByokOwners(renewed.value, key)).toEqual([{ sub, tag: await byokKeyTag(GEMINI_KEY, key) }]);
  });

  it('ignores a record it cannot read and starts afresh', async () => {
    const first = await signInWith(GEMINI_KEY);
    const foreignKey = (await byokEncryptionKey({ SESSION_SECRET: 'z'.repeat(48) }))!;
    const foreign = await sealByokOwners([{ sub: first.sub, tag: await byokKeyTag(GEMINI_KEY, foreignKey) }], foreignKey);
    for (const record of [foreign, 'not-a-token', first.jar[BYOK_COOKIE]!]) {
      expect((await signInWith(GEMINI_KEY, { [BYOK_OWNER_COOKIE]: record })).sub).not.toBe(first.sub);
    }
  });
});

describe('POST /api/auth/puter', () => {
  const post = (body: unknown, init: Init = {}) => puter.POST(request('/api/auth/puter', { method: 'POST', body, ...init }));

  it('verifies the token with Puter and issues this site’s own cookie', async () => {
    stubPuter({ status: 200, body: { uuid: PUTER_USER, username: 'ana', is_temp: false, app_name: OUR_APP } });
    const response = await post({ token: 'puter-token' });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true, mode: 'puter', name: 'ana' });

    const cookie = setCookies(response).get(PUTER_COOKIE)!;
    expect(cookie.maxAge).toBe(60 * 60 * 24);
    expect(cookie.value).not.toContain('puter-token');
    expect(await verifyPuterSessionToken(cookie.value, (await purposeKey('puter-session'))!)).toEqual({
      sub: `puter:${PUTER_USER}`,
      name: 'ana',
    });
    expectCleared(response, SESSION_COOKIE, BYOK_COOKIE);
  });

  it.each([
    ['an invalid token', { status: 401 }, OUR_APP, 401, 'puter_token_invalid'],
    ['a token issued to another site', { status: 200, body: { uuid: PUTER_USER, app_name: 'app-00000000-0000-5000-8000-000000000000' } }, OUR_APP, 403, 'wrong_audience'],
    ['a temporary guest account', { status: 200, body: { uuid: PUTER_USER, is_temp: true, app_name: OUR_APP } }, OUR_APP, 403, 'puter_account_required'],
    ['Puter failing', { status: 503 }, OUR_APP, 502, 'puter_unavailable'],
  ] as const)('maps %s one to one', async (_name, whoami, appUid, status, error) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubPuter(whoami, appUid);
    const response = await post({ token: 'puter-token' });
    expect(response.status).toBe(status);
    expect(await json(response)).toEqual({ error });
    expect(setCookies(response).size).toBe(0);
  });

  it('reports Puter being unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const response = await post({ token: 'puter-token' });
    expect(response.status).toBe(502);
    expect(await json(response)).toEqual({ error: 'puter_unreachable' });
  });

  it('only accepts tokens for the configured origin outside development', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = stubPuter({ status: 200, body: { uuid: PUTER_USER, app_name: OUR_APP } });
    await post({ token: 'puter-token' }, { headers: { host: 'evil.example' } });
    const asked = fetchMock.mock.calls
      .filter(([url]) => url.endsWith('/auth/app-uid-from-origin'))
      .map(([, init]) => (JSON.parse(String(init?.body)) as { origin: string }).origin);
    expect(asked).toEqual(['https://valheim.digitalshopuy.com']);
  });

  it('is off when the deployment does not offer it', async () => {
    vi.stubEnv('GUEST_CHAT_MODES', 'byok');
    expect(await json(await post({ token: 'puter-token' }))).toEqual({ error: 'puter_disabled' });
  });

  it('has a daily ceiling for everyone together, not only per address', async () => {
    vi.stubEnv('PUTER_EXCHANGE_GLOBAL_PER_DAY', '1');
    const fetchMock = stubPuter({ status: 200, body: { uuid: PUTER_USER, username: 'ana', app_name: OUR_APP } });
    expect((await post({ token: 'puter-token' }, { headers: { 'cf-connecting-ip': '10.60.1.1' } })).status).toBe(200);
    const calls = fetchMock.mock.calls.length;
    const limited = await post({ token: 'puter-token' }, { headers: { 'cf-connecting-ip': '10.60.2.1' } });
    expect(limited.status).toBe(429);
    expect(await json(limited)).toMatchObject({ error: 'rate_limited', bucket: 'puter:exchange-global' });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('fails closed when the quota cannot be counted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = stubPuter({ status: 200, body: { uuid: PUTER_USER, app_name: OUR_APP } });
    state.dbFails = true;
    expect((await post({ token: 'puter-token' })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disconnects', async () => {
    const response = await puter.DELETE(request('/api/auth/puter', { method: 'DELETE' }));
    expect(await json(response)).toEqual({ ok: true });
    expectCleared(response, PUTER_COOKIE);
  });
});

describe('/api/ingest', () => {
  async function asPassword(profile = 'Ragnar') {
    return { [SESSION_COOKIE]: await createSessionToken({ profile }, SECRET) };
  }

  it('is for password holders only', async () => {
    expect((await ingest.GET(request('/api/ingest'))).status).toBe(401);
    const { cookie } = await sealedKey();
    expect((await ingest.GET(request('/api/ingest', { cookies: { [BYOK_COOKIE]: cookie } }))).status).toBe(403);
    expect((await ingest.POST(request('/api/ingest', { method: 'POST', cookies: { [BYOK_COOKIE]: cookie } }))).status).toBe(403);

    const response = await ingest.GET(request('/api/ingest', { cookies: await asPassword() }));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ stats: { chunks: 0, pages: 0 }, canTrigger: false, runs: [] });
  });

  it('narrows re-indexing to ADMIN_PROFILES when it is set', async () => {
    vi.stubEnv('ADMIN_PROFILES', 'Odín, Airau');
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    vi.stubEnv('GITHUB_REPO', 'owner/repo');
    const github = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', github);

    const refused = await ingest.POST(request('/api/ingest', { method: 'POST', cookies: await asPassword('Ragnar') }));
    expect(refused.status).toBe(403);
    expect(github).not.toHaveBeenCalled();
    expect(await json(await ingest.GET(request('/api/ingest', { cookies: await asPassword('Ragnar') })))).toMatchObject({
      canTrigger: false,
    });

    const allowed = await ingest.POST(request('/api/ingest', { method: 'POST', cookies: await asPassword('Airau') }));
    expect(await json(allowed)).toEqual({ ok: true, dispatched: true });
    const [, init] = github.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ ref: 'main', inputs: { trigger: 'app:Airau' } });
  });

  it("names a run's starter only to that same profile", async () => {
    const { startIngestRun } = await import('@/lib/db/repo');
    await state.db!.db.execute(sql`DELETE FROM ingest_runs`);
    await startIngestRun(state.db!.db, 'run-app', 'app:Odín_Grey');
    await startIngestRun(state.db!.db, 'run-schedule', 'schedule');

    const triggers = async (profile: string) => {
      const body = (await json(await ingest.GET(request('/api/ingest', { cookies: await asPassword(profile) })))) as {
        runs: { id: string; trigger: string }[];
      };
      return Object.fromEntries(body.runs.map((r) => [r.id, r.trigger]));
    };
    expect(await triggers('Odín Grey')).toEqual({ 'run-app': 'app:Odín_Grey', 'run-schedule': 'schedule' });
    expect(await triggers('Ragnar')).toEqual({ 'run-app': 'app', 'run-schedule': 'schedule' });
    await state.db!.db.execute(sql`DELETE FROM ingest_runs`);
  });

  it('refuses a cross-site dispatch', async () => {
    const response = await ingest.POST(
      request('/api/ingest', { method: 'POST', cookies: await asPassword(), headers: { 'sec-fetch-site': 'cross-site' } }),
    );
    expect(response.status).toBe(403);
  });

  it('says when dispatching is not configured', async () => {
    const response = await ingest.POST(request('/api/ingest', { method: 'POST', cookies: await asPassword() }));
    expect(response.status).toBe(501);
  });
});
