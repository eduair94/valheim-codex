'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useStrings } from '@/components/shell/lang-context';
import { linkNavigation, linkToPageOnScreen, type Activation, type LinkFacts } from '@/components/shell/nav-pending';
import { navigationStarted } from '@/components/shell/nav-tracker';
import type { TitleIndexEntry } from '@/lib/db/wiki-repo';
import {
  expandIcon,
  prepareTitleIndex,
  searchTitles,
  type PreparedTitleIndex,
  type TitleMatch,
} from '@/lib/wiki/title-search';
import { FANDOM_IMG_PROPS, thumbnailImageUrl } from '@/lib/wiki/image-url';
import type { Lang } from '@/lib/i18n/strings';
import { termLabel } from '@/lib/i18n/terms';
import { isMaintenanceCategory } from '@/lib/wiki/browse-groups';
import { fold } from '@/lib/wiki/slug';
import { articleHref } from '@/lib/routes';
import { IntentPrefetch } from './article/intent-prefetch';

type ContentHit = {
  slug: string;
  title: string;
  sectionPath: string;
  snippet: string;
  name?: string;
  snippetLang?: Lang;
};

/** Below this, a content search matches too much to be worth the request. */
const MIN_CONTENT_QUERY = 3;

/** Typing pauses this long before the text search is asked. */
const CONTENT_DEBOUNCE_MS = 250;

/**
 * And this long before the address bar follows, so typing does not write it
 * per key. Following a link writes it at once (`writeUrl`), whatever is left
 * of the pause.
 */
const URL_DEBOUNCE_MS = 300;

/**
 * The title index, once downloaded, for as long as the page lives.
 *
 * Module scope rather than state, because the search unmounts whenever the
 * reader opens a result: coming Back remounts it, and a fresh `null` there
 * meant a second download and a moment of "no results" before the restored
 * query could be answered. Held here, the restored list renders in the first
 * frame after Back.
 *
 * Versioned (`v=2`): the payload changed shape, and a service worker or a CDN
 * still holding the old one must not hand it to this code.
 */
const INDEX_URL = '/api/wiki/index?v=2';

/**
 * The original list, which the service worker stores when it installs.
 * Offline, before any visit has stored the current list, it is the only one
 * there is: English names and full icon URLs, both of which the matcher still
 * reads, so the search keeps working rather than failing outright.
 */
const FALLBACK_INDEX_URL = '/api/wiki/index';

let loadedIndex: PreparedTitleIndex | null = null;
let loadingIndex: Promise<PreparedTitleIndex> | null = null;
/** Whether `loadedIndex` is the fallback list, to be replaced once the network is back. */
let fallbackIndex = false;

async function fetchIndex(url: string): Promise<PreparedTitleIndex> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`index ${response.status}`);
  const data = (await response.json()) as { entries: TitleIndexEntry[] };
  return prepareTitleIndex(data.entries);
}

function loadIndex(): Promise<PreparedTitleIndex> {
  if (loadedIndex) return Promise.resolve(loadedIndex);
  loadingIndex ??= fetchIndex(INDEX_URL)
    .then(
      (index) => ({ index, fallback: false }),
      async () => ({ index: await fetchIndex(FALLBACK_INDEX_URL), fallback: true }),
    )
    .then(({ index, fallback }) => {
      loadedIndex = index;
      fallbackIndex = fallback;
      loadingIndex = null;
      return index;
    })
    .catch((error: unknown) => {
      // Let the next keystroke try again, rather than failing for the life of the page.
      loadingIndex = null;
      throw error;
    });
  return loadingIndex;
}

if (typeof window !== 'undefined') {
  // Back online after searching the fallback: the next focus or keystroke
  // fetches the current list, Spanish names and all. The fallback stays on
  // screen until it arrives.
  window.addEventListener('online', () => {
    if (fallbackIndex) loadedIndex = null;
  });
}

