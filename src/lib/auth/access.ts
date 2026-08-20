/**
 * What the internet may reach without a password.
 *
 * The reader is public and the chat is not. The reader shows an index built
 * from a public wiki, so there is nothing there to protect, and locking it
 * only made the site useless to the people it was built for. The chat is
 * different: every question spends model tokens on the operator's account, and
 * conversations are private to the profile that wrote them. A password is a
 * blunt instrument, but it is the right one for "do not run up my bill".
 *
 * One list, read by the proxy and by the pages, so a path cannot end up public
 * in the routing layer while its handler still refuses — or, far worse, the
 * other way round.
 */

/**
 * Public path prefixes.
 *
 * `/api/auth` has to be reachable while logged out or logging in is
 * impossible. `/api/health` is the container probe and the offline check, and
 * must answer identically signed in or out.
 */
const PUBLIC_PREFIXES = ['/wiki', '/api/wiki', '/login', '/api/auth', '/api/health'] as const;

/**
 * Matches a prefix only at a path boundary.
 *
 * A plain `startsWith` would make `/wikileaks-of-my-tokens` public, and any
 * future route beginning with those eight characters along with it.
 */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** True when the path is served to anyone, with or without a session. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

/**
 * Where to send a visitor with no session.
 *
 * Anonymous visitors land on the reader rather than a password prompt: the
 * site is public, and greeting a first-time reader with a wall would hide the
 * part that was meant for them. Only a deliberate move toward the chat asks
 * for a password.
 */
export const PUBLIC_HOME = '/wiki';

/** Where the login form sends someone who has just authenticated. */
export const AUTHENTICATED_HOME = '/';

/** The login URL for a gated path, preserving where the visitor was headed. */
export function loginHref(next?: string): string {
  if (!next || next === AUTHENTICATED_HOME) return '/login';
  return `/login?next=${encodeURIComponent(next)}`;
}
