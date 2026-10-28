import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTracker,
  FINISH_MS,
  GIVE_UP_MS,
  navigationStarted,
  QUIET_MS,
  type Tracker,
  type View,
} from '@/components/shell/nav-tracker';

const ORIGIN = 'https://valheim.example';

type Listener = { type: string; listener: (event: never) => void; capture: boolean };

const isCapture = (options?: boolean | AddEventListenerOptions): boolean =>
  typeof options === 'boolean' ? options : options?.capture === true;

/**
 * The window the tracker listens on: an address bar the test moves, and
 * events dispatched the way a browser does at the window.
 */
function fakeWindow(path: string) {
  const location = { href: '', pathname: '', search: '' };
  const listeners: Listener[] = [];
  const go = (to: string): void => {
    const url = new URL(to, ORIGIN);
    Object.assign(location, { href: url.href, pathname: url.pathname, search: url.search });
  };
  go(path);
  return {
    location,
    go,
    listeners,
    addEventListener(type: string, listener: (event: never) => void, options?: boolean | AddEventListenerOptions) {
      listeners.push({ type, listener, capture: isCapture(options) });
    },
    removeEventListener(type: string, listener: (event: never) => void, options?: boolean | AddEventListenerOptions) {
      const capture = isCapture(options);
      const index = listeners.findIndex((l) => l.type === type && l.listener === listener && l.capture === capture);
      if (index >= 0) listeners.splice(index, 1);
    },
    /**
     * The window's capture listeners first, then whatever the page does with
     * the event on its way down to the target and back up (`onTheWay`), then
     * the window's other listeners.
     */
    dispatch(event: { type: string }, onTheWay?: () => void): void {
      const at = (capture: boolean) => listeners.filter((l) => l.type === event.type && l.capture === capture);
      for (const { listener } of at(true)) listener(event as never);
      onTheWay?.();
      for (const { listener } of at(false)) listener(event as never);
    },
  };
}

/** Just enough of a DOM for the tracker to find the link a click is on. */
class FakeElement {
  closest(selector: string): FakeElement | null {
    return selector === 'a[href]' && this instanceof FakeAnchor ? this : null;
  }
}

class FakeAnchor extends FakeElement {
  constructor(
    /** Resolved, as `HTMLAnchorElement.href` is. */
    readonly href: string,
    readonly target = '',
  ) {
    super();
  }

  hasAttribute(): boolean {
    return false;
  }
}

/**
 * The bar's life, driven the way the page drives it: a change started (a
 * tap, or `navigationStarted`), the router's address moving (`check` runs
 * whenever it does), history moves, and time passing. Which taps and forms
 * start a change, and what the address says about it, are decided in
 * nav-pending.ts, which has tests of its own.
 */
