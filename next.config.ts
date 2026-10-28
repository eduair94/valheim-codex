import type { NextConfig } from 'next';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Headers for every response.
 *
 * - `nosniff`: a response is only ever what its Content-Type says.
 * - `Referrer-Policy: no-referrer`: Fandom answers any image request whose
 *   Referer names another site with a "not available" placeholder, and no
 *   page here needs to tell another site where a reader came from. Puter's
 *   sign-in popup does not need it either: with no referrer it asks the
 *   opening page for its origin, which the browser attests.
 * - Framing refused (`X-Frame-Options` here, `frame-ancestors` in the CSP):
 *   nothing embeds this site, and a framed chat is how clickjacking starts.
 * - `Cross-Origin-Opener-Policy: same-origin-allow-popups`, never
 *   `same-origin`: the Puter sign-in is a popup that hands its token back to
 *   this window, and `same-origin` severs that link.
 * - HSTS in production only — on http://localhost it would be meaningless at
 *   best. Cloudflare may also set it at the edge; the two agree.
 *
 * The Content-Security-Policy is not here. The proxy sets it on pages only:
 * as a rule for every path it would also land on `/sw.js`, and a worker's own
 * `connect-src 'self'` would block every Fandom image it caches.
 */
const SECURITY_HEADERS = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  ...(isProduction ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
];

/**
 * Responses about who someone is, or their conversations: never stored by a
 * browser or a shared cache. Matters most once a CDN rule makes the public
 * API cacheable — a rule broad enough to catch these would otherwise serve
 * one reader's session or history to the next.
 */
const PRIVATE = [{ key: 'Cache-Control', value: 'private, no-store' }];

const nextConfig: NextConfig = {
  // PGlite ships a WASM build that must not be bundled.
  serverExternalPackages: [
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
    '@huggingface/transformers',
  ],
  typedRoutes: true,
  poweredByHeader: false,
  /*
   * Nothing here uses `next/image` — Fandom pictures are plain `<img>` tags —
   * so the optimizer endpoint only ever exposed sharp to the internet. With
   * this, `/_next/image` answers 404.
   */
  images: { unoptimized: true },
  experimental: {
    /*
     * Next buffers each request body for the proxy and silently truncates
     * past this size instead of refusing. No API here takes more than a few
     * kilobytes; at 64 KB an oversized body arrives as broken JSON (400)
     * rather than costing ten megabytes of memory first, and the proxy
     * refuses a declared length over it outright.
     */
    proxyClientMaxBodySize: '64kb',
  },
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      {
        // Everything but the dev server's in-memory manifests, which Turbopack
        // serves as `application/json` although the page loads them as
        // scripts. That path does not exist in a production build.
        source: '/((?!_next/static/development/).*)',
        headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
      },
      {
        // The service worker must be revalidated on every check, or a fixed
        // worker can sit behind a cached broken one.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      { source: '/api/auth/:path*', headers: PRIVATE },
      { source: '/api/chat/:path*', headers: PRIVATE },
      { source: '/api/conversations/:path*', headers: PRIVATE },
      { source: '/api/ingest', headers: PRIVATE },
    ];
  },
};

export default nextConfig;
