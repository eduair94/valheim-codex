import { base64url, EncryptJWT, jwtDecrypt } from 'jose';
import { isByokSubject } from './byok';
import { authCookieName } from './session';

/**
 * Which conversation history belongs to which Gemini key, in this browser.
 *
 * A Gemini-key reader's history is owned by a random `byok:<uuid>` that lives
 * only in their key's cookie (`byok.ts`): the server keeps nothing about
 * them. That cookie goes on sign-out, on "Forget key", on switching to the
 * password or to Puter, and after 30 days — and every way back to the history
 * went with it. The same reader typing the same key into the same browser got
 * an empty chat, and their conversations stayed in the database where nobody
 * could open or delete them any more.
 *
 * This cookie outlives the key's. For each key recently used in this browser
 * it remembers the owner that key signed in as — never the key itself, only a
 * tag nobody can compute without this server's key ({@link byokKeyTag}). So:
 *
 * - the same key, back in the same browser, finds its history again;
 * - another key — the next person at a shared computer — starts its own, and
 *   cannot reach the previous reader's;
 * - another browser always starts fresh, so friends who share one key never
 *   share a history. That is why the owner is not derived from the key (the
 *   audit's call), and a Gemini-key history still belongs to the browser.
 *
 * It authorises nothing by itself, so it is not one of the auth cookies, and
 * signing out leaves it, like the known-browser cookie (`login-device.ts`).
 * It is encrypted under the same key as the key's cookie, with an audience of
 * its own, so rotating BYOK_SECRET — or SESSION_SECRET while BYOK_SECRET is
 * unset — retires both together.
 */

export const BYOK_OWNER_COOKIE = authCookieName('wv_byok_owner');
/** 180 days, in seconds; renewed whenever the key's own cookie is sealed. */
export const BYOK_OWNER_MAX_AGE = 60 * 60 * 24 * 180;

/**
 * Keys one browser remembers, latest first: the few people who share a
 * computer, each with a key of their own. More would only grow a cookie that
 * goes out with every request.
 */
const MAX_OWNERS = 4;

const ISSUER = 'wiki-valheim';
/** Its own audience, so the key's cookie can never pass for this one, nor the reverse. */
const AUDIENCE = 'wiki-valheim-byok-owner';
const KEY_ID = 'v1';
const TAG_SHAPE = /^[A-Za-z0-9_-]{22}$/;

export type ByokOwner = {
  /** The history owner, `byok:<uuid>`. */
  sub: string;
  /** {@link byokKeyTag} of the key it signs in with. */
  tag: string;
};

const encoder = new TextEncoder();

/**
 * A tag for a reader's key: the same key always gives the same tag, and the
 * tag gives nothing away about the key. HMAC-SHA-256 under a sub-key of the
 * cookie key (HKDF with its own `info`, so the two keys never mix), cut to
 * 128 bits — plenty for an equality check under a secret, inside a cookie
 * that is encrypted anyway.
 */
export async function byokKeyTag(apiKey: string, encryptionKey: Uint8Array): Promise<string> {
  const base = await crypto.subtle.importKey('raw', new Uint8Array(encryptionKey), 'HKDF', false, ['deriveKey']);
  const hmac = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('wiki-valheim'), info: encoder.encode('byok-key-tag-v1') },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, encoder.encode(apiKey)));
  return base64url.encode(mac.slice(0, 16));
}

/**
 * `owners` with `owner` in front, minus any older entry for the same history
 * (its key was replaced) or the same key (it now opens this history).
 */
export function rememberByokOwner(owners: readonly ByokOwner[], owner: ByokOwner): ByokOwner[] {
  return [owner, ...owners.filter((o) => o.sub !== owner.sub && o.tag !== owner.tag)].slice(0, MAX_OWNERS);
}

export async function sealByokOwners(
  owners: readonly ByokOwner[],
  encryptionKey: Uint8Array,
  maxAgeSeconds: number = BYOK_OWNER_MAX_AGE,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new EncryptJWT({ o: owners.slice(0, MAX_OWNERS).map(({ sub, tag }) => [sub, tag]) })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: KEY_ID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + maxAgeSeconds)
    .encrypt(encryptionKey);
}

/**
 * The owners a cookie remembers, or none for anything not currently valid:
 * expired, tampered with, encrypted under another key, or not this kind of
 * cookie. Entries of the wrong shape are dropped one by one.
 */
export async function openByokOwners(token: string | undefined, encryptionKey: Uint8Array): Promise<ByokOwner[]> {
  if (!token) return [];
  try {
    const { payload } = await jwtDecrypt(token, encryptionKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    const entries = payload['o'];
    if (!Array.isArray(entries)) return [];
    return entries
      .flatMap((entry: unknown): ByokOwner[] => {
        if (!Array.isArray(entry)) return [];
        const [sub, tag] = entry as unknown[];
        return isByokSubject(sub) && typeof tag === 'string' && TAG_SHAPE.test(tag) ? [{ sub, tag }] : [];
      })
      .slice(0, MAX_OWNERS);
  } catch {
    return [];
  }
}

/**
 * `Strict`, like the known-browser cookie: only the Gemini-key routes read
 * it, called from this site. The rest as for the auth cookies (`__Host-` in
 * production, so Secure, `Path=/`, no Domain — no sibling subdomain can plant
 * one that hides the real record).
 */
export function byokOwnerCookieOptions(isProduction: boolean, maxAge: number = BYOK_OWNER_MAX_AGE) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict' as const,
    path: '/',
    maxAge,
  };
}
