import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';
import { AUTHENTICATED_HOME, isPublicPath, PUBLIC_HOME } from '@/lib/auth/access';

/**
 * Routes requests by whether they need a session: a 401 for the API, a
 * redirect for a browser, and straight through for everything public.
 *
 * Named `proxy` because Next.js 16 renamed the convention; the behaviour is
 * unchanged. This is a convenience layer, not the security boundary — every
 * gated page and route handler verifies the session itself. The middleware
 * form of this hook has been bypassable via a forged internal header
 * (CVE-2025-29927), so treating it as the only gate would put the chat one
 * header away from anyone's bill.
 */
export async function proxy(request: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = secret ? await verifySessionToken(token, secret) : null;

  const { pathname, search } = request.nextUrl;

  // Someone already signed in has no use for the login form.
  if (session && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = AUTHENTICATED_HOME;
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (isPublicPath(pathname)) return NextResponse.next();
  if (session) return NextResponse.next();

  /*
   * API requests get a 401, not a redirect to an HTML page.
   * A `fetch` that follows a redirect receives the login page with status 200,
   * so the caller sees "success" and then fails parsing HTML as JSON. Status
   * codes are the only signal an API client has.
   */
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  /*
   * The bare domain is the one gated page a stranger reaches by accident
   * rather than by choice, so it opens the public reader instead of demanding
   * a password. Every other gated path was asked for deliberately and gets the
   * login form, with its destination preserved.
   */
  const url = request.nextUrl.clone();
  if (pathname === AUTHENTICATED_HOME) {
    url.pathname = PUBLIC_HOME;
    url.search = '';
  } else {
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
  }
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and static assets. The public paths
     * themselves are decided in `access.ts` rather than here, so that the list
     * the proxy trusts is the same one the handlers trust.
     *
     * `sw.js` and the manifest are excluded because a browser fetches them
     * outside any page context: redirecting either would silently break
     * installation and offline reading, with the service worker registering
     * the login HTML as its own script.
     */
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|icon-maskable.svg|manifest.webmanifest|sw.js).*)',
  ],
};
