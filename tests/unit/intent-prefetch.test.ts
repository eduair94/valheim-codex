import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrefetchKind } from 'next/dist/client/components/router-reducer/router-reducer-types';
import {
  createIntentTracker,
  isConstrained,
  isReaderPage,
  prefetchTarget,
  REMEMBER_MS,
  REST_MS,
  type IntentTracker,
  type LinkFacts,
  type NetworkHints,
} from '@/components/wiki/article/intent-prefetch-model';
import { fullPrefetch, IntentPrefetch, withOwnHandlers } from '@/components/wiki/article/intent-prefetch';

const ORIGIN = 'https://valheim.example';
const LIST = `${ORIGIN}/wiki/c/Weapons`;

const link = (href: string | null, extra: Partial<LinkFacts> = {}): LinkFacts => ({
  href,
  target: '',
  download: false,
  current: false,
  ...extra,
});

const none: ReadonlySet<string> = new Set();

describe('which pages are reader pages', () => {
  const page = (path: string) => isReaderPage(new URL(path, ORIGIN));

  it('takes articles, category and facet lists, browse, the guide and search results', () => {
    expect(page('/wiki/a/iron-sword')).toBe(true);
    expect(page('/wiki/a/Iron%20Sword')).toBe(true);
    expect(page('/wiki/c/Weapons')).toBe(true);
    expect(page('/wiki/c/Weapons?view=compare&tab=2')).toBe(true);
    expect(page('/wiki/c/all?biome=Meadows')).toBe(true);
    expect(page('/wiki/c/Stacks%20%26%20Piles')).toBe(true);
    expect(page('/wiki/browse')).toBe(true);
    expect(page('/wiki/guide')).toBe(true);
    expect(page('/wiki?q=hierro')).toBe(true);
  });

  it('leaves out the chat, sign-in, the API, the bare front page and addresses no route has', () => {
    expect(page('/')).toBe(false);
    expect(page('/?about=Iron+Sword')).toBe(false);
    expect(page('/login')).toBe(false);
    expect(page('/login?next=/')).toBe(false);
    expect(page('/api/wiki/search?q=x')).toBe(false);
    expect(page('/wiki')).toBe(false);
    expect(page('/wiki?q=')).toBe(false);
    expect(page('/wiki?q=%20%20')).toBe(false);
    expect(page('/wiki?offline=/wiki/a/x')).toBe(false);
    expect(page('/wiki/a/')).toBe(false);
    expect(page('/wiki/a/iron-sword/opengraph-image')).toBe(false);
    expect(page('/wiki/c/')).toBe(false);
    expect(page('/wiki/browse/')).toBe(false);
    expect(page('/wiki/guide/x')).toBe(false);
    expect(page('/wikia/a/x')).toBe(false);
  });
});

describe('a constrained connection', () => {
  it('is one that asked to save data, or a 2G one', () => {
    expect(isConstrained({ saveData: true, effectiveType: '4g' })).toBe(true);
    expect(isConstrained({ effectiveType: '2g' })).toBe(true);
    expect(isConstrained({ effectiveType: 'slow-2g' })).toBe(true);
  });

  it('is not 3G, 4G, or a browser that says nothing', () => {
    expect(isConstrained({ effectiveType: '3g' })).toBe(false);
    expect(isConstrained({ saveData: false, effectiveType: '4g' })).toBe(false);
    expect(isConstrained({})).toBe(false);
    expect(isConstrained(null)).toBe(false);
    expect(isConstrained(undefined)).toBe(false);
  });
});

