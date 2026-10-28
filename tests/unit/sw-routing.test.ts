import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CRAFT_PLANNER_LIVE } from '@/lib/craft/feature';

/**
 * The service worker, run for real in a sandbox: its routing decisions, and
 * the handlers behind them against an in-memory Cache Storage and a scripted
 * network.
 *
 * It lives in `public/` as a plain script, so it is loaded the way a browser
 * would load it rather than imported; top-level function declarations become
 * properties of the sandbox, which is how the pure helpers are reached.
 */

const ORIGIN = 'https://wiki.test';
const SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

type Route = { kind: string; document?: string | null } | null;

type RequestLike = {
  url: string;
  method: string;
  mode: string;
  cache: string;
  headers: Headers;
};

function req(path: string, init: { mode?: string; headers?: Record<string, string>; method?: string } = {}): RequestLike {
  return {
    url: path.startsWith('http') ? path : ORIGIN + path,
    method: init.method ?? 'GET',
    mode: init.mode ?? 'cors',
    cache: 'default',
    headers: new Headers(init.headers ?? {}),
  };
}

/* ------------------------------------------------- in-memory Cache Storage */

function keyOf(input: string | RequestLike | Request): string {
  const url = typeof input === 'string' ? input : input.url;
  return new URL(url, ORIGIN).href;
}

class FakeCache {
  entries = new Map<string, Response>();
  /** The worker's own network, which `add` fetches through as the real one does. */
  constructor(private readonly network: () => FetchImpl) {}
  async match(input: string | RequestLike): Promise<Response | undefined> {
    return this.entries.get(keyOf(input))?.clone();
  }
  async put(input: string | RequestLike, response: Response): Promise<void> {
    const key = keyOf(input);
    this.entries.delete(key);
    this.entries.set(key, response);
  }
  /** Like `Cache.add`: fetch, refuse anything but a 2xx, store. */
  async add(input: string): Promise<void> {
    const response = await this.network()(input);
    if (!response.ok) throw new TypeError(`add(${input}): ${response.status}`);
    await this.put(input, response);
  }
  async keys(): Promise<{ url: string }[]> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(input: string | { url: string }): Promise<boolean> {
    return this.entries.delete(keyOf(typeof input === 'string' ? input : input.url));
  }
}

class FakeCacheStorage {
  stores = new Map<string, FakeCache>();
  /** Set by the worker that uses this storage; a restarted worker brings its own. */
  network: FetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  async open(name: string): Promise<FakeCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache(() => this.network);
      this.stores.set(name, cache);
    }
    return cache;
  }
  async match(input: string | RequestLike, options: { cacheName?: string } = {}): Promise<Response | undefined> {
    const names = options.cacheName ? [options.cacheName] : [...this.stores.keys()];
    for (const name of names) {
      const hit = await this.stores.get(name)?.match(input);
      if (hit) return hit;
    }
    return undefined;
  }
  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
  /** Synchronous peek for assertions. */
  has(cacheName: string, path: string): boolean {
    return this.stores.get(cacheName)?.entries.has(keyOf(path)) ?? false;
  }
}

/* ------------------------------------------------------------ the worker */

type FetchImpl = (input: RequestLike | Request | string, init?: RequestInit) => Promise<Response>;

function loadWorker(
  options: {
    fetch?: FetchImpl;
    instantTimers?: boolean;
    /** Cache Storage left by an earlier worker: the browser keeps it when a worker is stopped. */
    caches?: FakeCacheStorage;
    /** `self.navigator`, for the data-saver flag. */
    navigator?: unknown;
    /** The worker's clock (`Date.now()`); the real one otherwise. */
    now?: () => number;
  } = {},
) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const caches = options.caches ?? new FakeCacheStorage();
  const requests: { url: string; mode?: string; referrerPolicy?: string; credentials?: string }[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = typeof input === 'string' ? new URL(input, ORIGIN).href : input.url;
    const asRequest = input instanceof Request ? input : undefined;
    requests.push({
      url,
      mode: asRequest?.mode ?? (typeof input === 'object' && 'mode' in input ? input.mode : undefined),
      referrerPolicy: asRequest?.referrerPolicy,
      credentials: asRequest?.credentials ?? init?.credentials,
    });
    if (!options.fetch) throw new TypeError('Failed to fetch');
    return options.fetch(input, init);
  };
  caches.network = fetchImpl;
  const sandbox: Record<string, unknown> = {
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[type] = fn;
      },
      location: { origin: ORIGIN },
      registration: {},
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
      navigator: options.navigator,
    },
    caches,
    fetch: fetchImpl,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    TextDecoder,
    console,
    Date: options.now ? clockedDate(options.now) : Date,
    setTimeout: options.instantTimers
      ? (fn: (...args: unknown[]) => void, _ms: number, ...args: unknown[]) => queueMicrotask(() => fn(...args))
      : // Never fires: a timeout must not decide a test that is not about it.
        () => 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'sw.js' });

  const routeFor = sandbox.routeFor as (request: RequestLike, origin: string) => Route;

  /** Dispatches a fetch event; resolves with what the worker answered, or `undefined` if it let it through. */
  async function dispatch(request: RequestLike, preloadResponse?: Response) {
    let responded: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    const event = {
      request,
      preloadResponse: Promise.resolve(preloadResponse),
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
    };
    listeners.fetch?.(event);
    const response = responded ? await responded : undefined;
    // Let background work started after the response settle too, without
    // waiting forever on a network a test scripted never to answer.
    for (let i = 0; i < 5; i++) {
      await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 50))]);
    }
    return response;
  }

  /** Posts a message to the worker, as a page's `controller.postMessage` would. */
  async function message(data: unknown) {
    const pending: Promise<unknown>[] = [];
    listeners.message?.({ data, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 50))]);
  }

  /** Runs `install` or `activate` to the end, as the browser waits for it. */
  async function lifecycle(type: 'install' | 'activate') {
    const pending: Promise<unknown>[] = [];
    listeners[type]?.({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  }

  return { sandbox, routeFor, dispatch, message, lifecycle, caches, requests };
}

const DOCS = 'wv-docs-v3';
const SHELL = 'wv-shell-v3';
const STATIC = 'wv-static-v3';
const IMAGES = 'wv-images-v3';

/**
 * Names the worker shares with the planner, which it cannot import: read from
 * their source, so a change on one side fails here instead of leaving the
 * worker saving a graph no page reads, or keeping a shared list as the
 * planner's page.
 */
const constantIn = (file: string[], name: string): string | undefined =>
  new RegExp(`\\b${name}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`).exec(readFileSync(join(process.cwd(), ...file), 'utf8'))?.[1];
const GRAPH_URL = constantIn(['src', 'lib', 'craft', 'graph-client.ts'], 'GRAPH_URL');
const SHARE_PARAM = constantIn(['src', 'lib', 'craft', 'share.ts'], 'SHARE_PARAM');

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
}

