/**
 * When a reader page fetches another one ahead of the tap: the rules, and the
 * clock that tells a pointer resting on a link from one passing over it.
 *
 * Kept free of the DOM and of React, so both can be tested on their own;
 * `IntentPrefetch` reads the events and the links, and asks these.
 */

/**
 * How long a pointer, or the keyboard's focus, has to stay on a link before
 * its page is fetched. Long enough that a pointer crossing a list on its way
 * somewhere else, or Tab held down through it, fetches nothing; short enough
 * to be well ahead of a click, which comes a few hundred milliseconds after
 * the pointer settles.
 */
export const REST_MS = 65;

/**
 * How long a page fetched from here counts as fetched: until then, intent on
 * its link asks the router for nothing; after it, the next intent asks again.
 *
 * The router keeps a full prefetch for `staleTimes.static`, counted from when
 * its answer arrives: five minutes here, and never less than 30 seconds
 * whatever the config (`STATIC_STALETIME_MS`,
 * next/dist/client/components/router-reducer/reducers/navigate-reducer.js).
 * Asking again while its copy is fresh, or still on its way, costs no
 * request: its scheduler finds the copy and sends nothing. Asking once the
 * copy has expired fetches the page anew. So the tracker waits the least
 * time the router ever keeps a copy: it never takes a page for fetched more
 * than 30 seconds after the router dropped it, and asks the router at most
 * twice a minute per page.
 *
 * A refresh drops every copy at once (a language switch, a finished
 * translation). The router says so (`forget`, from `onInvalidate`), and the
 * page is forgotten then and there.
 */
export const REMEMBER_MS = 30_000;

/**
 * What a link says about where it goes: its `href` as written, `target`
 * (`''` when absent), `download`, and whether the page marks it as the page
 * on screen (`aria-current="page"`).
 */
export type LinkFacts = {
  href: string | null;
  target: string;
  download: boolean;
  current: boolean;
};

/**
 * The part of `navigator.connection` read here. Chromium has it; Safari and
 * Firefox do not, and a browser that says nothing is not held back.
 */
export type NetworkHints = {
  saveData?: boolean;
  effectiveType?: string;
};

/** The pages that count as fetched already; a `Set` of them will do. */
export type Fetched = { has(page: string): boolean };

/** A reader who asked the browser to save data, or one on 2G: they pay for every byte, and wait for it. */
export function isConstrained(network: NetworkHints | null | undefined): boolean {
  if (!network) return false;
  return network.saveData === true || network.effectiveType === 'slow-2g' || network.effectiveType === '2g';
}

const ARTICLE = /^\/wiki\/a\/[^/]+$/;
const CATEGORY = /^\/wiki\/c\/[^/]+$/;
const READER_PAGES = new Set(['/wiki/browse', '/wiki/guide']);

/**
 * The pages worth fetching ahead: an article, a list (a category, a facet, a
 * comparison), browse, the guide, and search results (`/wiki?q=`).
 *
 * Nothing else. The chat and the sign-in page are per reader, and heavy; the
 * API is not a page; and an address none of these routes has would only
 * fetch a not-found page or a redirect.
 */
export function isReaderPage(url: URL): boolean {
  const path = url.pathname;
  if (ARTICLE.test(path) || CATEGORY.test(path) || READER_PAGES.has(path)) return true;
  return path === '/wiki' && (url.searchParams.get('q') ?? '').trim() !== '';
}

/**
 * The page a link's prefetch would fetch, as the router keys it (path and
 * query, no fragment), or `null` when it should fetch nothing:
 *
 * - on a connection that asked to save data, or a 2G one (`isConstrained`);
 * - for a link the browser follows somewhere else (another `target`) or
 *   saves (`download`): no navigation here would use what was fetched;
 * - for another site, or anything that is not a reader page (`isReaderPage`);
 * - for the page on screen, or a place on it (`#…`), and for a link the page
 *   marks as the one on screen under another address: "Nivel 1" on a
 *   comparison opened without a level is the same view as the page;
 * - for a page fetched already (`fetched`).
 *
 * `here` is the page's absolute address, which a relative `href` resolves against.
 */
export function prefetchTarget(
  link: LinkFacts,
  here: string,
  network: NetworkHints | null | undefined,
  fetched: Fetched,
): string | null {
  if (isConstrained(network)) return null;
  if (link.href === null || link.download || link.current) return null;
  const target = link.target.toLowerCase();
  if (target !== '' && target !== '_self') return null;

  let from: URL;
  let to: URL;
  try {
    from = new URL(here);
    to = new URL(link.href, from);
  } catch {
    return null;
  }
  if (to.origin !== from.origin || !isReaderPage(to)) return null;

  const page = to.pathname + to.search;
  if (page === from.pathname + from.search || fetched.has(page)) return null;
  return page;
}

