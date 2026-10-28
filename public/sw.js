/*
 * Service worker for offline reading.
 *
 * What a reader needs offline is the pages they already read, with their
 * images, and a search that still finds them. What they must never get while
 * online is an old copy: these pages depend on the language cookie and the
 * sign-in cookies, and a cache key can carry neither (a worker never even sees
 * the Cookie header). So, online, the network answers; the cache is for when it
 * cannot.
 *
 *   - Page loads (navigations): network first. A copy of each reader page is
 *     kept and answers only when the network fails, returns a 5xx (the CDN's
 *     error page while the origin is down), or is still silent after
 *     NAVIGATION_TIMEOUT_MS while a copy exists, and in that last case only a
 *     copy in the reader's current language: right after a switch, a slow
 *     server must not be answered with the page in the old one. Offline, a page
 *     that was never saved opens the saved search page at
 *     `/wiki?offline=<path>`, whose banner says what happened; if even that is
 *     missing, a small inline page does. A page load of the planner carrying a
 *     shared list (`/wiki/craft?l=…`) is never kept, as search results are
 *     not: its HTML holds that list, and a copy of it would offer the list
 *     again every time the planner opened offline. The planner's copy is the
 *     one taken once the page says it is shown, without the list (`copyKey`).
 *
 *   - Next's RSC requests (`RSC: 1` or `?_rsc=`): never answered here, and no
 *     page is copied for one. Their payload depends on the cookies and on the
 *     router state the client sends, so a cached one is wrong in exactly the
 *     cases that matter (it once made the language toggle take two taps), and
 *     prefetches, most of them, used to push the saved pages out of the cache.
 *     When Next cannot fetch one it falls back to a full page load, which
 *     lands in the rule above.
 *
 *   - Pages shown inside the app. A page opened through an in-app link never
 *     loads its own HTML, so when the page says it is showing one (a `shown`
 *     message, sent by `ServiceWorkerRegistration` after every change of page
 *     and every language switch) the worker fetches that page's HTML in the
 *     background, and any stylesheet it links that is not saved yet, to keep
 *     it readable offline (see `keepShown`). Never on the router's request for
 *     the page: a full prefetch, made when a reader only points at or touches
 *     a link, carries exactly a tap's headers, and a page the router already
 *     holds is shown with no request at all. Copying on those requests
 *     rendered every page pointed at a second time, and filled the saved
 *     pages with ones nobody opened. The copy is a second render and
 *     download, so it is spent sparingly: not while the reader's copy is
 *     recent and in their language (the time is stored on the copy, so it
 *     outlives the worker), not right after a page load of it the server
 *     answered with nothing to keep (see `notKept`), never for a reader who
 *     asked the browser to save data, once per category page rather than once
 *     per view of it, and once for the planner however many lists are shared
 *     with it (see `copyKey`).
 *
 *   - /_next/static, in its own capped cache: cache first when the server
 *     marks the file `immutable`, as every production build does (the name is
 *     a content hash, so a URL never changes meaning). Otherwise network first
 *     with the last copy kept for offline: the dev server rebuilds files under
 *     the same name, and a cached one would hide the rebuild.
 *
 *   - The title index (/api/wiki/index) and the recipe graph
 *     (/api/wiki/recipes): stale-while-revalidate, so search and the planner
 *     are instant and work offline, and each is refreshed every time it is
 *     used. The URLs the search page and the planner ask for are also saved
 *     at install, so a reader who only ever opened articles still has a
 *     search to find them with offline, and the planner has its recipes
 *     offline from its first visit.
 *
 *   - Fandom images: cache first, by URL (a new revision changes its `?cb=`).
 *     The page's own image elements request no-cors, and opaque responses
 *     cannot be checked (Fandom's "image not available" placeholder is a 404
 *     with an image body) and are billed by Chrome at several megabytes each
 *     against the storage quota. Fandom answers no-referrer requests with
 *     `Access-Control-Allow-Origin: *` (checked with curl, for thumbnails and
 *     originals), so the worker fetches each image again in CORS mode with no
 *     referrer: the status is readable, only real 200s are kept, and an entry
 *     costs what it weighs. Should that ever fail, the page's own request goes
 *     through untouched and nothing is stored.
 *
 *   - Everything else, the chat and every other /api route included, is left
 *     alone. A cached answer to a different question would be worse than an
 *     honest failure.
 *
 * VERSION names every cache, and bumping it empties them all on activation,
 * saved pages included. Bump it only when what is stored changes shape; any
 * edit to this file already installs a new worker.
 *
 * Hand-written rather than generated: a build-time plugin would hide exactly
 * the decisions above. `routeFor` decides from the request alone, so
 * tests/unit/sw-routing.test.ts can check every one of them.
 */

