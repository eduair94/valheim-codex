'use client';

import { createElement, useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
// None is exported from a public entry point; `useRouter()`'s own type is built from them.
import type { AppRouterInstance, PrefetchOptions } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PrefetchKind } from 'next/dist/client/components/router-reducer/router-reducer-types';
import {
  createIntentTracker,
  type IntentContext,
  type IntentTracker,
  type LinkFacts,
  type NetworkHints,
} from './intent-prefetch-model';

/**
 * `router.prefetch`'s options for a page the reader is about to open: all of
 * it, and word of when the router drops it.
 *
 * All of it (`PrefetchKind.FULL`): the request a tap on the link makes, which
 * renders the page's new segments and reads their data. A plain
 * `router.prefetch(href)` only fetches what lies above the route's loading
 * boundary, and the reader pages have none. For them it brings the route's
 * shape, unless the router knows it already, and the page's `<head>`, in a
 * request for the metadata alone (which runs `generateMetadata`: for an
 * article, a database read), but never the layout or the page itself: a tap
 * after it still waits for the server.
 *
 * `onInvalidate` is the router's word that it dropped what it fetched (a
 * refresh: a language switch, a finished translation), after which intent
 * on the link asks again.
 */
export function fullPrefetch(onInvalidate: () => void): PrefetchOptions {
  return { kind: PrefetchKind.FULL, onInvalidate };
}

/** The element the wrapper is. */
type IntentElement = 'article' | 'div' | 'section' | 'ul' | 'ol' | 'nav' | 'aside' | 'main';

const HANDLERS = ['onPointerOver', 'onPointerOut', 'onPointerDown', 'onTouchStart', 'onFocus', 'onBlur', 'onClick'] as const;

type Handlers = Required<Pick<React.DOMAttributes<HTMLElement>, (typeof HANDLERS)[number]>>;

type IntentPrefetchProps = React.HTMLAttributes<HTMLElement> & {
  /** Which element to render; `article` for an article, where it started. */
  as?: IntentElement;
  ref?: React.Ref<HTMLElement>;
  children?: React.ReactNode;
};

/**
 * An element whose links fetch their page as soon as the reader shows they
 * are about to open one, rather than when they come into view.
 *
 * A list or an article names dozens of other pages, and prefetching every
 * link in view cost a request and a database query for each before anyone
 * tapped anything (PERF-03); their links are rendered with `prefetch={false}`.
 * This one set of listeners, on the whole element, fetches a link's page:
 *
 * - when a pointer rests on the link for `REST_MS` (65 ms), not when it only
 *   passes over it on its way somewhere else;
 * - at once when a finger lands on it (`touchstart`) or a mouse button comes
 *   down on it, about a tenth of a second before the click;
 * - when the keyboard's focus stays on it for `REST_MS`, so that Tab held
 *   down through a list of rows fetches none of them.
 *
 * Only reader pages, never the page on screen, and nothing for a reader who
 * asked the browser to save data or is on 2G (the rules: `prefetchTarget`,
 * intent-prefetch-model.ts).
 *
 * The prefetch is a full one (`fullPrefetch`): the reader pages are dynamic
 * and have no loading boundary, and a default prefetch of such a route
 * brings the page's `<head>` and nothing of its body. A full one is the
 * request a tap would make: the route's new segments rendered on the server,
 * its data read, its payload kept by the router for five minutes
 * (`staleTimes.static`). A tap within them shows the page from memory, with
 * no request; a tap while the prefetch is still on its way waits for it
 * rather than asking again, once the router knows the route's shape, which
 * it learns from any page of that kind it has shown or fetched.
 *
 * Each page is asked for once, and again only once the router may have let
 * it go: at once when it says it has (`onInvalidate`: a language switch or a
 * finished translation refreshes it, which drops everything it fetched), and
 * otherwise `REMEMBER_MS` (30 s, the least it ever keeps a page) after the
 * last ask; asking while its copy is still fresh costs no request. Signing in
 * or out loads a new page, which starts empty.
 *
 * Listeners on the wrapper rather than a client component per link: the
 * links stay plain anchors rendered on the server. Renders nothing but its
 * element, and outside Next's router (a test's static render) fetches
 * nothing: the router is only asked for once the page is interactive.
 */
