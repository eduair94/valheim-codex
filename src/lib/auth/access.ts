/**
 * What the internet may reach without signing in, and what each kind of
 * sign-in opens.
 *
 * The reader is public and the chat is not. The reader shows an index built
 * from a public wiki, so there is nothing there to protect, and locking it
 * only made the site useless to the people it was built for. The chat is
 * different: every question costs someone a model call — the operator's for a
 * password holder, the reader's own for a Gemini key or Puter — and
 * conversations are private to the profile that wrote them.
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
 * must answer identically signed in or out. `robots.txt` and `sitemap.xml`
 * are read by crawlers, which never sign in: gated, they were answered with a
 * redirect to the login form. `/api/csp-report` is where browsers report what
 * the Content-Security-Policy blocked, for every reader, signed in or not.
 */
const PUBLIC_PREFIXES = [
  '/wiki',
  '/api/wiki',
  '/login',
  '/api/auth',
  '/api/health',
  '/api/csp-report',
  '/robots.txt',
  '/sitemap.xml',
] as const;

/**
 * The chat's own API, open to anyone signed in by any method. The chat page
 * itself is `AUTHENTICATED_HOME`.
 */
const CHAT_PREFIXES = ['/api/chat', '/api/conversations'] as const;

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
 * Who may reach a path.
 *
 * - `public`: anyone.
 * - `chat`: anyone signed in to the chat — the shared password, their own
 *   Gemini key or Puter. Each handler then decides what that principal may
 *   spend.
 * - `password`: only the shared-password holder. Everything not listed above
 *   lands here, so a route added later is closed until someone opens it on
 *   purpose. Today that is re-indexing (`/api/ingest`), which dispatches work
 *   on the operator's accounts.
 */
export type Access = 'public' | 'chat' | 'password';

export function requiredAccess(pathname: string): Access {
  if (isPublicPath(pathname)) return 'public';
  if (pathname === AUTHENTICATED_HOME || CHAT_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
    return 'chat';
  }
  return 'password';
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

/**
 * Query parameters that make a visit to the bare domain a request for the
 * chat rather than for the site.
 *
 * "Ask about this" links to `/?about=…`, and a stranger following it is sent
 * to sign in with the question kept. The chat keeps the open conversation in
 * the address as `/?c=<id>` (`CONVERSATION_PARAM`), so a reload or a bookmark
 * of a thread after the session ended goes to the sign-in and back into the
 * thread, rather than to the reader. Anything else on `/` — the `utm_*`,
 * `fbclid` or `gclid` that campaigns and social networks append to every
 * shared link — is still someone arriving at the site, and opens the reader
 * like the bare domain does. A parameter the chat page starts reading belongs
 * here too, or strangers following it land on the reader instead of the
 * sign-in.
 */
export const CHAT_QUERY_PARAMS = ['about', 'c'] as const;

/**
 * Whether a request for `/` carries one of {@link CHAT_QUERY_PARAMS}. Takes
 * `URLSearchParams` (the proxy) or a page's resolved `searchParams` object.
 */
export function hasChatIntent(params: URLSearchParams | Record<string, unknown>): boolean {
  return CHAT_QUERY_PARAMS.some((name) =>
    params instanceof URLSearchParams ? params.has(name) : params[name] !== undefined,
  );
}

/** The login URL for a gated path, preserving where the visitor was headed. */
export function loginHref(next?: string): string {
  if (!next || next === AUTHENTICATED_HOME) return '/login';
  return `/login?next=${encodeURIComponent(next)}`;
}

/** A base no request can come from, so anything that resolves elsewhere is foreign. */
const PROBE_ORIGIN = 'https://x.invalid';

/**
 * The `next` destination after signing in, or the chat when it is not a path
 * on this site.
 *
 * `startsWith('/')` alone was an open redirect: `//evil.example`, `/\evil`,
 * and `/<TAB>/evil` (the URL parser drops tabs and newlines) all leave the
 * site. Resolving against a fixed base and checking the origin catches those,
 * but is not enough either: the parser also collapses dot segments, so
 * `/.//evil.example` and `/%2e//evil.example` resolve on the base yet come out
 * as `//evil.example`, which a browser then reads as another host. So the
 * *output* is checked as well — whatever this returns is what gets followed.
 *
 * `unknown` because `searchParams` hands over an array when `next` is
 * repeated; that, like anything that is not a string, goes home.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return AUTHENTICATED_HOME;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return AUTHENTICATED_HOME;
  }
  if (url.origin !== PROBE_ORIGIN) return AUTHENTICATED_HOME;
  const out = url.pathname + url.search + url.hash;
  return out.startsWith('//') || out.startsWith('/\\') ? AUTHENTICATED_HOME : out;
}