/**
 * A tap on a link to the page the router shows: this page's path, no
 * fragment, the router's query. The router has no change of address to make
 * for it, so nothing would tell the search, which takes the link's query
 * itself (`query`). Read in the capture phase, before the link's own handler.
 *
 * - The address bar shows that page too: the search tab, or the name in the
 *   nav, tapped while what is typed has not reached the address.
 * - The address bar holds a query the router has not seen, written past it
 *   as a result was followed or Enter pressed (`writeUrl`), and the tap
 *   abandons that result. The address goes back to the router's page first
 *   (`address`), so the two agree again: Next then replaces the entry rather
 *   than adding one with the abandoned query.
 *
 * `null` for any other click: one to another page, or not followed in this tab.
 */
export function linkToRouterPage(
  click: Activation,
  link: LinkFacts,
  here: string,
  router: { pathname: string; query: string },
): { query: string; address: string | null } | null {
  const navigation = linkNavigation(click, link, here);
  if (!navigation && !linkToPageOnScreen(click, link, here)) return null;
  const to = new URL(link.href, here);
  if (to.pathname !== router.pathname || to.hash !== '') return null;
  const query = to.searchParams.get('q') ?? '';
  if (!navigation) return { query, address: null };
  const written = new URL(here).searchParams.get('q') ?? '';
  return query === router.query && written !== router.query ? { query, address: `${to.pathname}${to.search}` } : null;
}

type Props = {
  lang: Lang;
  /**
   * The query the server rendered the page with (`?q=`). Hydration draws
   * what that HTML holds; the address leads from the next render on.
   */
  serverQuery: string;
  /**
   * What the page shows while nothing is typed: the ways in, for a reader
   * who has no word to type yet. The server renders it, once, and this only
   * places it. Drawn here instead, it was in the page's script and twice in
   * its HTML, for something with nothing interactive about it.
   */
  browse: ReactNode;
};

/*
 * Whether this render is the server's, or hydrates the server's HTML. Nothing
 * ever changes it, so nothing subscribes: once hydration is done, React
 * renders again with the browser's answer.
 */
const subscribeNever = (): (() => void) => () => {};
const inBrowser = (): boolean => false;
const onServer = (): boolean => true;

/**
 * Search, and — until something is typed — the way in for everyone who does
 * not yet have a word to type.
 *
 * Titles are matched in the browser against an index downloaded once: a
 * thousand entries filter in well under a frame, so results appear as you
 * type with no request and no spinner — and it keeps working offline. The
 * index is fetched when the reader shows an intent to search (focus, a
 * pointer over the field, a keystroke) or once the page is idle, not as the
 * page mounts: most visits to the front page browse, and the tiles' pictures
 * should not wait behind 35 KB of titles nobody asked for. The server is
 * asked only for the harder question, "the words are in the body, not the
 * name", and only once typing pauses.
 *
 * The query lives in the address bar (`?q=`), so Back from a result returns
 * to the same results and a search can be linked to — the nav's search box
 * sends readers here that way.
 *
 * An empty query used to render one grey sentence under the field, which asked
 * a visitor who had just arrived to already know the name of a Valheim item.
 * The browsing axes take that space instead: the search field still leads,
 * because someone who knows the word should not have to scroll past a menu to
 * use it, and everyone else now has somewhere to go. They are the server's
 * (`browse`): this draws them while nothing is typed, and drops them for the
 * results.
 */