describe('the page a link would warm', () => {
  it('is the page the link leads to, path and query, without its fragment', () => {
    expect(prefetchTarget(link('/wiki/a/iron-sword'), LIST, null, none)).toBe('/wiki/a/iron-sword');
    expect(prefetchTarget(link('/wiki/a/iron-sword#Crafting'), LIST, null, none)).toBe('/wiki/a/iron-sword');
    expect(prefetchTarget(link('/wiki/c/Weapons?view=compare'), LIST, null, none)).toBe('/wiki/c/Weapons?view=compare');
    expect(prefetchTarget(link(`${ORIGIN}/wiki/guide`), LIST, null, none)).toBe('/wiki/guide');
  });

  it('resolves a relative link against the page it is on', () => {
    expect(prefetchTarget(link('iron-sword'), `${ORIGIN}/wiki/a/bronze-sword`, null, none)).toBe('/wiki/a/iron-sword');
  });

  it('is never the page on screen, nor a place on it', () => {
    expect(prefetchTarget(link('/wiki/c/Weapons'), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('/wiki/c/Weapons#top'), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('#axis-biomes'), `${ORIGIN}/wiki/browse`, null, none)).toBeNull();
    expect(prefetchTarget(link('/wiki/c/Weapons'), `${LIST}#top`, null, none)).toBeNull();
  });

  it('is never a link the page marks as the one on screen, though its address differs', () => {
    // "Nivel 1" on a comparison opened without a level: the same view, under its own address.
    const compare = `${ORIGIN}/wiki/c/Weapons?view=compare`;
    expect(prefetchTarget(link('/wiki/c/Weapons?view=compare&tab=1', { current: true }), compare, null, none)).toBeNull();
    expect(prefetchTarget(link('/wiki/c/Weapons?view=compare&tab=2'), compare, null, none)).toBe(
      '/wiki/c/Weapons?view=compare&tab=2',
    );
  });

  it('is only ever a reader page of this site', () => {
    expect(prefetchTarget(link('/'), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('/login?next=/'), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('/?about=Iron+Sword'), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('https://valheim.fandom.com/wiki/Iron_Sword'), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('https://valheim.example.evil/wiki/a/x'), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('mailto:someone@example.com'), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('javascript:alert(1)'), LIST, null, none)).toBeNull();
  });

  it('is nothing for a link the browser opens elsewhere, or saves', () => {
    expect(prefetchTarget(link('/wiki/a/iron-sword', { target: '_blank' }), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('/wiki/a/iron-sword', { target: 'other' }), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('/wiki/a/iron-sword', { download: true }), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('/wiki/a/iron-sword', { target: '_self' }), LIST, null, none)).toBe('/wiki/a/iron-sword');
    expect(prefetchTarget(link('/wiki/a/iron-sword', { target: '_SELF' }), LIST, null, none)).toBe('/wiki/a/iron-sword');
  });

  it('is nothing for an anchor without an address, or one that is not a URL', () => {
    expect(prefetchTarget(link(null), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('http://['), LIST, null, none)).toBeNull();
    expect(prefetchTarget(link('/wiki/a/x'), 'not a url', null, none)).toBeNull();
  });

  it('is nothing for a page already warmed from this one', () => {
    const warmed = new Set(['/wiki/a/iron-sword']);
    expect(prefetchTarget(link('/wiki/a/iron-sword'), LIST, null, warmed)).toBeNull();
    expect(prefetchTarget(link('/wiki/a/iron-sword#Crafting'), LIST, null, warmed)).toBeNull();
    expect(prefetchTarget(link('/wiki/a/bronze-sword'), LIST, null, warmed)).toBe('/wiki/a/bronze-sword');
  });

  it('asks whoever keeps the warmed pages, by the page the router would fetch', () => {
    const asked: string[] = [];
    const fetched = { has: (page: string) => (asked.push(page), page === '/wiki/a/iron-sword') };
    expect(prefetchTarget(link('/wiki/a/iron-sword#Crafting'), LIST, null, fetched)).toBeNull();
    expect(prefetchTarget(link('/wiki/c/Weapons?view=compare'), LIST, null, fetched)).toBe('/wiki/c/Weapons?view=compare');
    expect(asked).toEqual(['/wiki/a/iron-sword', '/wiki/c/Weapons?view=compare']);
  });

  it('is nothing on a connection that asked to save data, or a 2G one', () => {
    const constrained: NetworkHints[] = [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }];
    for (const network of constrained) {
      expect(prefetchTarget(link('/wiki/a/iron-sword'), LIST, network, none)).toBeNull();
    }
    expect(prefetchTarget(link('/wiki/a/iron-sword'), LIST, { effectiveType: '3g' }, none)).toBe('/wiki/a/iron-sword');
  });
});

