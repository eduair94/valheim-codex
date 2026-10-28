/**
 * Cross-site request forgery check for state-changing requests.
 *
 * The cookies are `SameSite=Lax`, which keeps them off cross-site POSTs — but
 * not off requests from a *same-site* sibling (any other *.digitalshopuy.com
 * host), and not off endpoints that need no cookie at all, like logout or the
 * sign-ins themselves (login CSRF: signing a victim into an account the
 * attacker chose, so their next questions — or their pasted Gemini key — land
 * where the attacker can read them). Next.js checks the origin for Server
 * Actions only; route handlers get nothing, so this does it for them.
 *
 * The rule, in order:
 * 1. `Sec-Fetch-Site`, which every current browser sends and a page cannot
 *    forge: only `same-origin` (or `none`, a user-typed navigation) passes.
 * 2. Otherwise `Origin`, for older browsers: its host must be the host the
 *    request was sent to. A literal `null` origin (sandboxed frames, some
 *    redirects) is foreign. The proxy lets one such request past this rule:
 *    Safari before 16.4 files its CSP reports with `Origin: null` and no
 *    `Sec-Fetch-Site` (`isLegacyWebKitReport` in `proxy-policy.ts`).
 * 3. Neither header: not a browser — curl, a test runner, a health check. A
 *    browser always sends `Origin` on a POST, so such a request cannot be a
 *    forged one riding a victim's cookies.
 */
export function isSameOriginRequest(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';

  const origin = headers.get('origin');
  if (origin === null) return true;
  if (origin === 'null') return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = (headers.get('x-forwarded-host') ?? headers.get('host') ?? '').split(',')[0]?.trim();
  return Boolean(host) && originHost === host;
}

/** Methods that never change state and need no origin check. */
export function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

export function forbiddenOriginResponse(): Response {
  return Response.json({ error: 'forbidden_origin' }, { status: 403 });
}