export function SearchView({ lang, serverQuery, browse }: Props) {
  const t = useStrings(lang);
  const router = useRouter();
  const pathname = usePathname();

  /*
   * The address's query, with no Suspense boundary: the route is dynamic, so
   * the server has the address and `useSearchParams` answers there too. (Only
   * a prerendered route needs one, and its build fails without it.) The one
   * this had, with the whole search as its fallback, sent everything twice:
   * React streams a large boundary after its fallback, so the page came as a
   * copy, then again, hidden, to be swapped in at the end.
   *
   * Hydration draws the server's query, whatever the address holds by then.
   * The two differ when the service worker, offline, answers `/wiki?q=…`
   * with the `/wiki` it saved: drawn with the address's query, the first
   * render would not match that HTML, and React would throw the whole page
   * away to draw it again. The address's query comes one render later, as a
   * change of address.
   */
  const routerQuery = useSearchParams().get('q') ?? '';
  const hydrating = useSyncExternalStore(subscribeNever, inBrowser, onServer);
  const urlQuery = hydrating ? serverQuery : routerQuery;

  const [query, setQuery] = useState(urlQuery);
  const [index, setIndex] = useState<PreparedTitleIndex | null>(() => loadedIndex);
  const [indexFailed, setIndexFailed] = useState(false);
  const [result, setResult] = useState<{ q: string; lang: Lang; hits: ContentHit[]; ok: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLElement>(null);

  /*
   * The address bar changing under us — Back or Forward between two
   * searches, the search tab, a link to `/wiki?q=…` — replaces the query.
   * Adjusted during render, as React recommends for state derived from a
   * prop, rather than in an effect that would render twice.
   *
   * A change is the router's query moving from the one it showed last; what
   * the page wrote itself is not news when it comes back (`ownWrite`). It
   * used to be measured against what the page last wrote, and the router can
   * trail that: a write made as a result is followed reaches it only with
   * that navigation. Its old query then read as a change, went back into the
   * field, and the debounce wrote it to the address, which made Next drop
   * the navigation. The tap was lost.
   */
  const [seenUrlQuery, setSeenUrlQuery] = useState(urlQuery);
  /** The last query written through the router (`writeUrl`), until the router shows it. */
  const [ownWrite, setOwnWrite] = useState<string | null>(null);
  if (urlQuery !== seenUrlQuery) {
    setSeenUrlQuery(urlQuery);
    setOwnWrite(null);
    if (urlQuery !== ownWrite && urlQuery !== query.trim()) setQuery(urlQuery);
  }

  /*
   * Set when the page starts leaving for another address — a link followed,
   * Enter on a result — until the router shows a new one (a navigation that
   * lands elsewhere unmounts this first), or a tap on the page the router
   * shows calls the leaving off (`linkToRouterPage`). Meanwhile the address
   * is written past the router: see `writeUrl`.
   */
  const leaving = useRef(false);
  useEffect(() => {
    leaving.current = false;
  }, [urlQuery]);

  const requestIndex = (): void => {
    if (loadedIndex) return;
    void loadIndex().then(
      (loaded) => {
        setIndex(loaded);
        setIndexFailed(false);
      },
      () => setIndexFailed(true),
    );
  };

  const q = query.trim();

  // A query from the address — restored, or arriving after hydration — needs
  // the titles now; otherwise they wait for the page to go idle, or for the
  // reader to reach for the field.
  const wantsTitles = q !== '';
  useEffect(() => {
    if (loadedIndex) return;
    if (wantsTitles) {
      requestIndex();
      return;
    }
    const idle = (): void => requestIndex();
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    // Idle-callback ids and timer ids are separate number spaces: each is
    // cancelled with its own function, never the other's.
    let cancel: (() => void) | null = null;
    const schedule = (): void => {
      if (w.requestIdleCallback && w.cancelIdleCallback) {
        const id = w.requestIdleCallback(idle, { timeout: 4000 });
        cancel = () => w.cancelIdleCallback?.(id);
      } else {
        const id = window.setTimeout(idle, 2000);
        cancel = () => window.clearTimeout(id);
      }
    };
    if (document.readyState === 'complete') schedule();
    else window.addEventListener('load', schedule, { once: true });
    return () => {
      window.removeEventListener('load', schedule);
      cancel?.();
    };
    // Only when a query comes or goes: typing requests the index from its own handlers.
  }, [wantsTitles]);

  const matches = useMemo(() => (index && q ? searchTitles(index, q) : []), [index, q]);

  // Content search waits for a pause: it is a request per query, and while
  // someone is still typing the answer is about to be thrown away. The answer
  // is stored with the query it answers, so a slow reply to an old query can
  // never be shown under a new one, and a failed one is reported as failed
  // instead of leaving the previous query's hits on screen.
  useEffect(() => {
    if (q.length < MIN_CONTENT_QUERY) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/wiki/search?q=${encodeURIComponent(q)}&lang=${lang}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setResult({ q, lang, hits: [], ok: false });
          return;
        }
        const data = (await response.json()) as { hits?: ContentHit[] };
        if (controller.signal.aborted) return;
        setResult({ q, lang, hits: data.hits ?? [], ok: true });
      } catch {
        if (!controller.signal.aborted) setResult({ q, lang, hits: [], ok: false });
      }
    }, CONTENT_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, lang, attempt]);

  /**
   * Puts a query in the address bar, without a history entry and without a
   * request.
   *
   * Through the router while the page is not leaving: written with no state,
   * the write reaches Next's own `replaceState`, which takes it in as a
   * restore, so `useSearchParams` follows (`ownWrite` marks it as ours). The
   * router then has the query: a refresh (the language switch) keeps it, and
   * the search tab's link to `/wiki` is a change of address for this page
   * and for the progress bar.
   *
   * Past the router once the page is leaving, because a restore drops any
   * navigation still on its way, and the result just followed with it.
   * Written with the router's own state, Next lets the write through as it
   * is. The router does not see it, and does not need to: the navigation
   * adds the next page's entry after this one, and Back onto this one hands
   * the router the address as written.
   *
   * Only while the address is still this page's. A write that lands after a
   * link has been followed — the debounce firing between the next page's
   * history entry and this one unmounting — would give the article a `?q=`.
   */
  const writeUrl = useCallback(
    (value: string): void => {
      const url = new URL(window.location.href);
      if (url.pathname !== pathname) return;
      if ((url.searchParams.get('q') ?? '') === value) return;
      if (value) url.searchParams.set('q', value);
      else url.searchParams.delete('q');
      const address = `${url.pathname}${url.search}${url.hash}`;
      if (leaving.current) {
        window.history.replaceState(window.history.state, '', address);
      } else {
        setOwnWrite(value);
        window.history.replaceState(null, '', address);
      }
    },
    [pathname],
  );

  // The address bar follows the query once typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => writeUrl(q), URL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, writeUrl]);

  // A link followed before then — type "troll", tap the first row — would
  // leave the old address in history and Back would come back to an empty
  // search, so any link click writes it first: in the capture phase, before
  // the link's own handler has started the navigation. (Enter on a focused
  // result is a click too; Enter in the field writes it in `onSubmit`.)
  //
  // Except a link to the page the router shows (`linkToRouterPage`): the
  // search tab or the name in the nav, tapped before what is typed has
  // reached the address, or while a result followed in the meantime is on
  // its way. The router has no change of address to make there, so the
  // field goes to that page's query (none) here, and the page stops writing
  // past the router. Written first instead, the typed query would have made
  // the tap a new history entry, with the query still in the field; and
  // after a result, the field kept its query and every later write went past
  // the router, which the next tap on the tab could not clear either.
  useEffect(() => {
    const beforeFollowing = (event: MouseEvent): void => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      const here = window.location.href;
      const facts = { href: link.href, target: link.target, download: link.hasAttribute('download') };
      const stay = linkToRouterPage(event, facts, here, { pathname, query: urlQuery });
      if (stay) {
        leaving.current = false;
        setQuery(stay.query);
        // A write through the router still on its way never shows now: the
        // link's navigation takes the router past it, and it must not be
        // taken for this page's own when it next turns up.
        setOwnWrite(null);
        // With the router's own state: it shows this page already.
        if (stay.address !== null) window.history.replaceState(window.history.state, '', stay.address);
        return;
      }
      if (linkNavigation(event, facts, here)) leaving.current = true;
      writeUrl(q);
    };
    document.addEventListener('click', beforeFollowing, true);
    return () => document.removeEventListener('click', beforeFollowing, true);
  }, [q, urlQuery, pathname, writeUrl]);

  const answered = result !== null && result.q === q && result.lang === lang;
  const contentPending = q.length >= MIN_CONTENT_QUERY && !answered;
  const contentFailed = answered && !result.ok;
  const titlesPending = q !== '' && index === null && !indexFailed;

  const titleSlugs = new Set(matches.map((m) => m.entry.s));
  const extraHits = answered && result.ok ? result.hits.filter((h) => !titleSlugs.has(h.slug)) : [];

  // Text matches that arrive before the titles: shown, since they are
  // results, but not yet as "found in the text" — until the titles are in,
  // nothing says which of them are really name matches, and those move up
  // into the name list when it lands.
  const provisional = titlesPending && extraHits.length > 0;

  const found = matches.length + extraHits.length;
  const settled = !titlesPending && !contentPending;
  const nothing = settled && found === 0 && !contentFailed;

  // A count for screen readers, never a copy of the sentence on screen: one
  // message read twice is noise, and the count is what changes per keystroke.
  const announcement =
    q === ''
      ? ''
      : !settled && found === 0
        ? t.searchLoading
        : found === 1
          ? t.searchResultsOne
          : t.searchResultsMany.replace('{n}', String(found));

  const results = (): HTMLAnchorElement[] =>
    Array.from(resultsRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-result]') ?? []);

  /** ArrowDown from the field enters the results; Enter opens the first one. */
  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      const first = results()[0];
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  /**
   * Up and down move between results, Escape goes back to the field, and a
   * typed character goes to the field too, so reaching into the list never
   * strands the reader away from their query.
   */
  const onResultsKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const links = results();
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at === -1) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? links[at + 1] : links[at - 1];
      if (next) next.focus();
      else if (event.key === 'ArrowUp') inputRef.current?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      inputRef.current?.focus();
    } else if ((event.key.length === 1 || event.key === 'Backspace') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      inputRef.current?.focus();
    }
  };

  const firstHref = matches[0] ? articleHref(matches[0].entry.s) : extraHits[0] ? articleHref(extraHits[0].slug) : null;

  // Side by side on a wide screen — names on the left, text matches on the
  // right — when there is something in both; stacked otherwise.
  const contentColumn = extraHits.length > 0 || contentFailed || (contentPending && matches.length > 0);
  const twoColumns = matches.length > 0 && contentColumn;

  return (
    <div>
      {/*
       * Sticky under whatever covers the top of the viewport (`--nav-h`, set
       * by the shell: the nav from 640px up, and the status bar an installed
       * app draws over the page). The background reaches the viewport's edges,
       * and up over that status bar, without widening the layout. The style
       * tells the shell how tall the bar is (`--sticky-h`), so focus and
       * anchors elsewhere on the page stop below it too.
       *
       * Not sticky on a screen 480px tall or less (a phone on its side):
       * there the nav and the field together covered a third of the height,
       * and with the keyboard up almost nothing was left for the results.
       */}
      <style href="wiki-search-sticky" precedence="medium">
        {'html:has(#wiki-search){--sticky-h:4.5rem}@media (max-height:480px){html:has(#wiki-search){--sticky-h:0px}}'}
      </style>
      <div className="sticky top-(--nav-h,0px) z-20 bg-bog pt-1 pb-3 shadow-[0_0_0_100vmax_var(--color-bog)] [clip-path:inset(calc(-1*env(safe-area-inset-top,0px))_-100vmax_0_-100vmax)] [@media(max-height:480px)]:static">
        {/*
         * No `action`: before the page's script runs (or without it) the form
         * is a plain GET to this page, `?q=` and all, which renders the
         * search for it. Once hydrated, Enter opens the first result.
         */}
        <form
          role="search"
          className="max-w-2xl"
          onSubmit={(event) => {
            event.preventDefault();
            if (!firstHref) return;
            // The address first, or Back from the result finds an empty
            // search; past the router, which is about to navigate.
            leaving.current = true;
            writeUrl(q);
            // No tap on a link for the progress bar to see: it is told.
            navigationStarted(firstHref);
            router.push(firstHref);
          }}
        >
          <label htmlFor="wiki-search" className="sr-only">
            {t.wikiSearchPlaceholder}
          </label>
          <input
            id="wiki-search"
            name="q"
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              requestIndex();
            }}
            onFocus={requestIndex}
            onPointerEnter={requestIndex}
            onKeyDown={onInputKeyDown}
            placeholder={t.wikiSearchPlaceholder}
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full rounded-md border border-moss bg-peat px-4 py-3 text-[1rem] text-birch transition-colors placeholder:text-ash focus:border-forge/50 focus:outline-none"
          />
        </form>
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {q === '' ? (
        <div className="mt-3">{browse}</div>
      ) : (
        // A result fetches its article once the reader points at, touches or
        // tabs to it; none does on sight (`prefetch={false}` on the rows).
        <IntentPrefetch
          as="div"
          ref={resultsRef}
          role="region"
          aria-label={t.searchResultsLabel}
          aria-busy={!settled}
          onKeyDown={onResultsKeyDown}
          className={`mt-3 flex flex-col gap-6 ${twoColumns ? 'lg:grid lg:grid-cols-2 lg:items-start lg:gap-8' : ''}`}
        >
          {indexFailed ? <p className="text-sm text-ash">{t.searchIndexFailed}</p> : null}

          {/* Nothing to show yet, and not "no results": one of the searches is still out. */}
          {!settled && found === 0 ? <Pending label={t.searchLoading} /> : null}
          {provisional ? <Pending label={t.searchLoadingTitles} /> : null}

          {matches.length > 0 ? (
            <section>
              {twoColumns ? <h2 className="label mb-2">{t.searchByName}</h2> : null}
              <ul className={`flex flex-col ${twoColumns ? '' : 'max-w-2xl'}`}>
                {matches.map((match) => (
                  <li key={match.entry.s}>
                    <TitleRow match={match} lang={lang} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {contentColumn ? (
            <section className={twoColumns ? '' : 'max-w-2xl'}>
              {extraHits.length > 0 ? (
                <>
                  {provisional ? null : <h2 className="label mb-2">{t.wikiInContent}</h2>}
                  <ul className="flex flex-col">
                    {extraHits.map((hit) => (
                      <li key={hit.slug}>
                        <ContentRow hit={hit} lang={lang} />
                      </li>
                    ))}
                  </ul>
                </>
              ) : contentFailed ? (
                <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ash">
                  {t.searchContentFailed}
                  <button
                    type="button"
                    onClick={() => {
                      setResult(null);
                      setAttempt((n) => n + 1);
                    }}
                    className="min-h-11 rounded-md border border-moss px-3 text-birch transition-colors hover:border-forge/50 pointer-fine:min-h-9"
                  >
                    {t.retry}
                  </button>
                </p>
              ) : (
                <Pending label={t.searchLoadingContent} />
              )}
            </section>
          ) : null}

          {nothing ? (
            <p className="text-sm text-ash">
              {t.wikiNoResults}{' '}
              <Link href="/wiki/browse" prefetch={false} className="text-birch underline decoration-forge/50 underline-offset-4 hover:decoration-forge">
                {t.searchBrowseLink}
              </Link>
            </p>
          ) : null}
        </IntentPrefetch>
      )}
    </div>
  );
}

/** A quiet "still working": the app's ember, which already means "waiting for an answer". */
function Pending({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-ash">
      <span aria-hidden="true" className="flex gap-1">
        <span className="ember" />
        <span className="ember" />
        <span className="ember" />
      </span>
      {label}
    </p>
  );
}

/** A label without its plural, so the type "Metal" and the category "Metales" count as one. */
function singular(label: string): string {
  return fold(label)
    .replace(/ces$/, 'z')
    .replace(/([^aeiou])es$/, '$1')
    .replace(/s$/, '');
}

/**
 * The type and categories under a result, each named once: "Mobiliario ·
 * Fuegos", not "Furniture · Furniture · Fires". Never the wiki's bookkeeping
 * ("Unfinished"), which the fallback list still carries.
 */
function metaLine(entry: TitleIndexEntry, lang: Lang): string {
  const labels = [
    ...(entry.y ? [termLabel('type', entry.y, lang)] : []),
    ...entry.c.filter((c) => !isMaintenanceCategory(c)).map((c) => termLabel('category', c, lang)),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    const key = singular(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length === 3) break;
  }
  return out.join(' · ');
}

/**
 * A result's link: at least 48 px tall, so a thumb hits one row and not the
 * next, and kept clear of the sticky field when the keyboard focuses it.
 */
const ROW = 'min-h-12 scroll-mt-32 rounded-md px-2 py-2 transition-colors hover:bg-peat focus-visible:bg-peat';

function TitleRow({ match, lang }: { match: TitleMatch; lang: Lang }) {
  const { entry } = match;
  // In Spanish the Spanish name leads and the English one follows, so a
  // reader who knows either recognises the row.
  const spanish = lang === 'es' && entry.e ? entry.e : null;
  const meta = metaLine(entry, lang);

  return (
    <Link href={articleHref(entry.s)} prefetch={false} data-result className={`${ROW} flex items-center gap-3`}>
      <Icon icon={entry.i} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.95rem] leading-snug text-birch">
          {spanish ? (
            <>
              {spanish}
              <span lang="en" className="ml-2 text-xs text-ash">
                {entry.t}
              </span>
            </>
          ) : (
            <span lang={lang === 'es' ? 'en' : undefined}>{entry.t}</span>
          )}
        </span>
        {meta ? <span className="block truncate font-mono text-xs leading-snug text-ash">{meta}</span> : null}
      </span>
    </Link>
  );
}

/**
 * A match inside an article's text. Its snippet can quote a console command or
 * a URL ("export LD_LIBRARY_PATH=./linux64:…"), so a word too long for the row
 * breaks instead of widening the page on a narrow phone (320px).
 */
function ContentRow({ hit, lang }: { hit: ContentHit; lang: Lang }) {
  const spanish = lang === 'es' && hit.name ? hit.name : null;
  return (
    <Link href={articleHref(hit.slug)} prefetch={false} data-result className={`${ROW} block`}>
      <span className="block min-w-0">
        <span className="block truncate text-[0.95rem] leading-snug text-birch">
          {spanish ? (
            <>
              {spanish}
              <span lang="en" className="ml-2 text-xs text-ash">
                {hit.title}
              </span>
            </>
          ) : (
            <span lang={lang === 'es' ? 'en' : undefined}>{hit.title}</span>
          )}
        </span>
        <span
          lang={hit.snippetLang && hit.snippetLang !== lang ? hit.snippetLang : undefined}
          className="mt-1 block text-[0.8125rem] leading-snug wrap-break-word text-ash"
        >
          <Snippet text={hit.snippet} />
        </span>
      </span>
    </Link>
  );
}

/**
 * The result's picture, on a plate that keeps the row aligned when there is
 * none or Fandom fails to serve it.
 */
function Icon({ icon }: { icon: string | undefined }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-moss bg-peat">
      {icon ? (
        // Hotlinked from Fandom's CDN at the size it is drawn; not `next/image`.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          {...FANDOM_IMG_PROPS}
          src={thumbnailImageUrl(expandIcon(icon), 28)}
          alt=""
          width={28}
          height={28}
          loading="lazy"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
          className="h-7 w-7 object-contain"
        />
      ) : (
        <span aria-hidden="true" className="text-xs text-ash">
          ᛚ
        </span>
      )}
    </span>
  );
}

/**
 * Renders the `«…»` markers Postgres puts around matched words.
 *
 * Delimiters rather than HTML, so a snippet is inert text all the way from the
 * database to the DOM and cannot inject markup.
 */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/(«[^»]*»)/).map((part, i) =>
        part.startsWith('«') && part.endsWith('»') ? (
          <mark key={i} className="bg-transparent font-medium text-forge">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
