import { BROWSE_HREF } from '@/components/shell/nav-model';
import { ALL_CATEGORIES } from '@/lib/routes';
import { AUTHENTICATED_HOME, hasChatIntent, loginHref, PUBLIC_HOME, requiredAccess, safeNext } from './access';
import { isSafeMethod, isSameOriginRequest } from './origin';
import type { ChatPrincipal } from './principal';

/**
 * What the proxy does with a request, decided without touching Next's
 * request or response objects so every branch can be tested directly.
 *
 * The proxy is a convenience layer, not the security boundary: every gated
 * page and route handler checks the principal again, and every mutating
 * handler checks the origin again. What the proxy adds is answering early —
 * a 401 instead of a rendered page, a redirect instead of an error — and the
 * one place where a header has to go on every page.
 */

/** Largest request body the API accepts, declared or streamed (`proxyClientMaxBodySize`). */
export const MAX_API_BODY_BYTES = 64 * 1024;

/** Where browsers send their violation reports (`src/app/api/csp-report/route.ts`). */
export const CSP_REPORT_PATH = '/api/csp-report';

export type ProxyInput = {
  method: string;
  /** `request.nextUrl.pathname`, still percent-encoded. */
  pathname: string;
  /** `request.nextUrl.search`: `''` or `?…`, with Next's internal `_rsc` already removed. */
  search: string;
  searchParams: URLSearchParams;
  headers: Headers;
  /**
   * The chat principal, resolved only when a decision needs it: most requests
   * are public pages, and verifying cookies for them would be wasted work.
   */
  principal: () => Promise<ChatPrincipal | null>;
};

export type ProxyDecision =
  /** Continue to the route; `page` asks for the Content-Security-Policy. */
  | { action: 'next'; page: boolean }
  /** 307, or 308 when `permanent`: an address that has moved for good. */
  | { action: 'redirect'; location: string; permanent?: true }
  | { action: 'json'; status: number; body: { error: string } }
  | { action: 'text'; status: number; body: string };

/** The query parameters that narrow `/wiki/c/all`; `view` and `tab` only change how a set is shown. */
const FACET_PARAMS = ['biome', 'station', 'type'] as const;

/** `/wiki/c/<segment>`, the segment still percent-encoded. */
const CATEGORY_PATH = /^\/wiki\/c\/([^/]+)$/;

/**
 * Where a wiki address goes for good, or null to serve it.
 *
 * `/wiki/c/all` with no facet (`?biome=`, `?station=`, `?type=`) is every
 * article, unfiltered, which is the browse page. Here it is a 308 before
 * anything renders: no category lookup, no layout, no page. The page says
 * the same with its own `permanentRedirect`, for whatever reaches it another
 * way. That is a real 308 too while the route has no loading boundary; with
 * one, the response would already have said 200, and the page's redirect
 * would arrive as a client redirect and a meta refresh, which crawlers and
 * the service worker keep as a page.
 *
 * Read the way the page reads its query (`parseCategoryQuery`): a facet
 * counts when its first value has something besides spaces; `view` and `tab`
 * are dropped, since the browse page has neither; and the segment is decoded
 * once, as `categoryFromParam` decodes it.
 */