/**
 * The tracker driven the way the page drives it, on fake timers: a pointer or
 * the keyboard's focus resting on a link (`rest`) and leaving it (`leave`), a
 * finger or a button coming down on one (`now`), a click (`cancel`).
 */
describe('intent', () => {
  let here: string;
  let network: NetworkHints | null;
  let prefetched: string[];
  /** What the tracker handed the router with each page: called, it says the router dropped that page. */
  let forgets: (() => void)[];
  let tracker: IntentTracker;

  const A = { key: 'row-a', facts: link('/wiki/a/iron-sword') };
  const B = { key: 'row-b', facts: link('/wiki/a/bronze-sword') };
  const FANDOM = { key: 'fandom', facts: link('https://valheim.fandom.com/wiki/Iron_Sword', { target: '_blank' }) };

  beforeEach(() => {
    vi.useFakeTimers();
    here = LIST;
    network = null;
    prefetched = [];
    forgets = [];
    tracker = createIntentTracker(() => ({ here, network }));
    tracker.connect((href, forget) => {
      prefetched.push(href);
      forgets.push(forget);
    });
  });

  afterEach(() => {
    tracker.disconnect();
    vi.useRealTimers();
  });

  it('waits for a pointer to rest on a link before warming its page', () => {
    expect(REST_MS).toBe(65);
    tracker.rest(A);
    vi.advanceTimersByTime(REST_MS - 1);
    expect(prefetched).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(prefetched).toEqual(['/wiki/a/iron-sword']);
  });

  it('warms nothing for a pointer passing over a link', () => {
    tracker.rest(A);
    vi.advanceTimersByTime(30);
    tracker.leave(A.key);
    vi.advanceTimersByTime(1000);
    expect(prefetched).toEqual([]);
  });

  it('counts the rest from the link the pointer stopped on, not the ones it crossed', () => {
    tracker.rest(A);
    vi.advanceTimersByTime(40);
    tracker.leave(A.key);
    tracker.rest(B);
    vi.advanceTimersByTime(REST_MS - 1);
    expect(prefetched).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(prefetched).toEqual(['/wiki/a/bronze-sword']);
  });

  it('does not restart the wait while the pointer moves within the same link', () => {
    tracker.rest(A);
    vi.advanceTimersByTime(40);
    tracker.rest(A); // over the row's picture, then its name
    vi.advanceTimersByTime(REST_MS - 40);
    expect(prefetched).toEqual(['/wiki/a/iron-sword']);
  });

  it('keeps waiting for a link when another one is left', () => {
    tracker.rest(A);
    tracker.leave(B.key);
    vi.advanceTimersByTime(REST_MS);
    expect(prefetched).toEqual(['/wiki/a/iron-sword']);
  });

  it('warms a page at once for a finger or a button coming down on its link', () => {
    tracker.now(A);
    expect(prefetched).toEqual(['/wiki/a/iron-sword']);
  });

  it('does not warm a page twice for a press on a link it was already waiting on', () => {
    tracker.rest(A);
    vi.advanceTimersByTime(20);
    tracker.now(A);
    vi.advanceTimersByTime(1000);
    expect(prefetched).toEqual(['/wiki/a/iron-sword']);
  });

  it('warms each page once while the router keeps it, whatever shows the intent', () => {
    tracker.now(A);
    tracker.now(A);
    tracker.rest(A);
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
    tracker.rest(B);
    vi.advanceTimersByTime(REST_MS);
    tracker.now(B);
    expect(prefetched).toEqual(['/wiki/a/iron-sword', '/wiki/a/bronze-sword']);
  });

  it('asks again once REMEMBER_MS have passed since the last ask: the router may have let the page go', () => {
    // The least time the router ever keeps a full prefetch (`staleTimes.static` has a 30 s floor).
    expect(REMEMBER_MS).toBe(30_000);
    tracker.now(A);
    vi.advanceTimersByTime(REMEMBER_MS - 1);
    tracker.now(A);
    expect(prefetched).toEqual(['/wiki/a/iron-sword']);
    vi.advanceTimersByTime(1);
    tracker.now(A);
    expect(prefetched).toEqual(['/wiki/a/iron-sword', '/wiki/a/iron-sword']);
    // Counted from that second ask, not the first.
    vi.advanceTimersByTime(REMEMBER_MS - 1);
    tracker.now(A);
    expect(prefetched).toHaveLength(2);
  });

  it('waits for a resting pointer again on a page asked for longer ago than that', () => {
    tracker.now(A);
    vi.advanceTimersByTime(REMEMBER_MS);
    tracker.rest(A);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(REST_MS - 1);
    expect(prefetched).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(prefetched).toEqual(['/wiki/a/iron-sword', '/wiki/a/iron-sword']);
  });

  it('hands the router, with each page, a way to say it dropped it', () => {
    tracker.now(A);
    tracker.now(B);
    expect(forgets).toHaveLength(2);
    for (const forget of forgets) expect(forget).toBeTypeOf('function');
  });

  it('forgets a page the router dropped (a refresh: a language switch), and asks for it on the next intent', () => {
    tracker.now(A);
    tracker.now(B);
    forgets[0]!();
    tracker.now(B);
    expect(prefetched).toEqual(['/wiki/a/iron-sword', '/wiki/a/bronze-sword']);
    tracker.rest(A);
    vi.advanceTimersByTime(REST_MS);
    expect(prefetched).toEqual(['/wiki/a/iron-sword', '/wiki/a/bronze-sword', '/wiki/a/iron-sword']);
  });

  it('does not forget a page on word about an earlier ask for it', () => {
    tracker.now(A);
    vi.advanceTimersByTime(REMEMBER_MS);
    tracker.now(A);
    expect(prefetched).toHaveLength(2);
    forgets[0]!(); // the first ask's task, reported on after the second ask
    tracker.now(A);
    expect(prefetched).toHaveLength(2);
    forgets[1]!();
    tracker.now(A);
    expect(prefetched).toHaveLength(3);
  });

  it('sets no timer for a link it would never warm', () => {
    tracker.rest(FANDOM);
    tracker.rest({ key: 'self', facts: link('/wiki/c/Weapons') });
    expect(vi.getTimerCount()).toBe(0);
    tracker.now(FANDOM);
    expect(prefetched).toEqual([]);
  });

  it('drops the wait on a click: by then the page is on its way', () => {
    tracker.rest(A);
    vi.advanceTimersByTime(30);
    tracker.cancel();
    vi.advanceTimersByTime(1000);
    expect(prefetched).toEqual([]);
  });

  it('asks again when the wait is over: the page on screen may have changed meanwhile', () => {
    tracker.rest(A);
    vi.advanceTimersByTime(30);
    here = `${ORIGIN}/wiki/a/iron-sword`;
    vi.advanceTimersByTime(REST_MS);
    expect(prefetched).toEqual([]);
  });

  it('warms nothing while the connection asks to save data', () => {
    network = { saveData: true };
    tracker.rest(A);
    tracker.now(B);
    vi.advanceTimersByTime(1000);
    expect(prefetched).toEqual([]);
    network = { effectiveType: '4g' };
    tracker.now(B);
    expect(prefetched).toEqual(['/wiki/a/bronze-sword']);
  });

  it('warms nothing until it is connected to the router, and remembers nothing it did not warm', () => {
    const idle = createIntentTracker(() => ({ here, network }));
    const seen: string[] = [];
    idle.now(A);
    idle.rest(B);
    vi.advanceTimersByTime(1000);
    idle.connect((href) => seen.push(href));
    idle.now(A);
    expect(seen).toEqual(['/wiki/a/iron-sword']);
    idle.disconnect();
  });

  it('forgets a pending wait when disconnected, and warms nothing after', () => {
    tracker.rest(A);
    tracker.disconnect();
    vi.advanceTimersByTime(1000);
    tracker.now(B);
    expect(prefetched).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives a router that refuses: the tap still navigates without a prefetch', () => {
    tracker.disconnect();
    tracker.connect(() => {
      throw new Error('Router action dispatched before initialization.');
    });
    expect(() => tracker.now(A)).not.toThrow();
    tracker.rest(B);
    expect(() => vi.advanceTimersByTime(REST_MS)).not.toThrow();
  });

  it('counts a prefetch the router refused as not made, so the next intent asks again', () => {
    tracker.disconnect();
    let refuse = true;
    tracker.connect((href) => {
      if (refuse) throw new Error('Router action dispatched before initialization.');
      prefetched.push(href);
    });
    tracker.now(A);
    refuse = false;
    tracker.now(A);
    expect(prefetched).toEqual(['/wiki/a/iron-sword']);
  });
});

