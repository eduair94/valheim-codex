import { base64url } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminProfiles, mayReindex } from '@/lib/auth/admin';
import { hashPassword } from '@/lib/auth/password';
import { puterOrigins } from '@/lib/auth/puter-signin';
import { checkConfiguration, reportConfiguration } from '@/lib/env';

const SECRET = 'q'.repeat(43);
let HASH: string;

beforeAll(async () => {
  HASH = await hashPassword('a-long-enough-password');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('checkConfiguration', () => {
  it('has nothing to say about a complete, valid configuration', () => {
    expect(
      checkConfiguration({
        SESSION_SECRET: SECRET,
        APP_PASSWORD_HASH: HASH,
        BYOK_SECRET: base64url.encode(new Uint8Array(32).fill(9)),
        GUEST_CHAT_MODES: 'byok, puter',
        APP_ORIGIN: 'https://valheim.digitalshopuy.com',
        PUTER_APP_UIDS: 'app-fe863ae9-c35c-5395-b025-d5b42c52e609',
        ADMIN_PROFILES: 'Airau',
      }),
    ).toEqual([]);
  });

  it('flags a session secret too short to sign with, by its length only', () => {
    const problems = checkConfiguration({ SESSION_SECRET: 'hunter2', APP_PASSWORD_HASH: HASH });
    expect(problems).toEqual([{ level: 'error', message: expect.stringContaining('SESSION_SECRET is 7 characters') }]);
    expect(JSON.stringify(problems)).not.toContain('hunter2');
  });

  it('flags a hash mangled by $-expansion, without printing it', () => {
    const problems = checkConfiguration({ SESSION_SECRET: SECRET, APP_PASSWORD_HASH: 'scrypt' });
    expect(problems).toEqual([{ level: 'error', message: expect.stringContaining('APP_PASSWORD_HASH is not a valid') }]);
  });

  it('points every fix at the tool the Docker host has, not at Fly', async () => {
    const messages = [
      ...checkConfiguration({ SESSION_SECRET: 'hunter2', APP_PASSWORD_HASH: 'scrypt' }).map((p) => p.message),
    ];
    // The request-time line, from a module that has not warned yet in this process.
    vi.resetModules();
    const { sessionSecret } = await import('@/lib/auth/secrets');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(sessionSecret({ SESSION_SECRET: 'x'.repeat(20) })).toBeNull();
    messages.push(String(error.mock.calls[0]?.[0]));

    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message).toContain('node scripts/set-password.mjs');
      expect(message).toContain('docker compose up -d');
      expect(message).not.toMatch(/deploy:secrets|flyctl|server:password/);
    }
  });

  it('notes the features a missing variable switches off', () => {
    const problems = checkConfiguration({});
    expect(problems.map((p) => p.level)).toEqual(['warn', 'warn']);
    expect(problems[0]?.message).toContain('SESSION_SECRET is not set');
    expect(problems[1]?.message).toContain('APP_PASSWORD_HASH is not set');
  });

  it('requires BYOK_SECRET to be exactly 32 bytes when set', () => {
    for (const bad of [base64url.encode(new Uint8Array(16)), 'not base64 at all!', 'short']) {
      const problems = checkConfiguration({ SESSION_SECRET: SECRET, APP_PASSWORD_HASH: HASH, BYOK_SECRET: bad });
      expect(problems).toEqual([{ level: 'error', message: expect.stringContaining('BYOK_SECRET must be 32') }]);
      expect(JSON.stringify(problems)).not.toContain(bad);
    }
  });

  it('names guest modes it does not know', () => {
    const base = { SESSION_SECRET: SECRET, APP_PASSWORD_HASH: HASH };
    expect(checkConfiguration({ ...base, GUEST_CHAT_MODES: 'byok,gemini' })).toEqual([
      { level: 'warn', message: expect.stringContaining('"gemini"') },
    ]);
    expect(checkConfiguration({ ...base, GUEST_CHAT_MODES: 'none,puter' })).toEqual([
      { level: 'warn', message: expect.stringContaining('combines "none"') },
    ]);
    expect(checkConfiguration({ ...base, GUEST_CHAT_MODES: 'none' })).toEqual([]);
    // A value that names no mode at all is a typo that switched both guests off: say so.
    expect(checkConfiguration({ ...base, GUEST_CHAT_MODES: 'gemini' })).toEqual([
      { level: 'warn', message: expect.stringContaining('Gemini-key and Puter sign-in are both off') },
    ]);
    expect(checkConfiguration({ ...base, GUEST_CHAT_MODES: 'byok,gemini' })[0]?.message).not.toContain('both off');
  });

  it('reads a blank GUEST_CHAT_MODES as the default, with nothing to report', () => {
    const base = { SESSION_SECRET: SECRET, APP_PASSWORD_HASH: HASH };
    for (const blank of ['', '   ', ',', ' , ']) {
      expect(checkConfiguration({ ...base, GUEST_CHAT_MODES: blank }), JSON.stringify(blank)).toEqual([]);
    }
  });

  it('warns about entries the app will silently ignore', () => {
    const base = { SESSION_SECRET: SECRET, APP_PASSWORD_HASH: HASH };
    expect(checkConfiguration({ ...base, APP_ORIGIN: 'https://ok.example, valheim.example/path' })).toHaveLength(1);
    expect(checkConfiguration({ ...base, PUTER_APP_UIDS: 'app-123' })).toHaveLength(1);
    expect(checkConfiguration({ ...base, ADMIN_PROFILES: '<script>' })[0]?.message).toContain('nobody can re-index');
    expect(checkConfiguration({ ...base, CSP_ENFORCE: 'yes' })[0]?.message).toContain('stays report-only');
  });

  it('reminds a production deployment that the policy is still report-only, until it is enforced', () => {
    const base = { SESSION_SECRET: SECRET, APP_PASSWORD_HASH: HASH, NODE_ENV: 'production' };
    expect(checkConfiguration(base)).toEqual([{ level: 'warn', message: expect.stringContaining('CSP_ENFORCE=1') }]);
    expect(checkConfiguration({ ...base, CSP_ENFORCE: '0' })).toHaveLength(1);
    expect(checkConfiguration({ ...base, CSP_ENFORCE: '1' })).toEqual([]);
    expect(checkConfiguration({ ...base, CSP_ENFORCE: 'true' })).toEqual([]);
    // Development always enforces.
    expect(checkConfiguration({ ...base, NODE_ENV: 'development' })).toEqual([]);
  });

  it('reports once per process, and never throws for a bad value', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportConfiguration({ SESSION_SECRET: 'short', APP_PASSWORD_HASH: 'scrypt' });
    reportConfiguration({ SESSION_SECRET: 'short', APP_PASSWORD_HASH: 'scrypt' });
    expect(error).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toMatch(/^\[config\] /);
  });
});

