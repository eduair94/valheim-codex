export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness probe for the offline banner.
 *
 * Deliberately tiny, unauthenticated and never cached: the only question it
 * answers is "can this device reach the server right now". `navigator.onLine`
 * cannot answer it — it reports whether a network interface exists, so a phone
 * on wifi with no internet says it is online, and Chromium resets the flag
 * across a navigation even under emulated offline.
 */
export function GET(): Response {
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