const VERSION = 'v3';
const SHELL_CACHE = `wv-shell-${VERSION}`;
const DOCS_CACHE = `wv-docs-${VERSION}`;
const STATIC_CACHE = `wv-static-${VERSION}`;
const IMAGE_CACHE = `wv-images-${VERSION}`;

/** Kept small on purpose: a phone should not lose storage to a wiki. */
const MAX_DOCS = 60;
const MAX_STATIC = 300;
const MAX_IMAGES = 300;
/** A gallery original can run to a megabyte; past this it is not worth the space. */
const MAX_IMAGE_BYTES = 768 * 1024;

/** How long a page load waits for the network before a saved copy answers instead. */
const NAVIGATION_TIMEOUT_MS = 3000;
/**
 * A page is not copied in the background again while its saved copy is
 * younger than this: long enough that moving back and forth between pages in
 * one sitting copies each of them once, short enough that a page opened again
 * later picks up whatever changed in it since.
 */
const BACKGROUND_REFRESH_MS = 60 * 60 * 1000;
/**
 * How long after a page load the page saying it is shown is taken to be that
 * page load's own page: it says so once its scripts run, which on a slow
 * phone can take most of a minute.
 */
const SHOWN_AFTER_LOAD_MS = 60 * 1000;
/**
 * When a saved page was stored, kept on the entry itself. A worker is stopped
 * within a minute of going idle, so a timestamp kept in its memory was gone by
 * the time the reader finished reading, and every next tap copied again.
 */
const SAVED_AT_HEADER = 'x-wv-saved-at';

/** Where the reader's language is remembered between worker restarts (see `readerLang`). */
const LANG_KEY = '/__wv/reader-lang';

/** Opened in place of a page that was never saved, when the network is gone. */
const FALLBACK_PAGE = '/wiki';
/** Names the page the fallback stands in for; read by the offline banner. */
const MISSED_PARAM = 'offline';

/**
 * The title index exactly as the search page asks for it (`INDEX_URL` in
 * search-view.tsx; tests/unit/sw-routing.test.ts fails when the two differ).
 * It is cached by its full URL, and the bare `/api/wiki/index` answers in an
 * older shape kept only for old builds: saving that one was a download no
 * current page reads, and left the search page without an index offline.
 */
const TITLE_INDEX = '/api/wiki/index?v=2';

/**
 * The recipe graph exactly as the planner asks for it (`GRAPH_URL` in
 * src/lib/craft/graph-client.ts; tests/unit/sw-routing.test.ts fails when the
 * two differ). Cached by its full URL, like the title index: the version in
 * it names the shape the planner reads, and another shape is another copy.
 */
const RECIPE_GRAPH = '/api/wiki/recipes?v=1';

/**
 * The planner's page, and the parameter a shared list arrives in
 * (`SHARE_PARAM` in src/lib/craft/share.ts, read by the same test).
 */
const PLANNER_PAGE = '/wiki/craft';
const SHARE_PARAM = 'l';

const SHELL_ASSETS = [
  FALLBACK_PAGE,
  TITLE_INDEX,
  RECIPE_GRAPH,
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];
/** The root-level files above, served from the shell cache. */
const SHELL_ASSET_PATHS = new Set(SHELL_ASSETS.filter((p) => p !== FALLBACK_PAGE && !p.startsWith('/api/')));