describe('the wrapper', () => {
  it('asks Next for a full prefetch, the page and its data, and to be told when Next drops it', () => {
    const forget = () => {};
    expect(fullPrefetch(forget)).toEqual({ kind: PrefetchKind.FULL, onInvalidate: forget });
    expect(fullPrefetch(forget).onInvalidate).toBe(forget);
  });

  it('renders only its element, with the attributes it was given', () => {
    const child = createElement('a', { href: '/wiki/a/iron-sword' }, 'Iron Sword');
    expect(renderToStaticMarkup(createElement(IntentPrefetch, { lang: 'en', className: 'pb-4' }, child))).toBe(
      '<article lang="en" class="pb-4"><a href="/wiki/a/iron-sword">Iron Sword</a></article>',
    );
    expect(renderToStaticMarkup(createElement(IntentPrefetch, { as: 'div' }, child))).toBe(
      '<div><a href="/wiki/a/iron-sword">Iron Sword</a></div>',
    );
    expect(
      renderToStaticMarkup(createElement(IntentPrefetch, { as: 'ul', className: 'grid', id: 'rows', role: 'list' }, 'x')),
    ).toBe('<ul class="grid" id="rows" role="list">x</ul>');
  });

  it('takes what a client component wraps with it: a ref, ARIA, its own handlers', () => {
    const ref = createRef<HTMLDivElement>();
    const props = { as: 'div', ref, role: 'region', 'aria-label': 'Resultados', 'aria-busy': false, onKeyDown: () => {} } as const;
    expect(renderToStaticMarkup(createElement(IntentPrefetch, props, 'x'))).toBe(
      '<div role="region" aria-label="Resultados" aria-busy="false">x</div>',
    );
  });

  it('runs its own handlers after the ones its caller gave it, and leaves the rest alone', () => {
    const order: string[] = [];
    const ours = (name: string) => () => void order.push(`ours ${name}`);
    const handlers = {
      onPointerOver: ours('over'),
      onPointerOut: ours('out'),
      onPointerDown: ours('down'),
      onTouchStart: ours('touch'),
      onFocus: ours('focus'),
      onBlur: ours('blur'),
      onClick: ours('click'),
    };
    const merged = withOwnHandlers({ onFocus: () => void order.push('theirs focus'), onKeyDown: () => {} }, handlers);
    merged.onFocus({} as never);
    merged.onClick({} as never);
    expect(order).toEqual(['theirs focus', 'ours focus', 'ours click']);
    expect(merged.onClick).toBe(handlers.onClick);
    expect(merged).not.toHaveProperty('onKeyDown');
  });
});
