import {
  formNavigation,
  linkNavigation,
  linkToPageOnScreen,
  navigationTo,
  outcome,
  type LinkFacts,
  type PendingNavigation,
} from './nav-pending';

/** Under this a page change looks instant, so the bar stays out of sight. */
export const QUIET_MS = 150;
/**
 * How long the bar waits for a page that never arrives: a change that failed
 * without leaving (a failed fetch is a full page load instead), or one
 * dropped in a way the address bar does not show. Long, because a slow phone
 * on a poor connection is who the bar is for.
 */
export const GIVE_UP_MS = 20_000;
/** The finish, once the page is up: the bar, full width, fades. */
export const FADE_MS = 250;
/**
 * How long the finished bar stays mounted: the fade starts when the render
 * that asks for it lands, which a busy phone takes a while to do.
 */
export const FINISH_MS = FADE_MS + 150;

/**
 * - `pending`: a change is on its way; the bar shows once `QUIET_MS` is up.
 * - `done`: it landed after the bar had shown; the bar fades.
 * - `idle`: no bar.
 *
 * `run` counts changes, so each gets an element (and an animation) of its own.
 * `since` is when the run's first tap came, by `performance.now()`, which is
 * also the document timeline's clock: the quiet period counts from there.
 */
export type View = { phase: 'idle' | 'pending' | 'done'; run: number; since: number };

export type Tracker = {
  /** Listens for taps, submissions and history moves; returns the way to stop. */
  listen(): () => void;
  /** Asks the address bar whether the change has landed, or been dropped. */
  check(): void;
};

/** Set while a tracker listens: how code that navigates by itself says so. */
let announce: ((navigation: PendingNavigation | null) => void) | null = null;

/**
 * For code that navigates by itself (`router.push`), which no click or form
 * gives away: call it with the same href, just before.
 */
export function navigationStarted(href: string): void {
  announce?.(navigationTo(href, window.location.href));
}

/**
 * When an event came, on the clock `performance.now()` keeps: its own
 * `timeStamp`, as its handler may run a good while later on a busy phone.
 */
function eventTime(event: Event): number {
  const now = performance.now();
  return event.timeStamp > 0 && event.timeStamp <= now ? event.timeStamp : now;
}

/** The link a click is on, as the rules in nav-pending.ts read it, or `null`. */
function clickedLink(event: MouseEvent): LinkFacts | null {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement)) return null;
  return { href: link.href, target: link.target, download: link.hasAttribute('download') };
}

/**
 * The bar's state, kept outside React: the listeners are the window's and
 * outlive any one render. `show` is the only way out.
 *
 * A change ends when it lands, and also whenever Next drops it, which it does
 * for any other navigation or restore it starts while the change is on its
 * way. A tap on another page is a new destination for the same bar, and Back
 * to another page shows that page, which reads as a landing. The rest show
 * no page to wait for, and the bar goes at once, without its finish: the
 * page writing its own address (`outcome`), Back or Forward onto an entry of
 * the page on screen, and a `<Link>` to the page on screen.
 */