/* ------------------------------------------------------------------ routing */

/**
 * What to do with a request, decided from the request alone.
 *
 * Returns `null` to leave it to the network, or `{ kind }`:
 * `navigate` (with the key its HTML is kept under, or null), `rsc` (passed
 * through, its `document` always null: a page is copied once it is shown,
 * see `keepShown`), `static`, `index`, `recipes`, `shell-asset` or `image`.
 */
function routeFor(request, origin) {
  if (request.method !== 'GET') return null;
  // Chrome throws on fetch() for this pairing, which DevTools sends.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return null;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }

  if (url.hostname === 'wikia.nocookie.net' || url.hostname.endsWith('.wikia.nocookie.net')) {
    return { kind: 'image' };
  }
  if (url.origin !== origin) return null;

  // A tap and a full prefetch send the same request, so neither says whether
  // the page will be shown: the page says so itself (`keepShown`).
  if (request.headers.get('rsc') === '1' || url.searchParams.has('_rsc')) return { kind: 'rsc', document: null };

  const path = url.pathname;
  if (path.startsWith('/_next/static/')) return { kind: 'static' };
  if (path === '/api/wiki/index') return { kind: 'index' };
  if (path === '/api/wiki/recipes') return { kind: 'recipes' };
  if (path.startsWith('/api/') || path.startsWith('/_next/')) return null;
  if (SHELL_ASSET_PATHS.has(path)) return { kind: 'shell-asset' };
  if (request.mode === 'navigate') return { kind: 'navigate', document: documentKey(url) };
  return null;
}

/**
 * The key a reader page's HTML is kept under, or `null` for a page not worth
 * keeping. Next's `_rsc` marker is dropped, so a page opened by a link and the
 * same page loaded directly share one copy; so are the `dropped` parameters.
 */
function documentKey(url, dropped = []) {
  const path = url.pathname;
  if (path !== '/wiki' && !path.startsWith('/wiki/')) return null;
  if (path.includes('/opengraph-image')) return null;
  const params = new URLSearchParams(url.search);
  for (const name of ['_rsc', ...dropped]) params.delete(name);
  // Search results: the search page works offline from the saved index anyway,
  // and a copy per query would push articles out of the cache.
  if (path === '/wiki' && [...params.keys()].length > 0) return null;
  // A shared list: the page holds it, and a copy would offer it again every
  // time the planner opened offline (see `copyKey` for the planner's own).
  if (path === PLANNER_PAGE && params.has(SHARE_PARAM)) return null;
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * The category page's list/compare switch and its level tabs (`categoryHref`
 * in src/lib/routes.ts). They choose how the page shows what it lists, not
 * what it lists, and they live in the address so a comparison can be shared.
 */
const VIEW_PARAMS = ['view', 'tab'];

/**
 * The key, and the address, a background copy is taken under. A category
 * page's views share one copy, of the page as it first opens: stepping a
 * comparison through its levels used to render the page once more per level
 * and spend a saved-page slot on each, pushing saved articles out. A view
 * opened by a full page load is also kept under its own key, at no extra
 * cost, by the page-load rule; the shared copy is taken once it is shown, as
 * for a view opened by a link.
 *
 * The planner is copied without the list a share link brought, under its own
 * address: one copy however many lists are opened, and never one that offers
 * a list again. The page says it is shown as it opens a share link, and again
 * once it has cleaned its address; both name this one copy.
 */
function copyKey(url) {
  const path = url.pathname;
  if (path === PLANNER_PAGE) return documentKey(url, [SHARE_PARAM]);
  return documentKey(url, path.startsWith('/wiki/c/') ? VIEW_PARAMS : []);
}

/**
 * The key to copy a page the reader is shown under, from the address the page
 * reports (`{ type: 'shown', path }`, its path and query), or null: for a page
 * not worth keeping (`documentKey`: search results, the chat, sign-in), for
 * another site's, and for an address that does not parse.
 */
