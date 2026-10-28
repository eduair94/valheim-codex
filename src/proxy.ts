import { NextResponse, type NextRequest } from 'next/server';
import { resolvePrincipal } from '@/lib/auth/principal';
import { contentSecurityPolicyHeaders, decideProxy } from '@/lib/auth/proxy-policy';

/**
 * Routes requests by who is asking: a 401 or 403 for the API, a redirect for a
 * browser, and straight through for everything public. Also refuses
 * cross-site writes to the API and stamps the Content-Security-Policy on
 * every page.
 *
 * Named `proxy` because Next.js 16 renamed the convention. This is a
 * convenience layer, not the security boundary — every gated page and route
 * handler verifies the principal itself. The middleware form of this hook
 * has been bypassable via a forged internal header (CVE-2025-29927), so
 * treating it as the only gate would put the chat one header away from
 * anyone's bill.
 *
 * The decisions live in `proxy-policy.ts`, where they are tested; this file
 * only translates them into responses.
 */

const CSP_HEADERS = contentSecurityPolicyHeaders();

export async function proxy(request: NextRequest) {
  const { pathname, search, searchParams } = request.nextUrl;
  const decision = await decideProxy({
    method: request.method,
    pathname,
    search,
    searchParams,
    headers: request.headers,
    principal: () => resolvePrincipal((name) => request.cookies.get(name)?.value),
  });

  switch (decision.action) {
    case 'next': {
      const response = NextResponse.next();
      if (decision.page) for (const [name, value] of CSP_HEADERS) response.headers.set(name, value);
      return response;
    }
    case 'redirect':
      return NextResponse.redirect(new URL(decision.location, request.nextUrl), decision.permanent ? 308 : 307);
    case 'json':
      return NextResponse.json(decision.body, { status: decision.status, headers: { 'Cache-Control': 'no-store' } });
    case 'text':
      return new NextResponse(decision.body, {
        status: decision.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
  }
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
     * the login HTML as its own script. The icon files and `/opengraph-image`
     * are the same story for install icons and link-preview crawlers — a
     * crawler that gets a 302 to `/login` renders no preview at all.
     */
    '/((?!_next/static|_next/image|favicon.ico|favicon-32.png|icon.svg|icon-maskable.svg|icon-192.png|icon-512.png|icon-512-maskable.png|apple-touch-icon.png|manifest.webmanifest|opengraph-image|sw.js).*)',
  ],
};
