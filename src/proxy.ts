import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';

/**
 * Routes unauthenticated requests: a 401 for the API, the login page for a
 * browser.
 *
 * Named `proxy` because Next.js 16 renamed the convention; the behaviour is
 * unchanged. This is a convenience layer, not the security boundary — every
 * page and route handler verifies the session itself. The middleware form of
 * this hook has been bypassable via a forged internal header
 * (CVE-2025-29927), so treating it as the only gate would put the whole app
 * one header away from public.
 */
export async function proxy(request: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = secret ? await verifySessionToken(token, secret) : null;

  const { pathname, search } = request.nextUrl;
  const isLogin = pathname === '/login';

  /*
   * API requests get a 401, not a redirect to an HTML page.
   * A `fetch` that follows a redirect receives the login page with status 200,
   * so the caller sees "success" and then fails parsing HTML as JSON. Status
   * codes are the only signal an API client has.
   */
  if (!session && pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!session && !isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (session && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals, static assets and the auth endpoints.
     *
     * `/api/auth/*` must stay reachable while logged out or login is
     * impossible. `sw.js` and the manifest must too: a browser fetches them
     * outside any page context, and redirecting either to the login page
     * silently breaks installation and offline reading — the service worker
     * would register the login HTML as its own script. `api/health` is the
     * offline probe and must answer the same way signed in or out.
     */
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|icon-maskable.svg|manifest.webmanifest|sw.js|api/health|api/auth).*)',
  ],
};
