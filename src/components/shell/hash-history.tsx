'use client';

import { useEffect } from 'react';

type State = Record<string, unknown>;

const isState = (value: unknown): value is State =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The router's own part of a history state (`__NA`, the rendered tree, and
 * anything else it prefixes with `__`). Keys a page keeps for itself — the
 * guide's reading place — belong to the entry they were written for, not to
 * a jump made from it.
 */
export function routerPart(state: State): State {
  return Object.fromEntries(Object.entries(state).filter(([key]) => key.startsWith('__')));
}

/** Whether following this link only moves to a fragment of the page on screen. */
export function isInPageJump(href: string, location: { href: string }): boolean {
  let target: URL;
  let here: URL;
  try {
    target = new URL(href, location.href);
    here = new URL(location.href);
  } catch {
    return false;
  }
  return (
    target.hash !== '' &&
    target.origin === here.origin &&
    target.pathname === here.pathname &&
    target.search === here.search
  );
}

/**
 * Makes Back work after an in-page jump, on every page.
 *
 * Following a plain fragment link — the skip link, an article's or the
 * guide's contents — makes a history entry whose state is null, and the app
 * router ignores a popstate onto such an entry (`handlePopState` returns
 * early when there is no state). So: jump, open another page, press Back, and
 * the address changes while the other page stays on screen. The jump's entry
 * is given a copy of the router state of the entry it was made from — the
 * same page — which the router knows how to restore.
 *
 * The jump itself stays the browser's own, so focus still moves to its
 * target. Only an entry that is still empty is filled, and only with the
 * router's keys, so a page that keeps its own state in history entries (the
 * guide's `GuidePlace`, which adopts its jumps the same way) then writes its
 * own keys onto the adopted entry, whichever listener runs first.
 */
export function HashHistory(): null {
  useEffect(() => {
    let origin: State | null = null;

    const onClick = (event: MouseEvent): void => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      if (isInPageJump(link.href, window.location) && isState(window.history.state)) {
        origin = window.history.state;
      }
    };

    const onHashChange = (): void => {
      const from = origin;
      origin = null;
      if (window.history.state !== null || !from || from.__NA !== true) return;
      try {
        window.history.replaceState(routerPart(from), '');
      } catch {
        // The jump still worked; only Back onto it stays the router's blind spot.
      }
    };

    document.addEventListener('click', onClick, true);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  return null;
}
