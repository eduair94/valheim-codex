import 'server-only';

import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken, type SessionPayload } from './session';

/**
 * Reads and verifies the session from the request cookies.
 *
 * Every page and route handler calls this for itself. The middleware also
 * checks the cookie, but only to redirect: middleware is a routing concern and
 * has been bypassable in the past (CVE-2025-29927), so it is never the only
 * thing standing between a request and the data.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const secret = process.env.SESSION_SECRET;
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
