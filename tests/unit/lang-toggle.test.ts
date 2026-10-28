import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { load } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangToggle, listenForLeaving } from '@/components/lang-toggle';
import type { Lang } from '@/lib/i18n/strings';
import { withLang } from '../helpers/lang';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {} }),
}));

/*
 * The chat's language switch waits for the other language's words when they
 * are not here yet, and leaving the page calls it off. The next page is asked
 * for with the cookie as it is when the reader leaves, so a switch landing on
 * the way out put the new language's `<html lang>` and cookie over a page the
 * server had rendered in the old one. These are the events that count as
 * leaving; which links lead to another page is `linkNavigation`'s rule, with
 * tests of its own (nav-pending.test.ts).
 */

const ORIGIN = 'https://valheim.example';

type Listener = { type: string; listener: (event: never) => void; capture: boolean };

const isCapture = (options?: boolean | AddEventListenerOptions): boolean =>
  typeof options === 'boolean' ? options : options?.capture === true;

/** The window: the address on screen, and events dispatched the way a browser does at the window. */
function fakeWindow(path: string) {
  const listeners: Listener[] = [];
  return {
    location: { href: new URL(path, ORIGIN).href },
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
     * The window's capture listeners first, then the page's own handlers on
     * the event's way down to the target and back up (`onTheWay`), then the
     * window's other listeners.
     */
    dispatch(event: { type: string }, onTheWay?: () => void): void {
      const at = (capture: boolean) => listeners.filter((l) => l.type === event.type && l.capture === capture);
      for (const { listener } of at(true)) listener(event as never);
      onTheWay?.();
      for (const { listener } of at(false)) listener(event as never);
    },
  };
}

/** Just enough of a DOM to find the link a tap is on, from whatever inside it was tapped. */
class FakeElement {
  constructor(readonly parent: FakeElement | null = null) {}

  closest(selector: string): FakeElement | null {
    if (selector === 'a[href]' && this instanceof FakeAnchor) return this;
    return this.parent ? this.parent.closest(selector) : null;
  }
}

class FakeAnchor extends FakeElement {
  constructor(
    /** Resolved, as `HTMLAnchorElement.href` is. */
    readonly href: string,
    readonly target = '',
    readonly download = false,
  ) {
    super();
  }

  hasAttribute(name: string): boolean {
    return name === 'download' && this.download;
  }
}

type Modifiers = Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>;