function keepShown(path) {
  let url;
  try {
    url = new URL(path, self.location.origin);
  } catch {
    return null;
  }
  return url.origin === self.location.origin ? copyKey(url) : null;
}

/** Where an unsaved page sends the reader when the network is gone. */
function fallbackUrl(url) {
  const target = new URL(FALLBACK_PAGE, url.origin);
  target.searchParams.set(MISSED_PARAM, url.pathname + url.search);
  return target.href;
}

/** The hashed assets a saved page references, so it can render without the network. */
function assetUrls(html) {
  const found = html.match(/\/_next\/static\/[^"'\\\s<>()]+/g) || [];
  return [...new Set(found)];
}

function isKeepableDocument(response) {
  return (
    response.status === 200 &&
    response.type === 'basic' &&
    !response.redirected &&
    (response.headers.get('content-type') || '').includes('text/html')
  );
}

function isImmutable(response) {
  return (
    response.status === 200 &&
    response.type === 'basic' &&
    /\bimmutable\b/.test(response.headers.get('cache-control') || '')
  );
}

/** The response to store for a page: the same page, marked with when it was saved. */
function stamped(response) {
  const headers = new Headers(response.headers);
  headers.set(SAVED_AT_HEADER, String(Date.now()));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function savedAt(response) {
  return Number(response.headers.get(SAVED_AT_HEADER)) || 0;
}

/* --------------------------------------------------------------- lifecycle */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      // Individually, so one failure cannot fail the whole install.
      await Promise.all(SHELL_ASSETS.map((url) => shell.add(url).catch(() => {})));
      await precacheFallbackAssets(shell);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, DOCS_CACHE, STATIC_CACHE, IMAGE_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('wv-') && !keep.has(n)).map((n) => caches.delete(n)));
      // Lets a page load start on the network while the worker is still waking up.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'skip-waiting') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  // The page shows the reader another page, or the same one in the language
  // they just switched to: keep it for offline reading.
  if (data && data.type === 'shown' && typeof data.path === 'string') {
    const key = keepShown(data.path);
    if (key) event.waitUntil(keepDocument(key));
    return;
  }
  // The reader switched language: the saved search page, which stands in for
  // unsaved pages offline, should be in the new one. The page on screen is
  // copied again once the switch has rendered it (it says it is shown), and
  // other saved pages as the reader opens them: a copy in the language they
  // left never counts as recent (see `keepDocument`).
  if (data && data.type === 'lang' && (data.lang === 'es' || data.lang === 'en')) {
    knownLang = data.lang;
    event.waitUntil(
      Promise.all([
        refreshShellPage(),
        caches
          .open(SHELL_CACHE)
          .then((cache) => cache.put(LANG_KEY, new Response(data.lang)))
          .catch(() => {}),
      ]),
    );
  }
});

/** The reader's language as this worker last heard it, or null. */
let knownLang = null;

/**
 * The language the reader reads in now, or null when the worker cannot know.
 *
 * A worker never sees the Cookie header. Where the browser has the Cookie
 * Store API the cookie is read directly; elsewhere the page says so when it
 * switches (`setLangCookie` posts a message), and the answer is kept in the
 * shell cache so it survives the worker being stopped.
 */
async function readerLang() {
  try {
    if (self.cookieStore) {
      const cookie = await self.cookieStore.get('wv_lang');
      // No cookie at all means the server's default.
      return cookie && cookie.value === 'en' ? 'en' : 'es';
    }
  } catch {
    // Fall back to what the page told us.
  }
  if (knownLang) return knownLang;
  try {
    const stored = await caches.match(LANG_KEY, { cacheName: SHELL_CACHE });
    const value = stored ? (await stored.text()).trim() : null;
    if (value === 'es' || value === 'en') knownLang = value;
  } catch {
    // Unknown.
  }
  return knownLang;
}