/**
 * Node's Response is typed `default`; a same-origin browser response is
 * `basic`, and so is every clone of it, including the one a cache hands back.
 */
function basic(response: Response): Response {
  const clone = response.clone.bind(response);
  Object.defineProperty(response, 'type', { value: 'basic' });
  Object.defineProperty(response, 'clone', { value: () => basic(clone()) });
  return response;
}

/** `Date` running on the given clock, so a test can move the worker's time on. */
function clockedDate(clock: () => number) {
  return class extends Date {
    static override now(): number {
      return clock();
    }
  };
}

/* ----------------------------------------------------------------- routing */

describe('service worker routing', () => {
  const { routeFor } = loadWorker();

  it('never answers an RSC request, prefetch or not', () => {
    expect(routeFor(req('/wiki/browse', { headers: { rsc: '1' } }), ORIGIN)?.kind).toBe('rsc');
    expect(routeFor(req('/wiki/browse?_rsc=abc'), ORIGIN)?.kind).toBe('rsc');
    expect(routeFor(req('/', { headers: { rsc: '1' } }), ORIGIN)).toEqual({ kind: 'rsc', document: null });
  });

  it('copies no page for a tap’s RSC request, which a full prefetch sends too', () => {
    // A tap, a full prefetch (`IntentPrefetch`) and a refresh: the state tree, no prefetch header.
    const headers = { rsc: '1', 'next-router-state-tree': '%5B%22%22%5D' };
    expect(routeFor(req('/wiki/c/all?biome=Meadows&_rsc=x1', { headers }), ORIGIN)).toEqual({ kind: 'rsc', document: null });
    expect(routeFor(req('/wiki/a/iron-sword?_rsc=x2', { headers }), ORIGIN)).toEqual({ kind: 'rsc', document: null });
  });

  it('keeps nothing for prefetches and hot-reload refreshes', () => {
    for (const header of ['next-router-prefetch', 'next-router-segment-prefetch', 'next-hmr-refresh']) {
      expect(routeFor(req('/wiki/a/iron-sword?_rsc=1', { headers: { rsc: '1', [header]: '1' } }), ORIGIN)).toEqual({
        kind: 'rsc',
        document: null,
      });
    }
  });

  it('copies a page the reader is shown under its clean address, a category page once for all its views', () => {
    const keepShown = loadWorker().sandbox.keepShown as (path: string) => string | null;
    expect(keepShown('/wiki/a/iron-sword')).toBe('/wiki/a/iron-sword');
    expect(keepShown('/wiki')).toBe('/wiki');
    expect(keepShown('/wiki/c/all?biome=Meadows')).toBe('/wiki/c/all?biome=Meadows');
    // A whole address on this site works too, and a fragment is no page of its own.
    expect(keepShown(`${ORIGIN}/wiki/guide#meadows`)).toBe('/wiki/guide');
    expect(keepShown('/wiki/c/Weapons?view=compare')).toBe('/wiki/c/Weapons');
    expect(keepShown('/wiki/c/Weapons?view=compare&tab=3')).toBe('/wiki/c/Weapons');
    // What the page lists still counts.
    expect(keepShown('/wiki/c/all?biome=Meadows&view=compare&tab=2')).toBe('/wiki/c/all?biome=Meadows');
    // A full page load of a view keeps that view, at no extra cost.
    expect(routeFor(req('/wiki/c/Weapons?view=compare', { mode: 'navigate' }), ORIGIN)).toEqual({
      kind: 'navigate',
      document: '/wiki/c/Weapons?view=compare',
    });
  });

  it('copies nothing for search results, the chat, sign-in, another site or a broken address', () => {
    const keepShown = loadWorker().sandbox.keepShown as (path: string) => string | null;
    for (const path of [
      '/wiki?q=hierro',
      '/wiki?offline=%2Fwiki%2Fa%2Fx',
      '/',
      '/?c=4f2a',
      '/?about=Iron%20Sword',
      '/login',
      '/login?next=%2F',
      '/wikileaks',
      '/wiki/a/iron-sword/opengraph-image',
      'https://evil.test/wiki/a/x',
      '//evil.test/wiki/a/x',
      'http://[',
    ]) {
      expect(keepShown(path), path).toBeNull();
    }
  });

  it('handles page loads, keeping reader pages but not search results or the chat', () => {
    const nav = (path: string) => routeFor(req(path, { mode: 'navigate' }), ORIGIN);
    expect(nav('/wiki/a/iron-sword')).toEqual({ kind: 'navigate', document: '/wiki/a/iron-sword' });
    expect(nav('/wiki')).toEqual({ kind: 'navigate', document: '/wiki' });
    expect(nav('/wiki/c/all?biome=Meadows')).toEqual({ kind: 'navigate', document: '/wiki/c/all?biome=Meadows' });
    expect(nav('/wiki?q=hierro')).toEqual({ kind: 'navigate', document: null });
    expect(nav('/wiki?offline=%2Fwiki%2Fa%2Fx')).toEqual({ kind: 'navigate', document: null });
    expect(nav('/')).toEqual({ kind: 'navigate', document: null });
    expect(nav('/login')).toEqual({ kind: 'navigate', document: null });
    expect(nav('/wikileaks')).toEqual({ kind: 'navigate', document: null });
  });

  it('leaves every API alone except the title index and the recipe graph', () => {
    expect(routeFor(req('/api/wiki/index'), ORIGIN)).toEqual({ kind: 'index' });
    expect(routeFor(req('/api/wiki/index?lang=es'), ORIGIN)).toEqual({ kind: 'index' });
    expect(routeFor(req('/api/wiki/recipes?v=1'), ORIGIN)).toEqual({ kind: 'recipes' });
    expect(routeFor(req('/api/wiki/recipes'), ORIGIN)).toEqual({ kind: 'recipes' });
    for (const path of [
      '/api/chat',
      '/api/wiki/search?q=x',
      '/api/health',
      '/api/auth/session',
      '/api/conversations',
      '/api/wiki/recipes/Karve',
      '/api/wiki/recipesx',
    ]) {
      expect(routeFor(req(path), ORIGIN)).toBeNull();
      expect(routeFor(req(path, { mode: 'navigate' }), ORIGIN)).toBeNull();
    }
    expect(routeFor(req('/api/chat', { method: 'POST' }), ORIGIN)).toBeNull();
    expect(routeFor(req('/api/wiki/recipes?v=1', { method: 'POST' }), ORIGIN)).toBeNull();
  });

  it('keeps the planner’s page, but no page load that carries a shared list', () => {
    expect(SHARE_PARAM, 'SHARE_PARAM in src/lib/craft/share.ts').toBe('l');
    const nav = (path: string) => routeFor(req(path, { mode: 'navigate' }), ORIGIN);
    expect(nav('/wiki/craft')).toEqual({ kind: 'navigate', document: '/wiki/craft' });
    // Its HTML holds the shared list: kept under any key, it would offer that
    // list again whenever the planner opened offline.
    expect(nav(`/wiki/craft?${SHARE_PARAM}=SwordIron.4.0.1`)).toEqual({ kind: 'navigate', document: null });
    expect(nav(`/wiki/craft?${SHARE_PARAM}=SwordIron.4.0.1&utm_source=x`)).toEqual({ kind: 'navigate', document: null });
  });

  it('copies the planner under its own address, whatever list a page shown with it carried', () => {
    const { copyKey, keepShown } = loadWorker().sandbox as {
      copyKey: (url: URL) => string | null;
      keepShown: (path: string) => string | null;
    };
    const share = `/wiki/craft?${SHARE_PARAM}=SwordIron.4.0.1~Karve.1.0.1`;
    expect(copyKey(new URL(share, ORIGIN))).toBe(copyKey(new URL('/wiki/craft', ORIGIN)));
    expect(copyKey(new URL('/wiki/craft', ORIGIN))).toBe('/wiki/craft');
    expect(keepShown(share)).toBe('/wiki/craft');
    // Only the planner's own parameter folds away, and only on the planner.
    expect(keepShown(`/wiki/a/iron-sword?${SHARE_PARAM}=x`)).toBe(`/wiki/a/iron-sword?${SHARE_PARAM}=x`);
  });

  it('caches hashed assets and the install files, nothing else of ours', () => {
    expect(routeFor(req('/_next/static/chunks/app.js'), ORIGIN)).toEqual({ kind: 'static' });
    expect(routeFor(req('/_next/image?url=x'), ORIGIN)).toBeNull();
    expect(routeFor(req('/manifest.webmanifest'), ORIGIN)).toEqual({ kind: 'shell-asset' });
    expect(routeFor(req('/icon-192.png'), ORIGIN)).toEqual({ kind: 'shell-asset' });
    expect(routeFor(req('/wiki/a/iron-sword'), ORIGIN)).toBeNull();
  });

  it('takes Fandom images and no other third party', () => {
    expect(routeFor(req('https://static.wikia.nocookie.net/valheim/images/a/b/Iron.png'), ORIGIN)).toEqual({ kind: 'image' });
    expect(routeFor(req('https://example.com/x.png'), ORIGIN)).toBeNull();
    expect(routeFor(req('https://nocookie.net.evil.example/x.png'), ORIGIN)).toBeNull();
  });

  it('sends an unsaved page to the search page, naming it', () => {
    const fallbackUrl = loadWorker().sandbox.fallbackUrl as (url: URL) => string;
    const target = new URL(fallbackUrl(new URL(`${ORIGIN}/wiki/c/all?biome=Meadows`)));
    expect(target.pathname).toBe('/wiki');
    expect(target.searchParams.get('offline')).toBe('/wiki/c/all?biome=Meadows');
  });

  it('finds the hashed assets a saved page needs', () => {
    const assetUrls = loadWorker().sandbox.assetUrls as (html: string) => string[];
    const page =
      '<link rel="stylesheet" href="/_next/static/chunks/a1.css"/><script src="/_next/static/chunks/b2.js" async=""></script>' +
      '<script>self.__next_f.push([1,"0:[\\"/_next/static/chunks/b2.js\\"]"])</script>';
    expect(assetUrls(page).sort()).toEqual(['/_next/static/chunks/a1.css', '/_next/static/chunks/b2.js']);
  });
});