export function createTracker(show: (view: View) => void): Tracker {
  let pending: { navigation: PendingNavigation; since: number } | null = null;
  let run = 0;
  let since = 0;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  let finish: ReturnType<typeof setTimeout> | undefined;
  /** A click on a link to the page on screen while a change is on its way, until the click is over. */
  let tapOnPageOnScreen: MouseEvent | null = null;

  const stop = (landed: boolean): void => {
    const was = pending;
    pending = null;
    clearTimeout(giveUp);
    clearTimeout(finish);
    // A change that landed before the bar showed leaves no trace; one that
    // was on screen fills the bar and fades it.
    if (landed && was && performance.now() - was.since >= QUIET_MS) {
      show({ phase: 'done', run, since });
      finish = setTimeout(() => show({ phase: 'idle', run, since }), FINISH_MS);
    } else {
      show({ phase: 'idle', run, since });
    }
  };

  const start = (navigation: PendingNavigation | null, at = performance.now()): void => {
    if (!navigation) return;
    clearTimeout(giveUp);
    giveUp = setTimeout(() => stop(false), GIVE_UP_MS);
    // Another tap while one is on its way: the same bar, the new destination.
    if (pending) {
      pending = { navigation, since: pending.since };
      return;
    }
    clearTimeout(finish);
    since = at;
    pending = { navigation, since };
    run += 1;
    show({ phase: 'pending', run, since });
  };

  const onClick = (event: MouseEvent): void => {
    tapOnPageOnScreen = null;
    const link = clickedLink(event);
    if (!link) return;
    const here = window.location.href;
    const navigation = linkNavigation(event, link, here);
    if (navigation) start(navigation, eventTime(event));
    else if (pending && linkToPageOnScreen(event, link, here)) tapOnPageOnScreen = event;
  };

  // Once the click is over, every handler on its way included: a `<Link>` to
  // the page on screen has prevented its default and navigated there, which
  // drops the change on its way. A plain fragment link has not.
  //
  // The page on screen is read again here, after the page's own handlers:
  // the search page may write the address before a link's own handler runs.
  // When the link leads to the page the router shows (its tab, tapped while a
  // result it opened is on its way), it puts the address back there, and the
  // tap that read as a page change in the capture phase leads to the page on
  // screen after all. Otherwise it writes what is typed: with the field just
  // emptied, before the address caught up, that is `/wiki`, and its tab or
  // the app's name, tapped then, reads as a link to the page on screen too.
  // The router does go there, from the query it showed, but to the page
  // already drawn, so the bar goes at once all the same. Nothing else writes
  // the address during a click on a link, and the router writes it only once
  // the next page is up.
  const onClickDone = (event: MouseEvent): void => {
    const tapped = event === tapOnPageOnScreen;
    tapOnPageOnScreen = null;
    if (!pending || !event.defaultPrevented) return;
    const link = clickedLink(event);
    if (tapped || (link && linkToPageOnScreen(event, link, window.location.href))) stop(false);
  };

  const onSubmit = (event: SubmitEvent): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const by = event.submitter;
    const attribute = (own: string, override: string): string | null =>
      by?.getAttribute(override) ?? form.getAttribute(own);
    const facts = {
      action: attribute('action', 'formaction'),
      method: attribute('method', 'formmethod'),
      target: attribute('target', 'formtarget'),
    };
    const fields = (): [string, string][] =>
      [...new FormData(form)].map(([name, value]) => [name, typeof value === 'string' ? value : value.name]);
    start(formNavigation(facts, fields, window.location.href), eventTime(event));
  };

  // Back or Forward onto an entry with a state: one the router keeps (Next's
  // own, or a jump `HashHistory` adopted), which Next restores, dropping
  // whatever was on its way; or one it does not know, for which it reloads
  // the page. A fresh jump to a fragment comes with no state, and Next lets
  // it be. The router's own listener runs first, and shows the restored entry
  // at once: Back to another page has already read as a landing in `check`
  // and finishes; Back onto the page on screen shows no new address, and
  // goes here.
  const onPopState = (event: PopStateEvent): void => {
    if (pending && event.state !== null && event.state !== undefined) stop(false);
  };

  // A page restored from the back/forward cache comes back as it was left,
  // bar and all.
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) stop(false);
  };

  return {
    listen() {
      // Taps and submissions in the capture phase, before the page's own
      // handlers can stop the event; the end of a click in the bubble phase,
      // after them.
      window.addEventListener('click', onClick, true);
      window.addEventListener('click', onClickDone);
      window.addEventListener('submit', onSubmit, true);
      window.addEventListener('popstate', onPopState);
      window.addEventListener('pageshow', onPageShow);
      announce = start;
      return () => {
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('click', onClickDone);
        window.removeEventListener('submit', onSubmit, true);
        window.removeEventListener('popstate', onPopState);
        window.removeEventListener('pageshow', onPageShow);
        if (announce === start) announce = null;
      };
    },
    check() {
      if (!pending) return;
      const now = outcome(pending.navigation, window.location);
      if (now !== 'waiting') stop(now === 'landed');
    },
  };
}