export function IntentPrefetch({ as = 'article', children, ...rest }: IntentPrefetchProps) {
  const [tracker] = useState(() => createIntentTracker(readContext));
  const [handlers] = useState(() => intentHandlers(tracker));
  const interactive = useSyncExternalStore(subscribeToNothing, onTheClient, onTheServer);

  return (
    <>
      {createElement(as, { ...rest, ...withOwnHandlers(rest, handlers) }, children)}
      {interactive ? <RouterPort tracker={tracker} /> : null}
    </>
  );
}

/** Hands the tracker the router's `prefetch` while mounted. Renders nothing. */
function RouterPort({ tracker }: { tracker: IntentTracker }) {
  // Typed routes narrow `prefetch` to an address alone; the router itself takes the options.
  const router: AppRouterInstance = useRouter();
  useEffect(() => {
    tracker.connect((page, forget) => router.prefetch(page, fullPrefetch(forget)));
    return () => tracker.disconnect();
  }, [tracker, router]);
  return null;
}

const subscribeToNothing = () => () => {};
const onTheClient = () => true;
const onTheServer = () => false;

const readContext: IntentContext = () => ({
  here: window.location.href,
  network: (navigator as Navigator & { connection?: NetworkHints }).connection,
});

/**
 * Nested wrappers see the same event; the innermost, the first to, handles it.
 * Kept by native event, which every React handler on its way shares.
 */
const handled = new WeakSet<Event>();

/** The link an event happened on, when it is inside this wrapper and no inner one took the event. */
function linkOf(event: React.SyntheticEvent<HTMLElement>): Element | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!anchor || !event.currentTarget.contains(anchor) || handled.has(event.nativeEvent)) return null;
  handled.add(event.nativeEvent);
  return anchor;
}

function facts(anchor: Element): LinkFacts {
  return {
    href: anchor.getAttribute('href'),
    target: anchor.getAttribute('target') ?? '',
    download: anchor.hasAttribute('download'),
    current: anchor.getAttribute('aria-current') === 'page',
  };
}

/** Whether the pointer or the focus went somewhere still inside `anchor` (from its name to its picture). */
const staysIn = (anchor: Element, to: EventTarget | null): boolean => to instanceof Node && anchor.contains(to);

function intentHandlers(tracker: IntentTracker): Handlers {
  return {
    onPointerOver(event) {
      // A finger is a touch, below; a pointer over a link under it is not a pointer resting there.
      if (event.pointerType === 'touch') return;
      const anchor = linkOf(event);
      if (anchor) tracker.rest({ key: anchor, facts: facts(anchor) });
    },
    onPointerOut(event) {
      if (event.pointerType === 'touch') return;
      const anchor = linkOf(event);
      if (anchor && !staysIn(anchor, event.relatedTarget)) tracker.leave(anchor);
    },
    onPointerDown(event) {
      // The primary button, plain: with a modifier, or another button, the page opens elsewhere if at all.
      if (event.pointerType === 'touch' || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = linkOf(event);
      if (anchor) tracker.now({ key: anchor, facts: facts(anchor) });
    },
    onTouchStart(event) {
      const anchor = linkOf(event);
      if (anchor) tracker.now({ key: anchor, facts: facts(anchor) });
    },
    onFocus(event) {
      const anchor = linkOf(event);
      if (anchor) tracker.rest({ key: anchor, facts: facts(anchor) });
    },
    onBlur(event) {
      const anchor = linkOf(event);
      if (anchor && !staysIn(anchor, event.relatedTarget)) tracker.leave(anchor);
    },
    onClick(event) {
      if (linkOf(event)) tracker.cancel();
    },
  };
}

/**
 * The wrapper's handlers, each run after any of the same name its caller
 * gave it (a client component wrapping its own element keeps its `onFocus`).
 */
export function withOwnHandlers(own: React.HTMLAttributes<HTMLElement>, handlers: Handlers): Handlers {
  const merged = { ...handlers };
  for (const name of HANDLERS) {
    const theirs = own[name] as ((event: never) => void) | undefined;
    const ours = handlers[name] as (event: never) => void;
    if (theirs) {
      (merged as Record<string, (event: never) => void>)[name] = (event: never) => {
        theirs(event);
        ours(event);
      };
    }
  }
  return merged;
}
