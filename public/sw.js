/*
 * Service worker for offline reading.
 *
 * Three strategies, because the three kinds of request fail differently:
 *
 *   - the title index is a single large payload that changes only on re-index:
 *     serve it from cache immediately and refresh it in the background;
 *   - article pages should open offline once visited, and be current when the
 *     network is there: same strategy, separate cache so a re-index can clear
 *     articles without dropping the index;
 *   - the chat cannot work offline at all. A cached answer to a different
 *     question would be worse than an honest failure, so it is never stored.
 *
 * Deliberately hand-written rather than generated: it is sixty lines, and a
 * build-time plugin would hide exactly the decisions above.
 */

const VERSION = 'v1';
const SHELL_CACHE = `wv-shell-${VERSION}`;
const PAGE_CACHE = `wv-pages-${VERSION}`;
const IMAGE_CACHE = `wv-images-${VERSION}`;

/** Kept small on purpose: a phone should not lose storage to a wiki. */
const MAX_PAGES = 120;
const MAX_IMAGES = 300;

const SHELL_ASSETS = ['/wiki', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually, so one 404 cannot fail the whole install.
      await Promise.all(SHELL_ASSETS.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, PAGE_CACHE, IMAGE_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Third-party item icons: cache-first, they never change at a given URL.
  if (url.hostname.endsWith('wikia.nocookie.net')) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE, MAX_IMAGES));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Never cache: an answer, a login, or a mutation.
  if (
    url.pathname.startsWith('/api/chat') ||
    url.pathname.startsWith('/api/auth') ||
    url.pathname.startsWith('/api/conversations') ||
    url.pathname.startsWith('/api/ingest')
  ) {
    return;
  }

  if (url.pathname === '/api/wiki/index') {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }

  // Article and browse pages, and the assets they need.
  if (
    url.pathname.startsWith('/wiki') ||
    url.pathname.startsWith('/_next/static') ||
    url.pathname === '/icon.svg' ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(staleWhileRevalidate(request, PAGE_CACHE, MAX_PAGES));
  }
});

/**
 * Serves the cached copy at once and refreshes it in the background, so a
 * visited article opens instantly and offline while still being current on the
 * next visit.
 */
async function staleWhileRevalidate(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then(async (response) => {
      // A redirect to /login means the session expired; caching it would pin
      // every article to the login page until the cache was cleared.
      if (response.ok && response.type === 'basic') {
        await cache.put(request, response.clone());
        if (limit) await trim(cache, limit);
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;

  const response = await network;
  if (response) return response;

  return new Response('Offline and not cached.', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      if (limit) await trim(cache, limit);
    }
    return response;
  } catch {
    return new Response('', { status: 504 });
  }
}

/** Drops the oldest entries once a cache passes its limit. */
async function trim(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)));
}