describe('re-indexing permission', () => {
  const password = { kind: 'password', profile: 'Airau' } as const;

  it('belongs to every password holder unless ADMIN_PROFILES narrows it', () => {
    expect(adminProfiles({})).toBeNull();
    expect(mayReindex(password, {})).toBe(true);
    expect(mayReindex(password, { ADMIN_PROFILES: ' Odín ,  Airau ' })).toBe(true);
    expect(mayReindex({ kind: 'password', profile: 'Ragnar' }, { ADMIN_PROFILES: 'Odín,Airau' })).toBe(false);
  });

  it('never belongs to a guest', () => {
    expect(mayReindex({ kind: 'puter', profile: 'puter:x', name: 'Airau' }, {})).toBe(false);
    expect(mayReindex(null, {})).toBe(false);
  });

  it('fails closed when every listed name is invalid', () => {
    expect(adminProfiles({ ADMIN_PROFILES: '<b>, ;' })).toEqual([]);
    expect(mayReindex(password, { ADMIN_PROFILES: '<b>' })).toBe(false);
  });
});

describe('puterOrigins', () => {
  const headers = new Headers({ host: 'localhost:3100' });

  it('trusts configuration only, outside development', () => {
    vi.stubEnv('APP_ORIGIN', '');
    expect(puterOrigins(headers, { NODE_ENV: 'production' })).toEqual(['https://valheim.digitalshopuy.com']);
    expect(puterOrigins(new Headers({ host: 'evil.example' }), { NODE_ENV: 'test' })).toEqual([
      'https://valheim.digitalshopuy.com',
    ]);
  });

  it('adds the dev server’s own address in development', () => {
    vi.stubEnv('APP_ORIGIN', '');
    expect(puterOrigins(headers, { NODE_ENV: 'development' })).toEqual([
      'https://valheim.digitalshopuy.com',
      'http://localhost:3100',
      'https://localhost:3100',
    ]);
    expect(puterOrigins(new Headers({ host: 'bad host/with path' }), { NODE_ENV: 'development' })).toEqual([
      'https://valheim.digitalshopuy.com',
    ]);
  });
});
