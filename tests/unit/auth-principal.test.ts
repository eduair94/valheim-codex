import { base64url, EncryptJWT, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  BYOK_COOKIE,
  DEFAULT_BYOK_MODEL,
  isPlausibleApiKey,
  keyHint,
  newByokSubject,
  openByok,
  sealByok,
} from '@/lib/auth/byok';
import {
  byokKeyTag,
  openByokOwners,
  rememberByokOwner,
  sealByokOwners,
  type ByokOwner,
} from '@/lib/auth/byok-owner';
import { guestModes, isOperatorPaid, parseGuestModes, resolvePrincipal } from '@/lib/auth/principal';
import { createPuterSessionToken, PUTER_COOKIE, verifyPuterSessionToken } from '@/lib/auth/puter';
import { byokEncryptionKey, purposeKey, sessionSecret } from '@/lib/auth/secrets';
import { createSessionToken, SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';

const SECRET = 's'.repeat(48);
const ENV = { SESSION_SECRET: SECRET };
const GEMINI_KEY = 'AIzaSyTESTTESTTESTTESTTESTTESTTEST1234';

function reader(cookies: Record<string, string>) {
  return (name: string) => cookies[name];
}

describe('secrets', () => {
  it('refuses a session secret too short to resist offline guessing', () => {
    expect(sessionSecret({ SESSION_SECRET: 'short' })).toBeNull();
    expect(sessionSecret({})).toBeNull();
    expect(sessionSecret(ENV)).toBe(SECRET);
  });

  it('derives the cookie key from the session secret when BYOK_SECRET is unset', async () => {
    const a = await byokEncryptionKey(ENV);
    const b = await byokEncryptionKey(ENV);
    expect(a).toHaveLength(32);
    expect(a).toEqual(b);
    expect(await byokEncryptionKey({ SESSION_SECRET: 't'.repeat(48) })).not.toEqual(a);
  });

  it('uses an explicit BYOK_SECRET and rejects one of the wrong length', async () => {
    const raw = new Uint8Array(32).fill(7);
    expect(await byokEncryptionKey({ ...ENV, BYOK_SECRET: base64url.encode(raw) })).toEqual(raw);
    expect(await byokEncryptionKey({ ...ENV, BYOK_SECRET: base64url.encode(new Uint8Array(16)) })).toBeNull();
    expect(await byokEncryptionKey({ ...ENV, BYOK_SECRET: '%%%not-base64%%%' })).toBeNull();
  });

  it('keeps purpose keys apart from each other and from the raw secret', async () => {
    const puter = await purposeKey('puter-session', ENV);
    const grant = await purposeKey('answer-grant', ENV);
    expect(puter).not.toEqual(grant);
    expect(puter).not.toEqual(new TextEncoder().encode(SECRET));
  });
});

describe('own Gemini key cookie', () => {
  it('round-trips the key, model and subject', async () => {
    const key = (await byokEncryptionKey(ENV))!;
    const sub = newByokSubject();
    const token = await sealByok({ sub, key: GEMINI_KEY, model: 'gemini-3.1-flash-lite' }, key);
    expect(token).not.toContain(GEMINI_KEY);
    expect(await openByok(token, key)).toEqual({ sub, key: GEMINI_KEY, model: 'gemini-3.1-flash-lite' });
  });

  it('rejects a cookie sealed under another key, tampered with, or expired', async () => {
    const key = (await byokEncryptionKey(ENV))!;
    const other = (await byokEncryptionKey({ SESSION_SECRET: 'x'.repeat(48) }))!;
    const token = await sealByok({ sub: newByokSubject(), key: GEMINI_KEY, model: DEFAULT_BYOK_MODEL }, key);
    expect(await openByok(token, other)).toBeNull();

    const parts = token.split('.');
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith('AA') ? 'BB' : 'AA');
    expect(await openByok(parts.join('.'), key)).toBeNull();

    const expired = await sealByok({ sub: newByokSubject(), key: GEMINI_KEY, model: DEFAULT_BYOK_MODEL }, key, -10);
    expect(await openByok(expired, key)).toBeNull();
    expect(await openByok(undefined, key)).toBeNull();
  });

  it('only shows a four-character hint', () => {
    expect(keyHint(GEMINI_KEY)).toBe('…1234');
  });

  it('accepts any printable key of plausible length rather than guessing at prefixes', () => {
    expect(isPlausibleApiKey(GEMINI_KEY)).toBe(true);
    expect(isPlausibleApiKey('AQ.Ab8RN6KfakeServiceAccountAuthKey_123')).toBe(true);
    expect(isPlausibleApiKey('short')).toBe(false);
    expect(isPlausibleApiKey('has spaces in it but long enough')).toBe(false);
    expect(isPlausibleApiKey(undefined)).toBe(false);
  });
});