/** A click on `target`: a plain one unless `modifiers` say otherwise. */
const click = (target: FakeElement | null, modifiers: Modifiers = {}) => ({
  type: 'click',
  target,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

const popState = (state: unknown) => ({ type: 'popstate', state });

describe('leaving the page while the chat’s language switch waits', () => {
  let win: ReturnType<typeof fakeWindow>;
  let leave: ReturnType<typeof vi.fn<() => void>>;
  let stop: () => void;

  beforeEach(() => {
    win = fakeWindow('/?c=3f2a');
    vi.stubGlobal('window', win);
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('HTMLAnchorElement', FakeAnchor);
    leave = vi.fn<() => void>();
    stop = listenForLeaving(leave);
  });

  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
  });

  it('starts with a tap on a link to another page, heard before the link’s own handler', () => {
    // Next's `<Link>` starts the change in its own handler, on the way to
    // the link: by then the switch has to be off.
    let offFirst = false;
    win.dispatch(click(new FakeAnchor(`${ORIGIN}/wiki`)), () => {
      offFirst = leave.mock.calls.length === 1;
    });
    expect(offFirst).toBe(true);
    // Whatever inside the link was tapped: an icon, a label.
    win.dispatch(click(new FakeElement(new FakeAnchor(`${ORIGIN}/wiki/a/iron-sword`))));
    expect(leave).toHaveBeenCalledTimes(2);
  });

  it('does not start with a tap that leaves the page on screen', () => {
    // Another tab, another window, a download.
    win.dispatch(click(new FakeAnchor(`${ORIGIN}/wiki`), { ctrlKey: true }));
    win.dispatch(click(new FakeAnchor(`${ORIGIN}/wiki`), { metaKey: true }));
    win.dispatch(click(new FakeAnchor(`${ORIGIN}/wiki`), { shiftKey: true }));
    win.dispatch(click(new FakeAnchor(`${ORIGIN}/wiki`), { button: 1 }));
    win.dispatch(click(new FakeAnchor(`${ORIGIN}/wiki`, '_blank')));
    win.dispatch(click(new FakeAnchor(`${ORIGIN}/manual.pdf`, '', true)));
    // Another site; the page on screen, or a place on it (the skip link).
    win.dispatch(click(new FakeAnchor('https://valheim.fandom.com/wiki/Iron')));
    win.dispatch(click(new FakeAnchor(`${ORIGIN}/?c=3f2a`)));
    win.dispatch(click(new FakeAnchor(`${ORIGIN}/?c=3f2a#composer`)));
    // Anything but a link: the toggle's own buttons, a row of the sidebar.
    win.dispatch(click(new FakeElement()));
    win.dispatch(click(null));
    expect(leave).not.toHaveBeenCalled();
  });

  it('starts with Back or Forward onto an entry the router restores or loads, not with a jump to a fragment', () => {
    // A fresh jump to a fragment comes with no state, and Next lets it be.
    win.dispatch(popState(null));
    expect(leave).not.toHaveBeenCalled();
    win.dispatch(popState({ __NA: true }));
    expect(leave).toHaveBeenCalledTimes(1);
    // An entry another router wrote: Next loads the page again.
    win.dispatch(popState({ __N: true }));
    expect(leave).toHaveBeenCalledTimes(2);
  });

  it('listens no more once stopped', () => {
    stop();
    expect(win.listeners).toEqual([]);
    win.dispatch(click(new FakeAnchor(`${ORIGIN}/wiki`)));
    win.dispatch(popState({ __NA: true }));
    expect(leave).not.toHaveBeenCalled();
  });
});

/*
 * The reader's switch on a phone is one button, the language the reader is
 * not reading, so the bar has room for five tabs; from 640px it is the pair.
 * Both come from the same two buttons, one per language, restyled by CSS: the
 * server and the first render in the browser agree at every width, and a
 * language's button is the same element at every width, for anything that
 * finds it by its language.
 */
describe('the compact language switch', () => {
  const render = (lang: Lang, props: { compact?: boolean; onChange?: (lang: Lang) => void } = {}) =>
    load(renderToString(withLang(lang, createElement(LangToggle, { lang, ...props }))));
  const classes = (element: { attr(name: string): string | undefined }) => (element.attr('class') ?? '').split(/\s+/);

  it('keeps one button per language, and hides the one in use below 640px', () => {
    const $ = render('es', { compact: true });
    const es = $('button[lang="es"]');
    const en = $('button[lang="en"]');
    expect(es).toHaveLength(1);
    expect(en).toHaveLength(1);
    expect(classes(es)).toContain('max-sm:hidden');
    expect(classes(en)).not.toContain('max-sm:hidden');
    // Named in its own language, so a reader who cannot read Spanish finds it.
    expect(en.attr('aria-label')).toBe('English');
  });

  it('offers the English reader Spanish', () => {
    const $ = render('en', { compact: true });
    expect(classes($('button[lang="en"]'))).toContain('max-sm:hidden');
    expect(classes($('button[lang="es"]'))).not.toContain('max-sm:hidden');
    expect($('button[lang="es"]').attr('aria-label')).toBe('Español');
  });

  it('leaves the chat’s switch, and any switch not asked to be compact, as it was', () => {
    for (const props of [{ onChange: () => {} }, {}]) {
      const $ = render('es', props);
      expect($('button')).toHaveLength(2);
      expect($.html()).not.toContain('max-sm:');
    }
  });
});
