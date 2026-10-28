import { jwtVerify, SignJWT } from 'jose';
import { authCookieName } from './session';

/**
 * Sign-in through Puter (puter.com), where each reader pays for their own
 * model use from their Puter account.
 *
 * The model runs in the reader's browser, on their Puter token. This server
 * never stores that token: the browser presents it once, the server asks
 * Puter who it belongs to (`verifyPuterToken`), and from then on the reader
 * holds this app's own short-lived cookie. It identifies them for retrieval,
 * quotas and their saved conversations — nothing the operator pays a model
 * for is reachable with it.
 */

export const PUTER_COOKIE = authCookieName('wv_puter');
/** One day. The browser re-exchanges its Puter token silently when it lapses. */
export const PUTER_MAX_AGE = 60 * 60 * 24;

const ISSUER = 'wiki-valheim';
const AUDIENCE = 'wiki-valheim-puter';

export type PuterSession = {
  /** `puter:<puter user uuid>`; owns the conversation history across devices. */
  sub: string;
  /** Puter username, for display only. */
  name: string;
};

const SUBJECT = /^puter:[0-9a-f-]{36}$/i;

export function isPuterSubject(value: unknown): value is string {
  return typeof value === 'string' && SUBJECT.test(value);
}

export async function createPuterSessionToken(
  session: PuterSession,
  key: Uint8Array,
  maxAgeSeconds: number = PUTER_MAX_AGE,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ name: session.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(session.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + maxAgeSeconds)
    .sign(key);
}

export async function verifyPuterSessionToken(
  token: string | undefined,
  key: Uint8Array,
): Promise<PuterSession | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (!isPuterSubject(payload.sub)) return null;
    const name = typeof payload['name'] === 'string' ? payload['name'] : '';
    return { sub: payload.sub, name };
  } catch {
    return null;
  }
}