describe('the record of which history a key opens', () => {
  const sub = (n: number) => `byok:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('tags a key the same way every time, and differently for another key or another server', async () => {
    const key = (await byokEncryptionKey(ENV))!;
    const tag = await byokKeyTag(GEMINI_KEY, key);
    expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(tag).not.toContain(GEMINI_KEY.slice(4, 12));
    expect(await byokKeyTag(GEMINI_KEY, key)).toBe(tag);
    expect(await byokKeyTag('AIzaSyOTHEROTHEROTHEROTHEROTHEROTH5678', key)).not.toBe(tag);
    expect(await byokKeyTag(GEMINI_KEY, (await byokEncryptionKey({ SESSION_SECRET: 'x'.repeat(48) }))!)).not.toBe(tag);
  });

  it('keeps the latest few, one entry per history and per key', () => {
    let owners: ByokOwner[] = [];
    for (let n = 1; n <= 6; n++) owners = rememberByokOwner(owners, { sub: sub(n), tag: `tag-${n}`.padEnd(22, 'x') });
    expect(owners.map((o) => o.sub)).toEqual([sub(6), sub(5), sub(4), sub(3)]);
    // The same history with a new key, and a key that now opens another history, replace their old entries.
    owners = rememberByokOwner(owners, { sub: sub(4), tag: 'new-key'.padEnd(22, 'x') });
    owners = rememberByokOwner(owners, { sub: sub(9), tag: `tag-6`.padEnd(22, 'x') });
    expect(owners).toEqual([
      { sub: sub(9), tag: 'tag-6'.padEnd(22, 'x') },
      { sub: sub(4), tag: 'new-key'.padEnd(22, 'x') },
      { sub: sub(5), tag: 'tag-5'.padEnd(22, 'x') },
      { sub: sub(3), tag: 'tag-3'.padEnd(22, 'x') },
    ]);
  });

  it('round-trips, and reads as empty when expired, tampered with or foreign', async () => {
    const key = (await byokEncryptionKey(ENV))!;
    const owners = [{ sub: sub(1), tag: await byokKeyTag(GEMINI_KEY, key) }];
    const record = await sealByokOwners(owners, key);
    expect(record).not.toContain(GEMINI_KEY);
    expect(await openByokOwners(record, key)).toEqual(owners);

    expect(await openByokOwners(await sealByokOwners(owners, key, -10), key)).toEqual([]);
    expect(await openByokOwners(record, (await byokEncryptionKey({ SESSION_SECRET: 'x'.repeat(48) }))!)).toEqual([]);
    const parts = record.split('.');
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith('AA') ? 'BB' : 'AA');
    expect(await openByokOwners(parts.join('.'), key)).toEqual([]);
    expect(await openByokOwners(undefined, key)).toEqual([]);
    // The key's own cookie, under the same key, is not a record.
    expect(await openByokOwners(await sealByok({ sub: sub(1), key: GEMINI_KEY, model: DEFAULT_BYOK_MODEL }, key), key)).toEqual([]);
  });

  it('drops entries of the wrong shape one by one', async () => {
    const key = (await byokEncryptionKey(ENV))!;
    const good = { sub: sub(1), tag: 'a'.repeat(22) };
    const record = await new EncryptJWT({ o: [[good.sub, good.tag], ['Ragnar', 'a'.repeat(22)], [sub(2), 'short'], 'x', [sub(3)]] })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuer('wiki-valheim')
      .setAudience('wiki-valheim-byok-owner')
      .setExpirationTime('1h')
      .encrypt(key);
    expect(await openByokOwners(record, key)).toEqual([good]);
  });
});

describe('principal resolution', () => {
  it('never lets a guest token pass as a password session', async () => {
    const puterKey = (await purposeKey('puter-session', ENV))!;
    const puterToken = await createPuterSessionToken({ sub: `puter:${crypto.randomUUID()}`, name: 'ana' }, puterKey);
    expect(await verifySessionToken(puterToken, SECRET)).toBeNull();

    // Even a guest-shaped token signed with the raw secret fails: wrong audience.
    const forged = await new SignJWT({ profile: 'mallory' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('wiki-valheim')
      .setAudience('wiki-valheim-puter')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifySessionToken(forged, SECRET)).toBeNull();
  });

  it('never lets a password session pass as a Puter session', async () => {
    const puterKey = (await purposeKey('puter-session', ENV))!;
    const session = await createSessionToken({ profile: 'ana' }, SECRET);
    expect(await verifyPuterSessionToken(session, puterKey)).toBeNull();
  });

  it('resolves each kind from its own cookie', async () => {
    const session = await createSessionToken({ profile: 'Ragnar' }, SECRET);
    expect(await resolvePrincipal(reader({ [SESSION_COOKIE]: session }), ENV)).toEqual({
      kind: 'password',
      profile: 'Ragnar',
    });

    const key = (await byokEncryptionKey(ENV))!;
    const sub = newByokSubject();
    const byok = await sealByok({ sub, key: GEMINI_KEY, model: DEFAULT_BYOK_MODEL }, key);
    expect(await resolvePrincipal(reader({ [BYOK_COOKIE]: byok }), ENV)).toEqual({
      kind: 'byok',
      profile: sub,
      apiKey: GEMINI_KEY,
      model: DEFAULT_BYOK_MODEL,
    });

    const puterKey = (await purposeKey('puter-session', ENV))!;
    const puterSub = `puter:${crypto.randomUUID()}`;
    const puter = await createPuterSessionToken({ sub: puterSub, name: 'ana' }, puterKey);
    expect(await resolvePrincipal(reader({ [PUTER_COOKIE]: puter }), ENV)).toEqual({
      kind: 'puter',
      profile: puterSub,
      name: 'ana',
    });

    expect(await resolvePrincipal(reader({}), ENV)).toBeNull();
  });

  it('prefers the password session when cookies of several kinds are present', async () => {
    const session = await createSessionToken({ profile: 'Ragnar' }, SECRET);
    const key = (await byokEncryptionKey(ENV))!;
    const byok = await sealByok({ sub: newByokSubject(), key: GEMINI_KEY, model: DEFAULT_BYOK_MODEL }, key);
    const principal = await resolvePrincipal(reader({ [SESSION_COOKIE]: session, [BYOK_COOKIE]: byok }), ENV);
    expect(principal?.kind).toBe('password');
    expect(isOperatorPaid(principal)).toBe(true);
  });

  it('turns a guest mode off for cookies already issued', async () => {
    const key = (await byokEncryptionKey(ENV))!;
    const byok = await sealByok({ sub: newByokSubject(), key: GEMINI_KEY, model: DEFAULT_BYOK_MODEL }, key);
    expect(await resolvePrincipal(reader({ [BYOK_COOKIE]: byok }), { ...ENV, GUEST_CHAT_MODES: 'puter' })).toBeNull();
    expect(guestModes({ GUEST_CHAT_MODES: 'none' })).toEqual({ byok: false, puter: false });
    expect(guestModes({})).toEqual({ byok: true, puter: true });
    expect(guestModes({ GUEST_CHAT_MODES: ' BYOK , puter ' })).toEqual({ byok: true, puter: true });
  });

  it('reads a blank GUEST_CHAT_MODES as unset: only none turns the guests off', async () => {
    // Docker's env_file hands `GUEST_CHAT_MODES=` over as an empty string.
    for (const blank of ['', '  ', ',', ' , ,']) {
      expect(guestModes({ GUEST_CHAT_MODES: blank }), JSON.stringify(blank)).toEqual({ byok: true, puter: true });
    }
    const key = (await byokEncryptionKey(ENV))!;
    const sub = newByokSubject();
    const byok = await sealByok({ sub, key: GEMINI_KEY, model: DEFAULT_BYOK_MODEL }, key);
    expect(await resolvePrincipal(reader({ [BYOK_COOKIE]: byok }), { ...ENV, GUEST_CHAT_MODES: '' })).toMatchObject({
      kind: 'byok',
      profile: sub,
    });
    // A value that names no known mode is not blank: it is read as written, and both are off.
    expect(guestModes({ GUEST_CHAT_MODES: 'gemini' })).toEqual({ byok: false, puter: false });
    expect(parseGuestModes('byok, Gemini, none')).toEqual({ byok: true, puter: false, none: true, unknown: ['gemini'] });
  });

  it('signs nobody in when the session secret is unusable', async () => {
    const session = await createSessionToken({ profile: 'Ragnar' }, 'short');
    expect(await resolvePrincipal(reader({ [SESSION_COOKIE]: session }), { SESSION_SECRET: 'short' })).toBeNull();
  });
});
