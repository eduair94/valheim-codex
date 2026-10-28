'use client';

import { useLayoutEffect } from 'react';

/** The key the guide keeps its place under, inside a history entry's state. */
export const PLACE_KEY = 'wvGuidePlace';

/** How long scrolling has to rest before the place is written down. */
const SETTLE_MS = 200;

/** The parts of the guide drawn only when they near the screen (guide.css). */
const LAZY_SECTIONS = '.g-cv[id], .g-chapter[id]';

/**
 * The line on screen the place is pinned at: a third of the way down, where
 * the eye sits (the table of contents marks the chapter being read by the
 * same line).
 */
const READING_LINE = 0.3;

export type GuidePlaceState = {
  /** The scroll position the reader left at. */
  y: number;
  /** The width and language the sizes were measured at; they hold for those only. */
  w: number;
  lang: string;
  /** The content height of each lazily drawn section, by id. */
  sizes: Record<string, number>;
  /**
   * The section or checkbox at the reading line, and how far from the top of
   * the screen it was. Ids are stable and shared by both languages; an
   * element survives what a pixel does not, such as the fonts arriving late
   * and reflowing everything above it.
   */
  anchor?: { id: string; top: number };
};

type State = Record<string, unknown>;

function isState(value: unknown): value is State {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The place kept in a history entry's state, or null for anything this guide did not write. */
export function readPlace(state: unknown): GuidePlaceState | null {
  if (!isState(state)) return null;
  const place = state[PLACE_KEY];
  if (!isState(place)) return null;
  const { y, w, lang, sizes, anchor } = place;
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  if (typeof w !== 'number' || typeof lang !== 'string' || !isState(sizes)) return null;
  const clean: Record<string, number> = {};
  for (const [id, size] of Object.entries(sizes)) {
    if (typeof size === 'number' && Number.isFinite(size) && size > 0) clean[id] = size;
  }
  const pinned =
    isState(anchor) && typeof anchor.id === 'string' && anchor.id !== '' && Number.isFinite(anchor.top)
      ? { id: anchor.id, top: anchor.top as number }
      : undefined;
  return { y, w, lang, sizes: clean, ...(pinned ? { anchor: pinned } : {}) };
}

/** The entry's state with the place set and every other key (the router's own) kept. */
export function withPlace(state: unknown, place: GuidePlaceState): State {
  return { ...(isState(state) ? state : {}), [PLACE_KEY]: place };
}

/** What an in-page jump inherits from the entry it was made from: everything but the place. */
export function withoutPlace(state: State): State {
  const { [PLACE_KEY]: _place, ...rest } = state;
  return rest;
}

/**
 * The element at the reading line: the deepest section that has reached it,
 * then the last checkbox in that section that has. Only the section being
 * read is looked into, so the sections skipped off screen are never laid out
 * just to be measured.
 */
function anchorAt(root: HTMLElement): { id: string; top: number } | undefined {
  const line = window.innerHeight * READING_LINE;
  let section: HTMLElement | null = null;
  let top = 0;
  // Document order, nested sections after their parent's start: tops only grow.
  for (const el of root.querySelectorAll<HTMLElement>('section[id]')) {
    const at = el.getBoundingClientRect().top;
    if (at > line) break;
    section = el;
    top = at;
  }
  if (!section) return undefined;
  let anchor = { id: section.id, top };
  for (const box of section.querySelectorAll<HTMLElement>('input[type="checkbox"][id]')) {
    const at = box.getBoundingClientRect().top;
    if (at > line) break;
    anchor = { id: box.id, top: at };
  }
  return anchor;
}

/** Scrolls so the place's element is where it was on screen, or to its pixel if it is gone. */
function returnTo(place: GuidePlaceState): void {
  const el = place.anchor ? document.getElementById(place.anchor.id) : null;
  const target = el && place.anchor ? window.scrollY + el.getBoundingClientRect().top - place.anchor.top : place.y;
  if (Math.abs(window.scrollY - target) > 1) window.scrollTo(0, target);
}

/**
 * Whether this document is the guide come back through a full page load — a
 * reload, a phone bringing a discarded tab back, Back onto a page the browser
 * did not keep — and its place is still to be set. The browser has then
 * restored the scroll position already, during the load, onto the sections'
 * estimated heights. Decided once per document, and cleared once the place
 * is set, so a later visit within the app is never mistaken for it.
 */
let loadReturnPending: boolean | null = null;

function isLoadReturn(): boolean {
  if (loadReturnPending === null) {
    const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    let samePage = false;
    try {
      samePage = !!nav && new URL(nav.name).pathname === window.location.pathname;
    } catch {
      samePage = false;
    }
    loadReturnPending = samePage && (nav?.type === 'reload' || nav?.type === 'back_forward');
  }
  return loadReturnPending;
}

/**
 * Keeps the reader's place in the guide across a trip to an article and Back.
 *
 * The chapters off screen are not laid out until they near it, and stand in
 * at an estimated height until then (`content-visibility`, guide.css). The
 * browser remembers a section's real height once it has drawn it, but only
 * for as long as that element lives. Open an article from a chip and come
 * Back, and the guide is built anew: the browser restores the scroll position
 * by pixel, onto a page whose chapters are back at their estimates, and the
 * reader landed up to 1,300px from where they were (measured on a phone, from
 * the Hildir chips).
 *
 * So the sizes are kept in the history entry, with the position, while the
 * reader is on the page, and when the entry is shown again every section gets
 * its own height back as its estimate before the browser scrolls: on Back and
 * Forward the router renders the page inside `popstate`, and the browser
 * restores the position only after that, onto a page as tall as the one the
 * reader left. Two cases need a hand on top:
 *
 *   - After a full load (a reload, a tab the phone had discarded) the browser
 *     has scrolled before any script ran, so once the sizes are back the
 *     reader's element is put back where it was on screen.
 *   - Back onto an in-page jump, Chrome scrolls to the jump's target again
 *     rather than to where the reader had read on to; it does so before the
 *     next frame, so the place is put back in that frame, unseen.
 *
 * In the history entry rather than in storage, because the place belongs to
 * the visit: opening the guide afresh from the menu starts at the top, as any
 * page does; only Back, Forward and a reload return to a place.
 *
 * The same entries needed one more fix. The browser records an in-page jump
 * (the table of contents, the skip link) with an empty state, and the router
 * ignores a Back onto an entry it did not write: after a jump to a chapter and
 * a click through to an article, Back changed the address to the guide and
 * left the article on screen. Each jump now inherits the state of the entry it
 * was made from, which is what the router's own links write. The jump itself
 * stays the browser's, so focus still moves to the chapter with it.
 */
export function GuidePlace({ rootId, lang }: { rootId: string; lang: string }) {
  useLayoutEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return;
    const sections = Array.from(root.querySelectorAll<HTMLElement>(LAZY_SECTIONS));
    const html = document.documentElement;
    const byLoad = isLoadReturn();

    let frame = 0;
    const saved = readPlace(window.history.state);
    if (saved && saved.w === window.innerWidth && saved.lang === lang) {
      /*
       * After a full load the page is already scrolled to the old pixel, over
       * the estimates. Scroll anchoring would keep whatever that pixel shows
       * on screen while the heights above it change back, so it is held off
       * until the place has been set again.
       */
      if (byLoad) html.style.overflowAnchor = 'none';
      for (const el of sections) {
        const size = saved.sizes[el.id];
        if (size) el.style.containIntrinsicBlockSize = `auto ${size}px`;
      }
      if (byLoad) returnTo(saved);
      if (byLoad || window.location.hash) {
        frame = requestAnimationFrame(() => {
          returnTo(saved);
          html.style.overflowAnchor = '';
          if (byLoad) loadReturnPending = false;
        });
      }
    } else if (byLoad) {
      // Nothing kept for this width and language: the browser's own restore stands.
      loadReturnPending = false;
    }

    const sizes: Record<string, number> = {};
    let anchor: GuidePlaceState['anchor'];
    let timer: ReturnType<typeof setTimeout> | undefined;

    /*
     * `measure` is off for the writes made as the page is hidden or unloaded:
     * by then the browser has stopped drawing the sections and they have all
     * fallen back to their estimates, which moves everything on the page but
     * the scroll position. The element is the one measured last on screen.
     */
    const write = (measure = true): void => {
      clearTimeout(timer);
      const state: unknown = window.history.state;
      // An entry the router did not write is left alone: a state it cannot
      // read would turn Back onto that entry into a full reload.
      if (!isState(state)) return;
      if (measure && document.visibilityState === 'visible') anchor = anchorAt(root);
      const place: GuidePlaceState = {
        y: window.scrollY,
        w: window.innerWidth,
        lang,
        sizes: { ...sizes },
        ...(anchor ? { anchor } : {}),
      };
      try {
        window.history.replaceState(withPlace(state, place), '');
      } catch {
        // A browser that rations history writes: the place is just not kept.
      }
    };
    const settle = (): void => {
      clearTimeout(timer);
      timer = setTimeout(write, SETTLE_MS);
    };

    // Content box, which is what `contain-intrinsic-block-size` stands in for.
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.contentBoxSize[0];
        if (box) sizes[(entry.target as HTMLElement).id] = box.blockSize;
      }
      settle();
    });
    for (const el of sections) observer.observe(el);

    let routerState: State | null = isState(window.history.state) ? window.history.state : null;
    const onClick = (event: MouseEvent): void => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link) return;
      if (link.getAttribute('href')?.startsWith('#')) {
        if (isState(window.history.state)) routerState = window.history.state;
      } else {
        // Probably leaving: the entry being left gets the place as it is now.
        write();
      }
    };
    const onHashChange = (): void => {
      if (window.history.state === null && routerState) {
        try {
          window.history.replaceState(withoutPlace(routerState), '');
        } catch {
          // Unadopted, the jump still works; only Back onto it stays the router's old blind spot.
        }
      }
      if (isState(window.history.state)) routerState = window.history.state;
      // A jump to a chapter already on screen scrolls nothing; the new entry still needs its place.
      settle();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') write(false);
    };
    const onPageHide = (): void => write(false);

    document.addEventListener('click', onClick, true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('scroll', settle, { passive: true });
    window.addEventListener('resize', settle, { passive: true });
    window.addEventListener('pagehide', onPageHide);

    return () => {
      cancelAnimationFrame(frame);
      html.style.overflowAnchor = '';
      observer.disconnect();
      clearTimeout(timer);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('scroll', settle);
      window.removeEventListener('resize', settle);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [rootId, lang]);

  return null;
}