/* ---------------------------------------------------------------- handlers */

describe('service worker page loads', () => {
  it('answers from the network while online and keeps a copy', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('<p>live</p>')) });
    const response = await worker.dispatch(req('/wiki/a/iron-sword', { mode: 'navigate' }));
    expect(await response?.text()).toBe('<p>live</p>');
    expect(worker.caches.has(DOCS, '/wiki/a/iron-sword')).toBe(true);
  });

  it('uses the navigation preload response when the browser started one', async () => {
    const worker = loadWorker();
    const response = await worker.dispatch(req('/wiki/browse', { mode: 'navigate' }), basic(html('<p>preloaded</p>')));
    expect(await response?.text()).toBe('<p>preloaded</p>');
    expect(worker.requests).toHaveLength(0);
  });

  it('never keeps a redirect, an error or a non-HTML answer', async () => {
    for (const make of [
      () => basic(html('<p>x</p>', { status: 404 })),
      () => basic(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
      () => html('<p>opaque</p>'),
    ]) {
      const worker = loadWorker({ fetch: async () => make() });
      await worker.dispatch(req('/wiki/a/x', { mode: 'navigate' }));
      expect(worker.caches.has(DOCS, '/wiki/a/x')).toBe(false);
    }
  });

  it('answers a page load carrying a shared list from the network, and keeps nothing for it', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('<p>planner, offering a shared list</p>')) });
    const response = await worker.dispatch(req(`/wiki/craft?${SHARE_PARAM}=SwordIron.4.0.1`, { mode: 'navigate' }));
    expect(await response?.text()).toBe('<p>planner, offering a shared list</p>');
    expect(worker.requests.map((r) => new URL(r.url).search)).toEqual([`?${SHARE_PARAM}=SwordIron.4.0.1`]);
    expect(worker.caches.stores.get(DOCS)?.entries.size ?? 0).toBe(0);
  });

  it('falls back to the saved copy when the network fails', async () => {
    const worker = loadWorker();
    await (await worker.caches.open(DOCS)).put('/wiki/a/iron-sword', html('<p>saved</p>'));
    const response = await worker.dispatch(req('/wiki/a/iron-sword', { mode: 'navigate' }));
    expect(await response?.text()).toBe('<p>saved</p>');
  });

  it('prefers the saved copy over the CDN error page while the origin is down', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('bad gateway', { status: 502 })) });
    await (await worker.caches.open(DOCS)).put('/wiki/a/iron-sword', html('<p>saved</p>'));
    const response = await worker.dispatch(req('/wiki/a/iron-sword', { mode: 'navigate' }));
    expect(await response?.text()).toBe('<p>saved</p>');
  });

  it('answers with the saved copy when the network is too slow', async () => {
    const worker = loadWorker({ fetch: () => new Promise<Response>(() => {}), instantTimers: true });
    await (await worker.caches.open(DOCS)).put('/wiki/a/iron-sword', html('<p>saved</p>'));
    const response = await worker.dispatch(req('/wiki/a/iron-sword', { mode: 'navigate' }));
    expect(await response?.text()).toBe('<p>saved</p>');
  });

  it('waits for a slow network rather than answer in the language the reader just left', async () => {
    const later = (body: string) =>
      new Promise<Response>((resolve) => setTimeout(() => resolve(basic(html(body))), 30));
    const worker = loadWorker({ fetch: () => later('<!DOCTYPE html><html lang="en"><body>live'), instantTimers: true });
    await (await worker.caches.open(DOCS)).put('/wiki/a/iron-sword', html('<!DOCTYPE html><html lang="es"><body>viejo'));
    await worker.message({ type: 'lang', lang: 'en' });
    const response = await worker.dispatch(req('/wiki/a/iron-sword', { mode: 'navigate' }));
    expect(await response?.text()).toContain('live');
  });

  it('still answers a slow network with a saved page in the reader’s own language', async () => {
    const worker = loadWorker({ fetch: () => new Promise<Response>(() => {}), instantTimers: true });
    await (await worker.caches.open(DOCS)).put('/wiki/a/iron-sword', html('<!DOCTYPE html><html lang="en"><body>saved'));
    await worker.message({ type: 'lang', lang: 'en' });
    const response = await worker.dispatch(req('/wiki/a/iron-sword', { mode: 'navigate' }));
    expect(await response?.text()).toContain('saved');
  });

  it('opens the saved search page, naming the missed page, when an unsaved page is asked for offline', async () => {
    const worker = loadWorker();
    await (await worker.caches.open(SHELL)).put('/wiki', html('<p>search</p>'));
    const response = await worker.dispatch(req('/wiki/a/never-opened', { mode: 'navigate' }));
    expect(response?.status).toBe(302);
    const location = new URL(response?.headers.get('location') ?? '');
    expect(location.pathname).toBe('/wiki');
    expect(location.searchParams.get('offline')).toBe('/wiki/a/never-opened');

    // The redirect lands on the search page itself, served where it is.
    const landed = await worker.dispatch(req(location.pathname + location.search, { mode: 'navigate' }));
    expect(await landed?.text()).toBe('<p>search</p>');
  });

  it('shows a self-contained page when nothing at all is saved, retrying the same address', async () => {
    const worker = loadWorker();
    const response = await worker.dispatch(req('/wiki/c/all?biome=Meadows&x="><b>', { mode: 'navigate' }));
    expect(response?.status).toBe(503);
    expect(response?.headers.get('content-type')).toContain('text/html');
    const page = (await response?.text()) ?? '';
    expect(page).toContain(`href="${ORIGIN}/wiki/c/all?biome=Meadows&#38;x=%22%3E%3Cb%3E"`);
    expect(page).not.toContain('"><b>');
  });

  it('retries on this site even when the address’s path looks like another host', async () => {
    const worker = loadWorker();
    for (const path of ['//evil.example/x', '/.//evil.example/x']) {
      const response = await worker.dispatch(req(path, { mode: 'navigate' }));
      const href = /<a href="([^"]+)"/.exec((await response?.text()) ?? '')?.[1] ?? '';
      const target = new URL(href.replace(/&#38;/g, '&'), `${ORIGIN}${path}`);
      expect(target.origin, path).toBe(ORIGIN);
    }
  });
});