/** A link as the tracker sees it: something that identifies it (the element), and its facts. */
export type TrackedLink = { key: unknown; facts: LinkFacts };

/** Where the reader is, and on what connection; read afresh for every decision. */
export type IntentContext = () => { here: string; network: NetworkHints | null | undefined };

/**
 * The router's `prefetch`, as the tracker calls it: the page, and `forget`,
 * for the router to call when it drops what it fetched for it.
 */
export type Prefetch = (page: string, forget: () => void) => void;

export type IntentTracker = {
  /** A pointer, or the keyboard's focus, arrived on a link: fetch its page if it stays `REST_MS`. */
  rest(link: TrackedLink): void;
  /** The pointer or the focus left that link: whatever was waiting for it is dropped. */
  leave(key: unknown): void;
  /** A finger or a button came down on a link: fetch its page now. */
  now(link: TrackedLink): void;
  /** A click: the page is on its way, and a prefetch after it would only fetch it twice. */
  cancel(): void;
  /** Starts fetching through `prefetch` (the router's); until then, nothing is fetched or remembered. */
  connect(prefetch: Prefetch): void;
  /** Stops: drops whatever was waiting, and fetches nothing more. */
  disconnect(): void;
};

export type TrackerOptions = {
  /** How long a pointer or the focus must stay on a link (`REST_MS`). */
  restMs?: number;
  /** How long a page asked for counts as fetched (`REMEMBER_MS`). */
  rememberMs?: number;
  /** The time, in milliseconds; the router's own clock, `Date.now`, unless a test brings its own. */
  clock?: () => number;
};

/**
 * One page's intent: which link a pointer or the focus is resting on, and
 * which pages this page has had fetched. One wait at a time, as there is one
 * pointer; the focus shares it, and whichever moved last wins.
 *
 * Every decision is `prefetchTarget`'s, taken when the intent starts and again
 * when the wait is over, since the page on screen or the connection may have
 * changed in between.
 *
 * A page is asked for once, and then again only once the router may no
 * longer hold it: when the router says it dropped it (`forget`), or
 * `rememberMs` after it was last asked for. The wrapper outlives what the
 * router keeps: it stays on screen through a refresh, and through the
 * changes of address a list makes to itself (its view, its level, a query).
 * A prefetch that throws counts as not made, and the next intent tries again.
 */
export function createIntentTracker(
  context: IntentContext,
  { restMs = REST_MS, rememberMs = REMEMBER_MS, clock = () => Date.now() }: TrackerOptions = {},
): IntentTracker {
  /** Each page asked for, with when. An entry is replaced, never changed, so a late `forget` can tell. */
  const asked = new Map<string, { at: number }>();
  const fetched: Fetched = {
    has(page) {
      const entry = asked.get(page);
      if (entry === undefined) return false;
      if (clock() - entry.at < rememberMs) return true;
      asked.delete(page);
      return false;
    },
  };
  let prefetch: Prefetch | null = null;
  let waiting: { key: unknown; facts: LinkFacts; timer: ReturnType<typeof setTimeout> } | null = null;

  const target = (facts: LinkFacts): string | null => {
    if (!prefetch) return null;
    const { here, network } = context();
    return prefetchTarget(facts, here, network, fetched);
  };

  const fetchPage = (facts: LinkFacts): void => {
    const page = target(facts);
    const port = prefetch;
    if (page === null || port === null) return;
    const entry = { at: clock() };
    asked.set(page, entry);
    // Only this ask's own entry: the router may report on an earlier one after the page was asked for again.
    const forget = (): void => {
      if (asked.get(page) === entry) asked.delete(page);
    };
    try {
      port(page, forget);
    } catch {
      // A prefetch is an optimisation: the tap still navigates without it.
      forget();
    }
  };

  const drop = (): void => {
    if (waiting) clearTimeout(waiting.timer);
    waiting = null;
  };

  return {
    rest(link) {
      if (waiting?.key === link.key) return;
      drop();
      if (target(link.facts) === null) return;
      const timer = setTimeout(() => {
        waiting = null;
        fetchPage(link.facts);
      }, restMs);
      waiting = { key: link.key, facts: link.facts, timer };
    },
    leave(key) {
      if (waiting?.key === key) drop();
    },
    now(link) {
      if (waiting?.key === link.key) drop();
      fetchPage(link.facts);
    },
    cancel: drop,
    connect(next) {
      prefetch = next;
    },
    disconnect() {
      drop();
      prefetch = null;
    },
  };
}