/** The `<html lang>` a saved page was rendered with, read from its first bytes. */
async function documentLang(response) {
  try {
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();
    let head = '';
    while (head.length < 4096 && !/<html[^>]*>/i.test(head)) {
      const { done, value } = await reader.read();
      if (done) break;
      head += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    const match = /<html[^>]*\slang="([a-z]{2})/i.exec(head);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Whether a saved page may stand in for a slow network: not when it is in the other language. */
async function inReaderLang(saved) {
  const [want, have] = await Promise.all([readerLang(), documentLang(saved)]);
  return !want || !have || want === have;
}

/* ------------------------------------------------------------------- fetch */

self.addEventListener('fetch', (event) => {
  const route = routeFor(event.request, self.location.origin);
  if (!route) return;

  switch (route.kind) {
    case 'rsc':
      // Passed through, and no page is copied for it (`keepShown` is how).
      return;
    case 'navigate':
      event.respondWith(networkFirst(event, route.document));
      return;
    case 'static':
      event.respondWith(staticAsset(event));
      return;
    case 'index':
    case 'recipes':
    case 'shell-asset':
      event.respondWith(staleWhileRevalidate(event, SHELL_CACHE));
      return;
    case 'image':
      event.respondWith(fandomImage(event));
      return;
  }
});

const TIMED_OUT = 'timed-out';
const FAILED = 'failed';

async function networkFirst(event, key) {
  const { request } = event;
  const network = (async () => (await event.preloadResponse) || fetch(request))();

  // Registered first, so the copy is taken before the page starts reading the
  // body. Stamped, so a background copy right after a page load is skipped;
  // and named in `copying` until it is stored, so one asked for before then
  // is skipped too. The page says it is shown as soon as it is on screen, and
  // on a slow network that is the saved copy, answering while this one is
  // still on its way. An answer with nothing to keep is noted instead, so the
  // page saying it is shown does not ask the server for it again (`notKept`).
  if (key) {
    // What the page says it is shown under: a category view names its list.
    const shownKey = copyKey(new URL(request.url));
    copying.add(key);
    event.waitUntil(
      network
        .then(
          (response) => {
            if (!isKeepableDocument(response)) return notKept.set(shownKey, Date.now());
            notKept.delete(shownKey);
            return putCapped(DOCS_CACHE, key, stamped(response.clone()), MAX_DOCS);
          },
          () => null,
        )
        .finally(() => copying.delete(key)),
    );
  }

  const first = await Promise.race([
    network.then(
      (response) => response,
      () => FAILED,
    ),
    new Promise((resolve) => setTimeout(resolve, NAVIGATION_TIMEOUT_MS, TIMED_OUT)),
  ]);

  if (first instanceof Response) {
    if (first.status < 500) return first;
    return (await savedDocument(key)) || first;
  }

  const saved = await savedDocument(key);
  if (saved && first === TIMED_OUT && !(await inReaderLang(saved))) {
    // Slow, and the copy is in the language the reader just left: wait for
    // the real page, and fall back to the copy only if the network gives up.
    try {
      return await network;
    } catch {
      return saved;
    }
  }
  if (saved) return saved;
  if (first === TIMED_OUT) {
    // Slow, and nothing saved: a late page beats no page.
    try {
      return await network;
    } catch {
      // Gave up after all; fall through to the offline page.
    }
  }
  return offlineFallback(request);
}

async function savedDocument(key) {
  if (!key) return undefined;
  const saved = await caches.match(key, { cacheName: DOCS_CACHE, ignoreVary: true });
  if (saved || key !== FALLBACK_PAGE) return saved;
  return caches.match(FALLBACK_PAGE, { cacheName: SHELL_CACHE, ignoreVary: true });
}

async function offlineFallback(request) {
  const url = new URL(request.url);
  const shell =
    (await caches.match(FALLBACK_PAGE, { cacheName: DOCS_CACHE, ignoreVary: true })) ||
    (await caches.match(FALLBACK_PAGE, { cacheName: SHELL_CACHE, ignoreVary: true }));
  if (!shell) return offlinePage(url);
  // The search page itself, with or without a query: serve it where it is.
  if (url.pathname === FALLBACK_PAGE) return shell;
  return Response.redirect(fallbackUrl(url), 302);
}

/**
 * Pages being copied right now, by their own page load or in the background,
 * so a page shown again meanwhile is fetched once.
 */
const copying = new Set();

/**
 * Pages a page load was just answered with nothing to keep for (a missing
 * page, an error page), with when, under the key the page then says it is
 * shown under; a later page load that keeps the page drops the note. The page
 * says it is shown as soon as it is on screen, and copying it then would have
 * the server render that answer a second time, or ask a failing server again.
 * Not when the network failed: asking again costs the server nothing, and
 * keeps the page if the network is back. In memory: a note is needed for a
 * minute at most.
 */
const notKept = new Map();

/** Whether a page load of this page was answered with nothing to keep a moment ago. */
function justNotKept(key) {
  // A negative time is a clock set back; that note says nothing.
  const since = notKept.has(key) ? Date.now() - notKept.get(key) : -1;
  return since >= 0 && since < SHOWN_AFTER_LOAD_MS;
}

/** The browser's own data-saver flag: a reader who set it gets no background copy. */
function savingData() {
  try {
    return Boolean(self.navigator && self.navigator.connection && self.navigator.connection.saveData);
  } catch {
    return false;
  }
}

/**
 * Keeps a reader page's HTML for offline use, fetched without holding
 * anything up, unless the copy already saved is recent and in the reader's
 * language.
 *
 * With the stylesheets it links. Each route loads its own (the article's,
 * the guide's, a category's), and the page asks for one only the first time
 * it shows that route: a stylesheet that arrived before this worker took the
 * page over, or that the page already had when it came back to the route,
 * never passes through here, and the copy would open offline unstyled.
 */
async function keepDocument(key) {
  if (copying.has(key) || savingData() || justNotKept(key)) return;
  copying.add(key);
  try {
    const saved = await caches.match(key, { cacheName: DOCS_CACHE, ignoreVary: true });
    // A negative age is a clock set back; that copy's time says nothing.
    const age = saved ? Date.now() - savedAt(saved) : -1;
    if (age >= 0 && age < BACKGROUND_REFRESH_MS && (await inReaderLang(saved))) return;
    const response = await fetch(key, { credentials: 'same-origin', headers: { accept: 'text/html' } });
    if (!isKeepableDocument(response)) return;
    // Read alongside the copy being stored, not after it.
    const html = response.clone().text().catch(() => '');
    await putCapped(DOCS_CACHE, key, stamped(response), MAX_DOCS);
    await keepAssets(assetUrls(await html).filter(isStylesheet));
  } catch {
    // Offline, or the cache is unavailable: the next time it is shown tries again.
  } finally {
    copying.delete(key);
  }
}

function isStylesheet(url) {
  return /\.css(?:[?#]|$)/.test(url);
}

/**
 * Saves hashed assets in the static cache, each unless it is there already.
 * Only what the server marks `immutable`, as every production build does:
 * the dev server rebuilds files under the same name, and there the copy a
 * page's own request leaves (`staticAsset`) is the one to go by.
 */
async function keepAssets(urls) {
  if (urls.length === 0) return;
  const statics = await caches.open(STATIC_CACHE);
  await Promise.all(
    urls.map(async (url) => {
      try {
        if (await statics.match(url, { ignoreVary: true })) return;
        const response = await fetch(url);
        if (isImmutable(response)) await putCapped(STATIC_CACHE, url, response, MAX_STATIC);
      } catch {
        // One missing asset leaves the page a little plainer, not broken.
      }
    }),
  );
}

async function refreshShellPage() {
  try {
    const response = await fetch(FALLBACK_PAGE, { credentials: 'same-origin', headers: { accept: 'text/html' } });
    if (isKeepableDocument(response)) await (await caches.open(SHELL_CACHE)).put(FALLBACK_PAGE, response);
  } catch {
    // Offline right now; the install-time copy stays.
  }
}

/**
 * The fallback page only helps if it renders styled, and on a first visit none
 * of its CSS or JS is cached: the page that installed the worker loaded them
 * before the worker existed. They come from the browser's HTTP cache, mostly.
 */
async function precacheFallbackAssets(shell) {
  try {
    const page = await shell.match(FALLBACK_PAGE);
    if (!page) return;
    await keepAssets(assetUrls(await page.text()));
  } catch {
    // No fallback assets; the inline offline page still works.
  }
}

async function staticAsset(event) {
  const { request } = event;
  const cached = await caches.match(request, { cacheName: STATIC_CACHE, ignoreVary: true });
  // Marked immutable: the copy is the file, there is nothing to ask.
  if (cached && isImmutable(cached)) return cached;
  try {
    const response = await fetch(request);
    if (response.status === 200 && response.type === 'basic') {
      event.waitUntil(putCapped(STATIC_CACHE, request.url, response.clone(), MAX_STATIC));
    }
    return response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

async function staleWhileRevalidate(event, cacheName) {
  const { request } = event;
  const network = fetch(request);
  event.waitUntil(
    network.then(
      async (response) => {
        if (response.status !== 200 || response.type !== 'basic') return;
        try {
          await (await caches.open(cacheName)).put(request.url, response.clone());
        } catch {
          // Quota: the reader still got the fresh response.
        }
      },
      () => {},
    ),
  );
  const cached = await caches.match(request.url, { cacheName, ignoreVary: true });
  return cached || network;
}

async function fandomImage(event) {
  const { request } = event;
  const cached = await caches.match(request.url, { cacheName: IMAGE_CACHE, ignoreVary: true });
  if (cached) return cached;

  let response;
  try {
    const accept = request.headers.get('accept');
    response = await fetch(
      new Request(request.url, {
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: accept ? { accept } : {},
      }),
    );
  } catch {
    // Refused (no CORS header after all) or no network: the page's own
    // request, untouched, and nothing stored.
    return fetch(request);
  }

  const length = Number(response.headers.get('content-length') || '0');
  if (response.status === 200 && length <= MAX_IMAGE_BYTES) {
    event.waitUntil(putCapped(IMAGE_CACHE, request.url, response.clone(), MAX_IMAGES));
  }
  return response;
}

/** Stores a copy and drops the oldest entries past the limit; a failure loses only the copy. */
async function putCapped(cacheName, key, response, limit) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(key, response);
    const keys = await cache.keys();
    if (keys.length > limit) await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
  } catch {
    // Quota, or a cache being deleted by an activation.
  }
}

/**
 * The last resort: nothing saved at all, not even the search page. Static
 * text, because a worker cannot read the app's copy tables; it says it in
 * both languages, since it cannot read the language cookie either. "Try
 * again" reloads the address that failed.
 *
 * The link is the full address, not just its path: the path comes from the
 * address bar, so anyone can make it `//evil.example/x`, which as a link
 * leads to another host. The full address of a page this worker answered
 * always starts with this site.
 */
function offlinePage(url) {
  const retry = url.href.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#14170f"><title>Sin conexión · Offline — Valheim Codex</title><style>
html{color-scheme:dark}body{margin:0;min-height:100vh;display:flex;align-items:center;background:#14170f;color:#e8e2d0;font:16px/1.65 Georgia,serif;padding:max(1.5rem,env(safe-area-inset-top)) 1rem max(1.5rem,env(safe-area-inset-bottom));box-sizing:border-box}
main{max-width:34rem;margin:0 auto}h1{margin:0 0 1rem;font-size:.875rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#d98a34}p{margin:0 0 .75rem}.en{color:#9aa089}
a{display:inline-flex;align-items:center;min-height:44px;margin-top:.5rem;padding:0 1rem;border:1px solid #2a3120;border-radius:6px;color:#e8e2d0;text-decoration:none}a:focus-visible{outline:2px solid #d98a34;outline-offset:2px}
</style></head><body><main><h1>Valheim Codex</h1><p>Sin conexión, y esta página todavía no está guardada en este dispositivo.</p><p class="en" lang="en">Offline, and this page is not saved on this device yet.</p><a href="${retry}">Volver a intentar · Try again</a></main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
