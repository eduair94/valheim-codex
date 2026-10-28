import { EncryptJWT, jwtDecrypt } from 'jose';
import { authCookieName } from './session';

/**
 * A reader's own Gemini API key, carried in an encrypted cookie.
 *
 * The key is a credential to someone's Google Cloud project, often a billed
 * one, so where it lives decides what an attacker gets:
 *
 * - localStorage or a request header: any script on the page can read it —
 *   an XSS, a browser extension, a compromised dependency — and walk off with
 *   a long-lived key.
 * - The browser calling Gemini directly: same exposure, and the retrieval
 *   endpoint would have to be opened to anyone.
 * - **An httpOnly cookie encrypted with a server-side key** (this): page
 *   scripts cannot read it, it travels only to this server, and the server
 *   stores nothing — forgetting the key is deleting the cookie.
 *
 * AES-256-GCM via JWE `dir`, so the cookie is unreadable and any tampering
 * fails authentication. The plaintext key never leaves the server: the
 * client only ever sees a four-character hint.
 */

export const BYOK_COOKIE = authCookieName('wv_byok');
/** 30 days, in seconds — the same as a password session. */
export const BYOK_MAX_AGE = 60 * 60 * 24 * 30;

const ISSUER = 'wiki-valheim';
const AUDIENCE = 'wiki-valheim-byok';
const KEY_ID = 'v1';

/**
 * Models a reader may run on their own key.
 *
 * Flash-Lite only: an answer is grounded on retrieved excerpts, so a larger
 * model buys little, and the thinking-by-default Flash models took tens of
 * seconds per answer in testing. `gemini-2.5-flash-lite` stays listed for keys
 * that already have access to it; Google no longer grants 2.5 to new projects.
 */
export const BYOK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
] as const;
export type ByokModel = (typeof BYOK_MODELS)[number];
export const DEFAULT_BYOK_MODEL: ByokModel = 'gemini-3.5-flash-lite';

export function isByokModel(value: unknown): value is ByokModel {
  return typeof value === 'string' && (BYOK_MODELS as readonly string[]).includes(value);
}

export type ByokSession = {
  /**
   * `byok:<uuid>`, minted the first time a key signs in in a browser; owns
   * the conversation history. Kept when the key is replaced, and found again
   * when the same key comes back to the same browser (`byok-owner.ts`).
   */
  sub: string;
  /** The reader's Gemini API key. Server-side only. */
  key: string;
  model: ByokModel;
};

/**
 * Plausibility bounds for a pasted key.
 *
 * Deliberately not a prefix check: Google's key formats have changed (AI
 * Studio's service-account "auth keys" since 2026-05), so the only real test
 * is asking Google, which the registration route does.
 */
export function isPlausibleApiKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{20,256}$/.test(value);
}

const SUBJECT = /^byok:[0-9a-f-]{36}$/;

export function newByokSubject(): string {
  return `byok:${crypto.randomUUID()}`;
}

export function isByokSubject(value: unknown): value is string {
  return typeof value === 'string' && SUBJECT.test(value);
}

/** "…wxyz" — enough for a reader to recognise their key, useless to anyone else. */
export function keyHint(key: string): string {
  return `…${key.slice(-4)}`;
}

export async function sealByok(
  session: ByokSession,
  encryptionKey: Uint8Array,
  maxAgeSeconds: number = BYOK_MAX_AGE,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new EncryptJWT({ k: session.key, m: session.model })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: KEY_ID })
    .setSubject(session.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + maxAgeSeconds)
    .encrypt(encryptionKey);
}

/**
 * Opens a BYOK cookie, returning null for anything not currently valid:
 * expired, tampered with, encrypted under another key, or carrying claims of
 * the wrong shape.
 */
export async function openByok(
  token: string | undefined,
  encryptionKey: Uint8Array,
): Promise<ByokSession | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, encryptionKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    const key = payload['k'];
    if (!isPlausibleApiKey(key) || !isByokSubject(payload.sub)) return null;
    const model = payload['m'];
    return { sub: payload.sub, key, model: isByokModel(model) ? model : DEFAULT_BYOK_MODEL };
  } catch {
    return null;
  }
}