export function permanentWikiRedirect(pathname: string, searchParams: URLSearchParams): string | null {
  const segment = CATEGORY_PATH.exec(pathname)?.[1];
  if (segment === undefined) return null;
  let category: string;
  try {
    category = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (category !== ALL_CATEGORIES) return null;
  const narrowed = FACET_PARAMS.some((name) => (searchParams.get(name) ?? '').trim() !== '');
  return narrowed ? null : BROWSE_HREF;
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * `true` when the path's percent-encoding is broken (`/wiki/a/%E0%A4%A`).
 * Left alone, `next start` answered those with a bare 500 — behind Cloudflare,
 * a 520 — once a route tried to decode its parameters.
 */
function isMalformedPath(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return false;
  } catch {
    return true;
  }
}

/**
 * {@link safeNext}, settled: a value it would return unchanged if asked
 * again. The `/login` redirect below re-checks the URL it sends the visitor
 * to, and that check must pass, or the two would bounce off each other.
 */
function settledNext(raw: unknown): string {
  const once = safeNext(raw);
  return safeNext(once) === once ? once : AUTHENTICATED_HOME;
}

/**
 * A violation report from Safari before 16.4, which the origin check would
 * refuse although the page that raised it is this site's.
 *
 * WebKit files every CSP report with `Origin: null` (an empty origin written
 * as the opaque one), whatever the Referrer-Policy. Current Safari also sends
 * `Sec-Fetch-Site: same-origin`, which vouches for it; before 16.4 there was
 * no such header, and those readers' reports were refused with a 403 before
 * the handler ran — missing from the `[csp]` log the operator reads before
 * turning `CSP_ENFORCE` on, so a violation only those browsers hit would
 * surface only as a broken page once enforced.
 *
 * Only that shape, only on that one path: the handler changes nothing,
 * stores nothing and checks its own type and size, so this admits nothing
 * that a request with no `Origin` at all — curl — does not already reach. An
 * explicit `Sec-Fetch-Site: cross-site` is still refused, so another site
 * cannot point its own `report-uri` here and fill the log with reports that
 * look like this site's (the log keeps no host).
 */
function isLegacyWebKitReport(pathname: string, headers: Headers): boolean {
  return pathname === CSP_REPORT_PATH && !headers.has('sec-fetch-site') && headers.get('origin') === 'null';
}

/** The same `/login` URL with `next` replaced and every other parameter (`switch`) kept. */
function loginWithNext(searchParams: URLSearchParams, next: string): string {
  const params = new URLSearchParams(searchParams);
  params.delete('next');
  if (next !== AUTHENTICATED_HOME) params.set('next', next);
  const query = params.toString();
  return query ? `/login?${query}` : '/login';
}

export async function decideProxy(input: ProxyInput): Promise<ProxyDecision> {
  const { method, pathname, search, searchParams, headers } = input;
  const api = isApiPath(pathname);

  if (isMalformedPath(pathname)) {
    return api
      ? { action: 'json', status: 400, body: { error: 'bad_request' } }
      : { action: 'text', status: 400, body: 'Bad Request' };
  }

  /*
   * Cross-site request forgery, for every state-changing API call, signed in
   * or not: logout and the sign-ins need no cookie to be abused (signing a
   * victim into an account the attacker chose is the attack). The handlers
   * check again; this answers before any body is read. The one exception is
   * old Safari's violation reports ({@link isLegacyWebKitReport}).
   *
   * The declared size is refused here too. Next buffers up to
   * `proxyClientMaxBodySize` and silently truncates the rest, so without this
   * an oversized body would reach a handler as broken JSON instead of a 413.
   */
  if (api && !isSafeMethod(method)) {
    if (!isSameOriginRequest(headers) && !isLegacyWebKitReport(pathname, headers)) {
      return { action: 'json', status: 403, body: { error: 'forbidden_origin' } };
    }
    const declared = Number(headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_API_BODY_BYTES) {
      return { action: 'json', status: 413, body: { error: 'payload_too_large' } };
    }
  }

  /*
   * Someone already signed in has no use for the connect page — unless they
   * came to change how they are signed in (`?switch`). They go where `next`
   * pointed, as long as that is a path on this site.
   *
   * Everyone else gets the page, and the page follows `next` once they have
   * signed in. A `next` that is not a path on this site (`//evil.example`),
   * or that is repeated, is replaced here, before any page code sees it:
   * closing the open redirect in one place rather than trusting every form
   * that reads the parameter to check it again.
   */
  if (pathname === '/login') {
    const next = searchParams.getAll('next');
    const requested = next.length > 1 ? next : next[0];
    if (!searchParams.has('switch') && (await input.principal())) {
      return { action: 'redirect', location: safeNext(requested) };
    }
    if (next.length > 0) {
      const safe = settledNext(requested);
      if (next.length > 1 || safe !== next[0]) {
        return { action: 'redirect', location: loginWithNext(searchParams, safe) };
      }
    }
    return { action: 'next', page: true };
  }

  // A page that has moved for good; reads and HEADs only, nothing that posts to a page.
  if (!api && (method === 'GET' || method === 'HEAD')) {
    const moved = permanentWikiRedirect(pathname, searchParams);
    if (moved) return { action: 'redirect', location: moved, permanent: true };
  }

  const access = requiredAccess(pathname);
  if (access === 'public') return { action: 'next', page: !api };

  const principal = await input.principal();

  if (api) {
    /*
     * API requests get status codes, not redirects: a `fetch` that follows a
     * redirect receives the login page with status 200, so the caller sees
     * "success" and then fails parsing HTML as JSON.
     */
    if (!principal) return { action: 'json', status: 401, body: { error: 'unauthorized' } };
    if (access === 'password' && principal.kind !== 'password') {
      return { action: 'json', status: 403, body: { error: 'forbidden' } };
    }
    return { action: 'next', page: false };
  }

  // Pages: any principal may continue; a page that needs more checks it itself.
  if (principal) return { action: 'next', page: true };

  /*
   * The bare domain is the one gated page a stranger reaches by accident
   * rather than by choice, so it opens the public reader instead of demanding
   * a password — tracking parameters on a shared link included. With one of
   * the chat's own parameters it was a deliberate move toward the chat — "Ask
   * about this" links to `/?about=…` — so it goes to the sign-in like every
   * other gated path, with the whole destination preserved for afterwards.
   */
  if (pathname === AUTHENTICATED_HOME && !hasChatIntent(searchParams)) {
    return { action: 'redirect', location: PUBLIC_HOME };
  }
  return { action: 'redirect', location: loginHref(pathname + search) };
}

/**
 * The Content-Security-Policy for pages.
 *
 * Without nonces: a nonce would force every route to render per request and
 * cannot cover the analytics beacon Cloudflare injects at the edge, so inline
 * scripts are allowed. The rest is strict, and that is where the protection
 * is — an injected script still cannot send anything anywhere but this
 * origin, Puter's API and Cloudflare's analytics, cannot load script from
 * elsewhere, cannot frame or be framed, and cannot repoint relative URLs
 * (`base-uri`) or form posts.
 *
 * Images: Fandom's CDN, plus `services.fandom.com`, which serves the
 * rendered math formulas some articles carry (knockback, damage). Without it
 * those articles showed empty boxes.
 *
 * `'unsafe-eval'` only in development, where React rebuilds server error
 * stacks with `eval`; `ws:` only in development, for hot reload.
 *
 * Not set on `/sw.js` (the proxy never sees it): a worker's own policy governs
 * its `fetch()`es, and `connect-src` there would block every Fandom image it
 * caches.
 *
 * Every violation is reported to {@link CSP_REPORT_PATH}, which logs a
 * summary: what a reader's browser refused is otherwise visible only in that
 * reader's console.
 */
export function contentSecurityPolicy(development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://static.wikia.nocookie.net https://services.fandom.com",
    "font-src 'self' data:",
    `connect-src 'self' https://api.puter.com https://puter.com wss://api.puter.com https://cloudflareinsights.com${development ? ' ws:' : ''}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
  ].join('; ');
}

/**
 * The directives no page of this site can trip, whatever runs on it: nothing
 * may frame it, and it writes no `<base>`, embeds no plugin and posts forms
 * only to itself. Enforced even while the full policy is report-only, so
 * framing, base-tag hijacking and form exfiltration are shut from the first
 * deploy.
 */
export const BASELINE_CONTENT_SECURITY_POLICY = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  `report-uri ${CSP_REPORT_PATH}`,
].join('; ');

export type ContentSecurityPolicyMode = 'enforce' | 'report-only';

/**
 * Whether the full policy is enforced.
 *
 * Production starts report-only, as the audit asked: the dev server, where
 * the policy was checked page by page, never shows what Cloudflare adds at
 * the edge, and a production build was never run against it. Violations are
 * reported and logged meanwhile; `CSP_ENFORCE=1` switches enforcement on once
 * the log shows none that were not expected. Development always enforces, so
 * new code meets the policy before it ships rather than after.
 */
export function contentSecurityPolicyMode(env: Record<string, string | undefined> = process.env): ContentSecurityPolicyMode {
  if (env.NODE_ENV === 'development') return 'enforce';
  const enforce = env.CSP_ENFORCE?.trim();
  return enforce === '1' || enforce === 'true' ? 'enforce' : 'report-only';
}

/** The policy headers for a page, as `[name, value]` pairs. */
export function contentSecurityPolicyHeaders(env: Record<string, string | undefined> = process.env): [string, string][] {
  const policy = contentSecurityPolicy(env.NODE_ENV === 'development');
  return contentSecurityPolicyMode(env) === 'enforce'
    ? [['Content-Security-Policy', policy]]
    : [
        ['Content-Security-Policy', BASELINE_CONTENT_SECURITY_POLICY],
        ['Content-Security-Policy-Report-Only', policy],
      ];
}