describe('service worker install and activation', () => {
  /**
   * The search page names the index it reads in one constant. The worker
   * cannot import it, so this reads it from the source: when the two differ,
   * the worker saves a payload no page reads and the offline search is empty.
   */
  const SEARCH_VIEW = readFileSync(join(process.cwd(), 'src', 'components', 'wiki', 'search-view.tsx'), 'utf8');
  const INDEX_URL = /\bINDEX_URL\s*=\s*['"`]([^'"`]+)['"`]/.exec(SEARCH_VIEW)?.[1];

  function siteNetwork(): FetchImpl {
    return async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
      if (url.pathname === '/wiki') {
        return basic(
          html(
            '<link rel="stylesheet" href="/_next/static/chunks/a1.css"/><script src="/_next/static/chunks/b2.js" async=""></script>',
          ),
        );
      }
      if (url.pathname.startsWith('/_next/static/')) {
        return basic(new Response('asset', { status: 200, headers: { 'cache-control': 'public, max-age=31536000, immutable' } }));
      }
      return basic(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    };
  }

  it('saves the title index the search page reads, and not the old shape', async () => {
    expect(INDEX_URL, 'INDEX_URL in src/components/wiki/search-view.tsx').toMatch(/^\/api\/wiki\/index/);
    const worker = loadWorker({ fetch: siteNetwork() });
    await worker.lifecycle('install');
    expect(worker.caches.has(SHELL, INDEX_URL ?? '')).toBe(true);
    const fetched = worker.requests.map((r) => new URL(r.url).pathname + new URL(r.url).search);
    expect(fetched).toContain(INDEX_URL);
    expect(fetched).not.toContain('/api/wiki/index');
  });

  /*
   * Not while the planner is hidden: every reader's new worker would download
   * the whole graph for a page no link leads to. The worker cannot import
   * `CRAFT_PLANNER_LIVE`, so it keeps its own `PLANNER_LIVE`, and opening the
   * gate fails here until the worker saves the graph again.
   */
  it('saves the recipe graph the planner reads, once the planner is live', async () => {
    expect(GRAPH_URL, 'GRAPH_URL in src/lib/craft/graph-client.ts').toMatch(/^\/api\/wiki\/recipes\?/);
    const worker = loadWorker({ fetch: siteNetwork() });
    await worker.lifecycle('install');
    const live = 'PLANNER_LIVE in public/sw.js follows CRAFT_PLANNER_LIVE in src/lib/craft/feature.ts';
    expect(worker.caches.has(SHELL, GRAPH_URL ?? ''), live).toBe(CRAFT_PLANNER_LIVE);
    const fetched = worker.requests.map((r) => new URL(r.url).pathname + new URL(r.url).search);
    expect(fetched.includes(GRAPH_URL ?? ''), live).toBe(CRAFT_PLANNER_LIVE);
  });

  it('saves the search page with the files it needs to render, and the install files', async () => {
    const worker = loadWorker({ fetch: siteNetwork() });
    await worker.lifecycle('install');
    expect(worker.caches.has(SHELL, '/wiki')).toBe(true);
    expect(worker.caches.has(SHELL, '/manifest.webmanifest')).toBe(true);
    expect(worker.caches.has(STATIC, '/_next/static/chunks/a1.css')).toBe(true);
    expect(worker.caches.has(STATIC, '/_next/static/chunks/b2.js')).toBe(true);
  });

  it('still installs when the network fails part of the way', async () => {
    const worker = loadWorker({
      fetch: async (input) => {
        const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
        if (url.pathname === '/icon-512.png') throw new TypeError('Failed to fetch');
        return siteNetwork()(input);
      },
    });
    await worker.lifecycle('install');
    expect(worker.caches.has(SHELL, '/wiki')).toBe(true);
    expect(worker.caches.has(SHELL, '/icon-512.png')).toBe(false);
  });

  it('empties the previous version’s caches on activation, and only ours', async () => {
    const worker = loadWorker();
    for (const name of ['wv-pages-v2', 'wv-shell-v2', DOCS, 'someone-elses-cache']) await worker.caches.open(name);
    await worker.lifecycle('activate');
    expect(await worker.caches.keys()).toEqual([DOCS, 'someone-elses-cache']);
  });
});

describe('service worker RSC requests', () => {
  it('lets the router’s requests through and copies no page for them, a full prefetch included', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('<p>doc</p>')) });
    const tap = { rsc: '1', 'next-router-state-tree': '%5B%22%22%5D' };
    // A tap and a full prefetch send the same request; a plain prefetch says what it is.
    for (const request of [
      req('/wiki/c/Weapons?_rsc=x1', { headers: tap }),
      req('/wiki/a/iron-sword?_rsc=x2', { headers: tap }),
      req('/wiki/a/bronze-sword?_rsc=x3', { headers: { ...tap, 'next-router-prefetch': '1' } }),
    ]) {
      expect(await worker.dispatch(request)).toBeUndefined();
    }
    expect(worker.requests).toEqual([]);
    expect(worker.caches.stores.get(DOCS)?.entries.size ?? 0).toBe(0);
  });
});

/*
 * A page opened inside the app never loads its own HTML: the page says which
 * one it shows (`ShownPages`, src/components/shell/service-worker.tsx), and
 * the worker copies that one in the background.
 */
describe('service worker copies of the pages shown', () => {
  const shown = (path: string) => ({ type: 'shown', path });

  it('keeps the HTML of a page the reader is shown, in the background', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('<p>doc</p>')) });
    await worker.message(shown('/wiki/c/Weapons'));
    expect(worker.requests.map((r) => r.url)).toEqual([`${ORIGIN}/wiki/c/Weapons`]);
    expect(worker.caches.has(DOCS, '/wiki/c/Weapons')).toBe(true);
  });

  it('fetches nothing for a page it does not keep, or a message that names none', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('<p>doc</p>')) });
    for (const path of ['/wiki?q=hierro', '/', '/login', 'https://evil.test/wiki/a/x', 'http://[']) {
      await worker.message(shown(path));
    }
    for (const data of [{ type: 'shown' }, { type: 'shown', path: 42 }, { type: 'shown', path: null }, 'shown']) {
      await worker.message(data);
    }
    expect(worker.requests).toEqual([]);
    expect(worker.caches.stores.get(DOCS)?.entries.size ?? 0).toBe(0);
  });

  it('fetches that copy once, not every time the page is shown', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('<p>doc</p>')) });
    await worker.message(shown('/wiki/browse'));
    await worker.message(shown('/wiki/browse'));
    expect(worker.requests).toHaveLength(1);
  });

  it('remembers a recent copy after the worker is stopped and started again', async () => {
    const network = async () => basic(html('<p>doc</p>'));
    const first = loadWorker({ fetch: network });
    await first.message(shown('/wiki/browse'));
    // The browser stops an idle worker; its caches stay.
    const restarted = loadWorker({ fetch: network, caches: first.caches });
    await restarted.message(shown('/wiki/browse'));
    expect(restarted.requests).toHaveLength(0);
  });

  it('copies the page again once its copy is old', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('<p>new</p>')) });
    const dayAgo = String(Date.now() - 24 * 60 * 60 * 1000);
    await (await worker.caches.open(DOCS)).put('/wiki/browse', html('<p>old</p>', { headers: { 'x-wv-saved-at': dayAgo } }));
    await worker.message(shown('/wiki/browse'));
    expect(worker.requests).toHaveLength(1);
    expect(await (await worker.caches.match('/wiki/browse', { cacheName: DOCS }))?.text()).toBe('<p>new</p>');
  });

  it('counts a full page load as a fresh copy', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('<p>doc</p>')) });
    await worker.dispatch(req('/wiki/a/iron-sword', { mode: 'navigate' }));
    // The page says it is shown as soon as it is on screen, page loads included.
    await worker.message(shown('/wiki/a/iron-sword'));
    expect(worker.requests).toHaveLength(1);
    const saved = await worker.caches.match('/wiki/a/iron-sword', { cacheName: DOCS });
    expect(Number(saved?.headers.get('x-wv-saved-at'))).toBeGreaterThan(0);
  });

  it('takes no second copy of a page while its own page load is on its way', async () => {
    // A slow network: the saved copy, a day old, stands in, and the page says
    // it is shown while the page load's own request is still out.
    let answer: (response: Response) => void = () => {};
    const worker = loadWorker({ fetch: () => new Promise<Response>((resolve) => (answer = resolve)), instantTimers: true });
    const dayAgo = String(Date.now() - 24 * 60 * 60 * 1000);
    await (await worker.caches.open(DOCS)).put(
      '/wiki/a/iron-sword',
      html('<p>old</p>', { headers: { 'content-type': 'text/html', 'x-wv-saved-at': dayAgo } }),
    );
    const page = await worker.dispatch(req('/wiki/a/iron-sword', { mode: 'navigate' }));
    expect(await page?.text()).toBe('<p>old</p>');
    await worker.message(shown('/wiki/a/iron-sword'));
    expect(worker.requests).toHaveLength(1);

    // That request's answer is the copy kept, and a recent one from then on.
    answer(basic(html('<p>new</p>')));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await (await worker.caches.match('/wiki/a/iron-sword', { cacheName: DOCS }))?.text()).toBe('<p>new</p>');
    await worker.message(shown('/wiki/a/iron-sword'));
    expect(worker.requests).toHaveLength(1);
  });

  it('asks the server once for a page whose page load brought nothing to keep', async () => {
    // A missing article, a page that failed, a missing category opened in one
    // of its views: each says it is shown right after, as every page does.
    for (const [path, status] of [
      ['/wiki/a/no-such-article', 404],
      ['/wiki/a/broken', 500],
      ['/wiki/c/Nope?view=compare&tab=2', 404],
    ] as const) {
      const worker = loadWorker({ fetch: async () => basic(html('<p>no</p>', { status })) });
      await worker.dispatch(req(path, { mode: 'navigate' }));
      await worker.message(shown(path));
      expect(worker.requests, path).toHaveLength(1);
      expect(worker.caches.stores.get(DOCS)?.entries.size ?? 0, path).toBe(0);
    }
  });

  it('asks a failing server once, when the old copy standing in says it is shown', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('bad gateway', { status: 502 })) });
    const dayAgo = String(Date.now() - 24 * 60 * 60 * 1000);
    await (await worker.caches.open(DOCS)).put(
      '/wiki/a/iron-sword',
      html('<p>saved</p>', { headers: { 'content-type': 'text/html', 'x-wv-saved-at': dayAgo } }),
    );
    const page = await worker.dispatch(req('/wiki/a/iron-sword', { mode: 'navigate' }));
    expect(await page?.text()).toBe('<p>saved</p>');
    await worker.message(shown('/wiki/a/iron-sword'));
    expect(worker.requests).toHaveLength(1);
  });

  it('asks for such a page again when it is shown a minute on, by when the server may have it', async () => {
    let now = Date.now();
    let status = 404;
    const worker = loadWorker({ fetch: async () => basic(html('<p>doc</p>', { status })), now: () => now });
    await worker.dispatch(req('/wiki/a/new-article', { mode: 'navigate' }));
    await worker.message(shown('/wiki/a/new-article'));
    expect(worker.requests).toHaveLength(1);

    status = 200;
    now += 60 * 1000;
    await worker.message(shown('/wiki/a/new-article'));
    expect(worker.requests).toHaveLength(2);
    expect(worker.caches.has(DOCS, '/wiki/a/new-article')).toBe(true);
  });

  it('forgets that a page load brought nothing once a later one keeps the page', async () => {
    // The server failed, then answered a reload, and the reader switched language right after.
    let status = 502;
    let lang = 'es';
    const worker = loadWorker({ fetch: async () => basic(html(`<!DOCTYPE html><html lang="${lang}"><body>doc`, { status })) });
    await worker.dispatch(req('/wiki/browse', { mode: 'navigate' }));
    status = 200;
    await worker.dispatch(req('/wiki/browse', { mode: 'navigate' }));
    lang = 'en';
    await worker.message({ type: 'lang', lang: 'en' });
    await worker.message(shown('/wiki/browse'));
    expect(await (await worker.caches.match('/wiki/browse', { cacheName: DOCS }))?.text()).toContain('lang="en"');
  });

  it('asks for a page again when its page load found no network', async () => {
    // Answered from a day-old copy while offline. Asking again costs the
    // server nothing, and keeps the page now that the network is back.
    let online = false;
    const worker = loadWorker({
      fetch: async () => {
        if (!online) throw new TypeError('Failed to fetch');
        return basic(html('<p>new</p>'));
      },
    });
    const dayAgo = String(Date.now() - 24 * 60 * 60 * 1000);
    await (await worker.caches.open(DOCS)).put(
      '/wiki/a/iron-sword',
      html('<p>old</p>', { headers: { 'content-type': 'text/html', 'x-wv-saved-at': dayAgo } }),
    );
    const page = await worker.dispatch(req('/wiki/a/iron-sword', { mode: 'navigate' }));
    expect(await page?.text()).toBe('<p>old</p>');
    online = true;
    await worker.message(shown('/wiki/a/iron-sword'));
    expect(await (await worker.caches.match('/wiki/a/iron-sword', { cacheName: DOCS }))?.text()).toBe('<p>new</p>');
  });

  it('fetches it again after a language switch, and re-saves the offline search page', async () => {
    // The server renders in whatever language the cookie says.
    let lang = 'es';
    const worker = loadWorker({ fetch: async () => basic(html(`<!DOCTYPE html><html lang="${lang}"><body>doc`)) });
    await worker.message(shown('/wiki/browse'));
    lang = 'en';
    await worker.message({ type: 'lang', lang: 'en' });
    // The switch renders the page anew, which says it is shown again.
    await worker.message(shown('/wiki/browse'));
    expect(worker.requests.map((r) => new URL(r.url).pathname)).toEqual(['/wiki/browse', '/wiki', '/wiki/browse']);
    expect(worker.caches.has(SHELL, '/wiki')).toBe(true);
    expect(await (await worker.caches.match('/wiki/browse', { cacheName: DOCS }))?.text()).toContain('lang="en"');

    // In the new language now: no further copy.
    await worker.message(shown('/wiki/browse'));
    expect(worker.requests).toHaveLength(3);
  });

  it('fetches a page its page load kept a moment ago again after a language switch', async () => {
    let lang = 'es';
    const worker = loadWorker({ fetch: async () => basic(html(`<!DOCTYPE html><html lang="${lang}"><body>doc`)) });
    await worker.dispatch(req('/wiki/browse', { mode: 'navigate' }));
    await worker.message(shown('/wiki/browse'));
    lang = 'en';
    await worker.message({ type: 'lang', lang: 'en' });
    await worker.message(shown('/wiki/browse'));
    expect(worker.requests.map((r) => new URL(r.url).pathname)).toEqual(['/wiki/browse', '/wiki', '/wiki/browse']);
    expect(await (await worker.caches.match('/wiki/browse', { cacheName: DOCS }))?.text()).toContain('lang="en"');
  });

  it('steps through a comparison’s levels on one copy of the category page', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('<p>list</p>')) });
    for (const tab of ['1', '2', '3']) {
      await worker.message(shown(`/wiki/c/Weapons?view=compare&tab=${tab}`));
    }
    expect(worker.requests.map((r) => new URL(r.url).pathname + new URL(r.url).search)).toEqual(['/wiki/c/Weapons']);
    expect([...(worker.caches.stores.get(DOCS)?.entries.keys() ?? [])]).toEqual([`${ORIGIN}/wiki/c/Weapons`]);
  });

  it('keeps a view a page load opened as it passes, and the category page itself once it is shown', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('<p>list</p>')) });
    await worker.dispatch(req('/wiki/c/Weapons?view=compare&tab=2', { mode: 'navigate' }));
    await worker.message(shown('/wiki/c/Weapons?view=compare&tab=2'));
    // One render more than the page load, for the copy every view shares.
    expect(worker.requests.map((r) => new URL(r.url).pathname + new URL(r.url).search)).toEqual([
      '/wiki/c/Weapons?view=compare&tab=2',
      '/wiki/c/Weapons',
    ]);
    expect([...(worker.caches.stores.get(DOCS)?.entries.keys() ?? [])]).toEqual([
      `${ORIGIN}/wiki/c/Weapons?view=compare&tab=2`,
      `${ORIGIN}/wiki/c/Weapons`,
    ]);
  });

  it('keeps one copy of the planner, without a list in it, however many share links are opened', async () => {
    const worker = loadWorker({ fetch: async () => basic(html('<p>planner</p>')) });
    await worker.message(shown(`/wiki/craft?${SHARE_PARAM}=SwordIron.4.0.1`));
    await worker.message(shown(`/wiki/craft?${SHARE_PARAM}=Karve.1.0.1`));
    // The planner cleans its address once the reader has decided.
    await worker.message(shown('/wiki/craft'));
    expect(worker.requests.map((r) => new URL(r.url).pathname + new URL(r.url).search)).toEqual(['/wiki/craft']);
    expect([...(worker.caches.stores.get(DOCS)?.entries.keys() ?? [])]).toEqual([`${ORIGIN}/wiki/craft`]);
  });

  it('takes no background copy while the browser is saving data', async () => {
    const worker = loadWorker({
      fetch: async () => basic(html('<p>doc</p>')),
      navigator: { connection: { saveData: true } },
    });
    await worker.message(shown('/wiki/browse'));
    expect(worker.requests).toHaveLength(0);
  });
});

/*
 * Each route loads its own stylesheet, and only the first time the page shows
 * that route: one that loaded before the worker took the page over, or that
 * the page already had, never passes through the worker. The background copy
 * of a page brings the stylesheets it links, or it opens offline unstyled.
 */
describe('service worker background copies and their stylesheets', () => {
  /** An article as Next renders it: route stylesheets in the head and in the RSC payload, scripts. */
  const ARTICLE =
    '<!DOCTYPE html><html lang="es"><head>' +
    '<link rel="stylesheet" href="/_next/static/chunks/global-a1.css" data-precedence="next"/>' +
    '<link rel="stylesheet" href="/_next/static/chunks/route-b2.css" data-precedence="next"/>' +
    '<script src="/_next/static/chunks/app-c3.js" async=""></script></head><body><main>espada</main>' +
    '<script>self.__next_f.push([1,":HL[\\"/_next/static/chunks/route-d4.css\\",\\"style\\"]"])</script>' +
    '</body></html>';
  const STYLESHEETS = [
    '/_next/static/chunks/global-a1.css',
    '/_next/static/chunks/route-b2.css',
    '/_next/static/chunks/route-d4.css',
  ];

  /** The site: `ARTICLE` for any page, and every hashed file as a production build serves it. */
  function site({
    cacheControl = 'public, max-age=31536000, immutable',
    page = () => basic(html(ARTICLE)),
    asset = (url: URL) => basic(new Response(`/* ${url.pathname} */`, { status: 200, headers: { 'cache-control': cacheControl } })),
  }: { cacheControl?: string; page?: () => Response; asset?: (url: URL) => Response } = {}): FetchImpl {
    return async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
      return url.pathname.startsWith('/_next/static/') ? asset(url) : page();
    };
  }

  const shown = (path: string) => ({ type: 'shown', path });
  const fetched = (worker: ReturnType<typeof loadWorker>) => worker.requests.map((r) => new URL(r.url).pathname);

  it('keeps the stylesheets the copied page links, so the copy opens styled offline', async () => {
    const worker = loadWorker({ fetch: site() });
    await worker.message(shown('/wiki/a/iron-sword'));
    expect(worker.caches.has(DOCS, '/wiki/a/iron-sword')).toBe(true);
    for (const sheet of STYLESHEETS) expect(worker.caches.has(STATIC, sheet), sheet).toBe(true);
    // A saved page reads without its scripts: they are not fetched for it.
    expect(fetched(worker)).not.toContain('/_next/static/chunks/app-c3.js');
    expect(worker.caches.has(STATIC, '/_next/static/chunks/app-c3.js')).toBe(false);

    // Offline, after the worker was stopped: the copy, and its stylesheet from the cache.
    const offline = loadWorker({ caches: worker.caches });
    const page = await offline.dispatch(req('/wiki/a/iron-sword', { mode: 'navigate' }));
    expect(await page?.text()).toContain('espada');
    const sheet = await offline.dispatch(req('/_next/static/chunks/route-b2.css', { headers: { 'sec-fetch-dest': 'style' } }));
    expect(sheet?.status).toBe(200);
    expect(await sheet?.text()).toBe('/* /_next/static/chunks/route-b2.css */');
  });

  it('fetches only the stylesheets it does not hold yet', async () => {
    const worker = loadWorker({ fetch: site() });
    await (await worker.caches.open(STATIC)).put(
      '/_next/static/chunks/global-a1.css',
      basic(new Response('held', { status: 200, headers: { 'cache-control': 'public, max-age=31536000, immutable' } })),
    );
    await worker.message(shown('/wiki/a/iron-sword'));
    expect(fetched(worker)).toEqual(['/wiki/a/iron-sword', '/_next/static/chunks/route-b2.css', '/_next/static/chunks/route-d4.css']);

    // Another article of the same route: its page only.
    await worker.message(shown('/wiki/a/bronze-sword'));
    expect(fetched(worker).slice(3)).toEqual(['/wiki/a/bronze-sword']);
    expect(await (await worker.caches.match('/_next/static/chunks/global-a1.css', { cacheName: STATIC }))?.text()).toBe('held');
  });

  it('keeps no stylesheet the server does not mark immutable, as on the dev server', async () => {
    const worker = loadWorker({ fetch: site({ cacheControl: 'no-cache, must-revalidate' }) });
    await worker.message(shown('/wiki/a/iron-sword'));
    expect(worker.caches.has(DOCS, '/wiki/a/iron-sword')).toBe(true);
    for (const sheet of STYLESHEETS) expect(worker.caches.has(STATIC, sheet), sheet).toBe(false);
  });

  it('keeps the page when a stylesheet cannot be fetched, and the others', async () => {
    const worker = loadWorker({
      fetch: site({
        asset: (url) => {
          if (url.pathname.endsWith('route-b2.css')) throw new TypeError('Failed to fetch');
          return basic(new Response('css', { status: 200, headers: { 'cache-control': 'public, max-age=31536000, immutable' } }));
        },
      }),
    });
    await worker.message(shown('/wiki/a/iron-sword'));
    expect(worker.caches.has(DOCS, '/wiki/a/iron-sword')).toBe(true);
    expect(worker.caches.has(STATIC, '/_next/static/chunks/route-b2.css')).toBe(false);
    expect(worker.caches.has(STATIC, '/_next/static/chunks/route-d4.css')).toBe(true);
  });

  it('fetches no stylesheet for a page it does not keep, or while its copy is recent', async () => {
    const missing = loadWorker({ fetch: site({ page: () => basic(html(ARTICLE, { status: 404 })) }) });
    await missing.message(shown('/wiki/a/nope'));
    expect(fetched(missing)).toEqual(['/wiki/a/nope']);

    const recent = loadWorker({ fetch: site() });
    await (await recent.caches.open(DOCS)).put(
      '/wiki/a/iron-sword',
      html(ARTICLE, { headers: { 'content-type': 'text/html', 'x-wv-saved-at': String(Date.now()) } }),
    );
    await recent.message(shown('/wiki/a/iron-sword'));
    expect(recent.requests).toHaveLength(0);
  });

  it('caps the stylesheets with the rest of the static cache', async () => {
    const worker = loadWorker({ fetch: site() });
    const statics = await worker.caches.open(STATIC);
    const old = basic(new Response('old', { status: 200, headers: { 'cache-control': 'public, max-age=31536000, immutable' } }));
    for (let i = 0; i < 300; i++) await statics.put(`/_next/static/chunks/old-${i}.js`, old.clone());
    await worker.message(shown('/wiki/a/iron-sword'));
    const keys = await statics.keys();
    expect(keys).toHaveLength(300);
    for (const sheet of STYLESHEETS) expect(worker.caches.has(STATIC, sheet), sheet).toBe(true);
    // The oldest go first.
    expect(worker.caches.has(STATIC, '/_next/static/chunks/old-0.js')).toBe(false);
  });
});

/*
 * The planner downloads the whole recipe graph once per page. Kept like the
 * title index: the copy answers at once, offline too, and every use fetches
 * the graph again behind it for the next one.
 */
describe('service worker recipe graph', () => {
  const graph = (version: string, status = 200) =>
    basic(new Response(JSON.stringify({ v: 1, version }), { status, headers: { 'content-type': 'application/json' } }));

  it('answers from its copy, refreshed by every use, and offline from the last one', async () => {
    let online = true;
    let version = 'a';
    const worker = loadWorker({
      fetch: async () => {
        if (!online) throw new TypeError('Failed to fetch');
        return graph(version);
      },
    });
    const use = async () => (await (await worker.dispatch(req(GRAPH_URL ?? '')))?.json()) as { version: string };

    // Nothing saved yet: the network answers, and the copy is kept.
    expect((await use()).version).toBe('a');
    // The wiki was ingested again: the copy answers, the new graph replaces it behind.
    version = 'b';
    expect((await use()).version).toBe('a');
    online = false;
    expect((await use()).version).toBe('b');
  });

  it('keeps no answer but a graph, so a server without one never takes the place of the copy', async () => {
    let status = 503;
    const worker = loadWorker({ fetch: async () => graph('a', status) });
    const first = await worker.dispatch(req(GRAPH_URL ?? ''));
    expect(first?.status).toBe(503);
    expect(worker.caches.has(SHELL, GRAPH_URL ?? '')).toBe(false);

    status = 200;
    await worker.dispatch(req(GRAPH_URL ?? ''));
    status = 503;
    expect((await worker.dispatch(req(GRAPH_URL ?? '')))?.status).toBe(200);
  });
});

describe('service worker assets and images', () => {
  it('serves immutable assets from the cache, and rebuilt ones from the network while online', async () => {
    let online = true;
    let build = 1;
    const worker = loadWorker({
      fetch: async (input) => {
        if (!online) throw new TypeError('Failed to fetch');
        const url = typeof input === 'string' ? input : input.url;
        const cacheControl = url.includes('prod') ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate';
        return basic(new Response(`build ${build}`, { status: 200, headers: { 'cache-control': cacheControl } }));
      },
    });
    await worker.dispatch(req('/_next/static/chunks/prod.js'));
    await worker.dispatch(req('/_next/static/chunks/dev.js'));
    expect(worker.caches.has(STATIC, '/_next/static/chunks/prod.js')).toBe(true);
    expect(worker.caches.has(STATIC, '/_next/static/chunks/dev.js')).toBe(true);

    // The dev server rebuilt the file under the same name: online, the new one wins.
    build = 2;
    const requestsBefore = worker.requests.length;
    expect(await (await worker.dispatch(req('/_next/static/chunks/prod.js')))?.text()).toBe('build 1');
    expect(worker.requests.length).toBe(requestsBefore);
    expect(await (await worker.dispatch(req('/_next/static/chunks/dev.js')))?.text()).toBe('build 2');

    // Offline, the last copy of either still renders the page.
    online = false;
    expect(await (await worker.dispatch(req('/_next/static/chunks/dev.js')))?.text()).toBe('build 2');
  });

  it('refetches a Fandom image in CORS mode with no referrer, and keeps only a real 200', async () => {
    const ok = 'https://static.wikia.nocookie.net/valheim/images/a/b/Iron.png/revision/latest?cb=1';
    const missing = 'https://static.wikia.nocookie.net/valheim/images/a/b/Gone.png/revision/latest?cb=1';
    const worker = loadWorker({
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        return new Response('img', { status: url === ok ? 200 : 404, headers: { 'content-type': 'image/webp' } });
      },
    });
    const first = await worker.dispatch(req(ok, { mode: 'no-cors', headers: { accept: 'image/avif,image/webp' } }));
    expect(first?.status).toBe(200);
    expect(worker.requests[0]).toMatchObject({ mode: 'cors', referrerPolicy: 'no-referrer', credentials: 'omit' });
    expect(worker.caches.has(IMAGES, ok)).toBe(true);

    await worker.dispatch(req(missing, { mode: 'no-cors' }));
    expect(worker.caches.has(IMAGES, missing)).toBe(false);

    // Second view: straight from the cache, no request.
    const before = worker.requests.length;
    await worker.dispatch(req(ok, { mode: 'no-cors' }));
    expect(worker.requests.length).toBe(before);
  });

  it('hands the page its own request when the CORS refetch is refused, storing nothing', async () => {
    const url = 'https://static.wikia.nocookie.net/valheim/images/a/b/Iron.png';
    let calls = 0;
    const worker = loadWorker({
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('CORS refused');
        return new Response('opaque', { status: 200 });
      },
    });
    const response = await worker.dispatch(req(url, { mode: 'no-cors' }));
    expect(await response?.text()).toBe('opaque');
    expect(worker.caches.has(IMAGES, url)).toBe(false);
  });
});
