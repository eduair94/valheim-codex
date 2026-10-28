import 'server-only';

import { cookies } from 'next/headers';
import { sessionSecret } from './secrets';
import { SESSION_COOKIE, verifySessionToken, type SessionPayload } from './session';

/**
 * Reads and verifies the password session from the request cookies.
 *
 * Password holders only — the one kind of sign-in allowed to spend the
 * operator's model budget. Code that serves any signed-in reader (own Gemini
 * key, Puter) uses `getChatPrincipal()` instead.
 *
 * Every page and route handler calls this for itself. The proxy also checks
 * the cookies, but only to route: it is a routing concern and its middleware
 * form has been bypassable in the past (CVE-2025-29927), so it is never the
 * only thing standing between a request and the data.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const secret = sessionSecret();
  if (!secret) return null;
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value, secret);
}

/** Session or a 401-shaped failure, for route handlers. */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

/** Maps a thrown UnauthorizedError onto a JSON 401. */
export function unauthorizedResponse(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