describe('the navigation bar', () => {
  let win: ReturnType<typeof fakeWindow>;
  let views: View[];
  let tracker: Tracker;
  let unlisten: () => void;

  const phase = (): View['phase'] => views.at(-1)?.phase ?? 'idle';
  const phases = (): View['phase'][] => views.map((view) => view.phase);
  /** The router's address moves (a page landing, or a write it takes in), and the bar is asked. */
  const routerAt = (to: string): void => {
    win.go(to);
    tracker.check();
  };
  /** A plain click on a link to `href`; `onTheWay` is what the page's own handlers do with it. */
  const tap = (href: string, onTheWay?: (event: { preventDefault(): void }) => void, timeStamp = performance.now()) => {
    const event = {
      type: 'click',
      target: new FakeAnchor(new URL(href, win.location.href).href),
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      timeStamp,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    win.dispatch(event, () => onTheWay?.(event));
  };
  /** Next's `<Link>`: it prevents the browser's own following and navigates instead. */
  const asLink = (event: { preventDefault(): void }): void => event.preventDefault();
  const popState = (state: unknown): void => win.dispatch({ type: 'popstate', state } as { type: string });
  const pageShow = (persisted: boolean): void => win.dispatch({ type: 'pageshow', persisted } as { type: string });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    win = fakeWindow('/wiki/c/Weapons');
    vi.stubGlobal('window', win);
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('HTMLAnchorElement', FakeAnchor);
    views = [];
    tracker = createTracker((view) => views.push(view));
    unlisten = tracker.listen();
  });

  afterEach(() => {
    unlisten();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('leaves no trace of a change that lands within the quiet period', () => {
    navigationStarted('/wiki/a/iron-sword');
    expect(views).toMatchObject([{ phase: 'pending', run: 1 }]);
    vi.advanceTimersByTime(QUIET_MS - 50);
    routerAt('/wiki/a/iron-sword');
    expect(views).toMatchObject([
      { phase: 'pending', run: 1 },
      { phase: 'idle', run: 1 },
    ]);
  });

  it('fills and fades a bar that was on screen, then takes it away', () => {
    navigationStarted('/wiki/a/iron-sword');
    vi.advanceTimersByTime(2000);
    routerAt('/wiki/a/iron-sword');
    expect(phase()).toBe('done');
    vi.advanceTimersByTime(FINISH_MS - 1);
    expect(phase()).toBe('done');
    vi.advanceTimersByTime(1);
    // One run throughout: the element that showed is the one that fades.
    expect(views).toMatchObject([
      { phase: 'pending', run: 1 },
      { phase: 'done', run: 1 },
      { phase: 'idle', run: 1 },
    ]);
  });

  it('starts on a tap on a link to another page, counting from the tap itself', () => {
    vi.advanceTimersByTime(1000);
    // The handler ran 40 ms after the tap, as on a busy phone.
    const tappedAt = performance.now() - 40;
    tap('/wiki/a/iron-sword', undefined, tappedAt);
    expect(views).toEqual([{ phase: 'pending', run: 1, since: tappedAt }]);
    // A time it cannot read is the time it is heard.
    routerAt('/wiki/a/iron-sword');
    tap('/wiki/c/Weapons', undefined, 0);
    expect(views.at(-1)).toEqual({ phase: 'pending', run: 2, since: performance.now() });
  });

  it('goes, without its finish, when the page writes another address under the same path', () => {
    // With no state, which Next takes in as a restore, and the restore drops
    // the change on its way. (The search page writes what is typed so, but
    // not once a tap on a link to another page has set it leaving.)
    tap('/wiki/a/iron-sword', asLink);
    vi.advanceTimersByTime(2600);
    routerAt('/wiki/c/Weapons?x=1');
    expect(phases()).toEqual(['pending', 'idle']);
    // Its page never comes; were it to, there is nothing left to finish.
    routerAt('/wiki/a/iron-sword');
    expect(views).toHaveLength(2);
  });

  it('waits through an address the tapping click wrote itself, which the router never takes in', () => {
    // The search page writes what was typed before the result's own handler
    // runs, with the router's own history state. The router shows no address
    // of its own for that write: the next one it shows is the article's.
    win.go('/wiki?q=iron+swor');
    tap('/wiki/a/iron-sword', (event) => {
      win.go('/wiki?q=iron+sword');
      asLink(event);
    });
    vi.advanceTimersByTime(400);
    expect(phase()).toBe('pending');
    routerAt('/wiki/a/iron-sword');
    expect(phases()).toEqual(['pending', 'done']);
  });

  it('lands wherever a redirect took the reader', () => {
    win.go('/wiki/browse');
    navigationStarted('/wiki/c/weapons');
    vi.advanceTimersByTime(500);
    routerAt('/wiki/c/Weapons');
    expect(phase()).toBe('done');
  });

  it('goes at once on Back or Forward onto an entry of the page on screen, which Next restores', () => {
    // Back across a jump `HashHistory` adopted: the router's address does not move.
    win.go('/wiki/guide#plains');
    tap('/wiki/a/flax', asLink);
    vi.advanceTimersByTime(900);
    win.go('/wiki/guide');
    popState({ __NA: true });
    expect(phases()).toEqual(['pending', 'idle']);
  });

  it('finishes on Back to another page, which the router shows before the bar hears of it', () => {
    win.go('/wiki/c/Weapons');
    tap('/wiki/a/iron-sledge', asLink);
    vi.advanceTimersByTime(900);
    // The router's popstate listener runs first and shows the page at once.
    routerAt('/wiki/browse');
    popState({ __NA: true });
    expect(phases()).toEqual(['pending', 'done']);
    vi.advanceTimersByTime(FINISH_MS);
    expect(phase()).toBe('idle');
  });

  it('waits through a fresh jump to a fragment, which comes with no state and which Next lets be', () => {
    tap('/wiki/a/iron-sword', asLink);
    vi.advanceTimersByTime(400);
    tap('#main');
    win.go('/wiki/c/Weapons#main');
    popState(null);
    expect(phase()).toBe('pending');
    routerAt('/wiki/a/iron-sword');
    expect(phase()).toBe('done');
  });

  it('goes when a `<Link>` to the page on screen takes the router there instead', () => {
    win.go('/wiki/browse');
    tap('/wiki/c/Axes', asLink);
    vi.advanceTimersByTime(700);
    // The tab bar's own tab: Next navigates to the page on screen, dropping the change.
    tap('/wiki/browse', asLink);
    expect(phases()).toEqual(['pending', 'idle']);
    // With nothing on its way, the same tap starts nothing.
    tap('/wiki/browse', asLink);
    expect(views).toHaveLength(2);
  });

  it('goes when the page puts its address back to the page a `<Link>` leads to, on the way', () => {
    // Enter wrote what was typed past the router, which still shows `/wiki`.
    // The search tab, tapped while the result is on its way, reads as a
    // change; the search page then puts the address back to `/wiki`, and the
    // tab's `<Link>` navigates there.
    win.go('/wiki?q=iron+sword');
    navigationStarted('/wiki/a/iron-sword');
    vi.advanceTimersByTime(700);
    tap('/wiki', (event) => {
      win.go('/wiki');
      asLink(event);
    });
    expect(phases()).toEqual(['pending', 'idle']);
  });

  it('goes when what the page writes on the way is where a `<Link>` leads, as that page is drawn already', () => {
    // The router shows `/wiki?q=troll`, and the search tab is tapped just
    // after the field was emptied, before the address caught up. The search
    // page writes what is typed first: `/wiki`, where the tab leads. The
    // router does go there, but the page is on screen already.
    win.go('/wiki?q=troll');
    tap('/wiki', (event) => {
      win.go('/wiki');
      asLink(event);
    });
    expect(phases()).toEqual(['pending', 'idle']);
    // Its arrival changes nothing.
    vi.advanceTimersByTime(1500);
    routerAt('/wiki');
    expect(views).toHaveLength(2);
  });

  it('keeps going when a `<Link>` leads elsewhere, whatever the page wrote on the way', () => {
    win.go('/wiki?q=iron+sword');
    navigationStarted('/wiki/a/iron-sword');
    vi.advanceTimersByTime(700);
    // A result followed after more typing, which the search page writes to
    // the address first.
    tap('/wiki/a/troll', (event) => {
      win.go('/wiki?q=troll');
      asLink(event);
    });
    expect(phase()).toBe('pending');
    // The tab, with the address left as it was: a change of its own.
    tap('/wiki', asLink);
    expect(phase()).toBe('pending');
    routerAt('/wiki');
    expect(phase()).toBe('done');
  });

  it('keeps going through a plain link to a place on the page, which the browser follows itself', () => {
    tap('/wiki/a/iron-sword', asLink);
    vi.advanceTimersByTime(300);
    tap('#main');
    tap('/wiki/c/Weapons#main');
    expect(phases()).toEqual(['pending']);
  });

  it('gives up on a change that never lands, without pretending it finished', () => {
    navigationStarted('/wiki/a/iron-sword');
    vi.advanceTimersByTime(GIVE_UP_MS - 1);
    expect(phase()).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(phases()).toEqual(['pending', 'idle']);
    // Landing late changes nothing.
    routerAt('/wiki/a/iron-sword');
    expect(views).toHaveLength(2);
  });

  it('keeps one bar through a second tap, and waits as long again from it', () => {
    navigationStarted('/wiki/a/iron-sword');
    vi.advanceTimersByTime(100);
    tap('/wiki/a/bronze-sword', asLink);
    expect(views).toMatchObject([{ phase: 'pending', run: 1 }]);
    vi.advanceTimersByTime(GIVE_UP_MS - 1);
    expect(phase()).toBe('pending');
    routerAt('/wiki/a/bronze-sword');
    expect(phase()).toBe('done');
  });

  it('tells the bar when the run began, so its quiet period counts from the tap', () => {
    vi.advanceTimersByTime(1234);
    const tappedAt = performance.now();
    navigationStarted('/wiki/a/iron-sword');
    vi.advanceTimersByTime(100);
    navigationStarted('/wiki/a/bronze-sword');
    vi.advanceTimersByTime(400);
    routerAt('/wiki/a/bronze-sword');
    expect(views).toEqual([
      { phase: 'pending', run: 1, since: tappedAt },
      { phase: 'done', run: 1, since: tappedAt },
    ]);
  });

  it('measures the quiet period from the first tap', () => {
    navigationStarted('/wiki/a/iron-sword');
    vi.advanceTimersByTime(QUIET_MS - 10);
    navigationStarted('/wiki/a/bronze-sword');
    vi.advanceTimersByTime(20);
    routerAt('/wiki/a/bronze-sword');
    // On screen for 10 ms by now: it finishes rather than vanishing.
    expect(phase()).toBe('done');
  });

  it('drops the bar of a page restored from the back/forward cache', () => {
    navigationStarted('/wiki/a/iron-sword');
    pageShow(false);
    expect(phase()).toBe('pending');
    pageShow(true);
    expect(phase()).toBe('idle');
  });

  it('starts a new run, with an element of its own, after a finish', () => {
    navigationStarted('/wiki/a/iron-sword');
    vi.advanceTimersByTime(500);
    routerAt('/wiki/a/iron-sword');
    navigationStarted('/wiki/c/Weapons');
    expect(views.at(-1)).toMatchObject({ phase: 'pending', run: 2 });
    // The finished run's removal must not take the new bar with it.
    vi.advanceTimersByTime(FINISH_MS);
    expect(views.at(-1)).toMatchObject({ phase: 'pending', run: 2 });
  });

  it('ignores a change to the page on screen or off the site', () => {
    navigationStarted('/wiki/c/Weapons');
    navigationStarted('/wiki/c/Weapons#arrows');
    navigationStarted('https://valheim.fandom.com/wiki/Weapons');
    tap('https://valheim.fandom.com/wiki/Weapons');
    expect(views).toEqual([]);
  });

  it('hears nothing once it stops listening, and leaves a newer listener alone', () => {
    const newer: View[] = [];
    const other = createTracker((view) => newer.push(view));
    const unlistenOther = other.listen();
    unlisten();
    navigationStarted('/wiki/a/iron-sword');
    expect(views).toEqual([]);
    expect(newer).toMatchObject([{ phase: 'pending', run: 1 }]);
    unlistenOther();
    navigationStarted('/wiki/a/bronze-sword');
    tap('/wiki/a/troll', asLink);
    expect(newer).toHaveLength(1);
    expect(win.listeners).toEqual([]);
    unlisten = () => {};
  });
});
