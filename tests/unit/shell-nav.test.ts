import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { load } from 'cheerio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatHref,
  currentTab,
  searchTermsFromPath,
  CHAT_SIGN_IN_HREF,
  CRAFT_HREF,
} from '@/components/shell/nav-model';
import {
  classifyProbe,
  FAILING_DELAY_MS,
  FAILING_MAX_DELAY_MS,
  HEALTHY_DELAY_MS,
  HEALTHY_MAX_DELAY_MS,
  missedPath,
  nextProbeDelay,
} from '@/components/shell/connectivity';
import { langFromCookieString, parseLang } from '@/lib/i18n/lang-cookie';
import { PLANNER_KEY } from '@/lib/craft/planner-store';
import { craftHref } from '@/lib/routes';
import { withLang } from '../helpers/lang';

// The shell as it is once the planner ships; `craft-gate.test.ts` pins it while the gate is shut.
vi.mock('@/lib/craft/feature', () => ({ CRAFT_PLANNER_LIVE: true }));

const nav = vi.hoisted(() => ({ pathname: '/wiki' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {} }),
}));

const { TabBar } = await import('@/components/wiki/tab-bar');
const { default: manifest } = await import('@/app/manifest');

describe('currentTab', () => {
  it('marks Search only on the search page itself', () => {
    expect(currentTab('/wiki')).toEqual({ key: 'search', current: 'page' });
    // The query lives in ?q=, so a results page keeps the pathname.
    expect(currentTab('/wiki/')).toEqual({ key: 'search', current: 'page' });
  });

  it('marks exactly one tab on /wiki/browse', () => {
    expect(currentTab('/wiki/browse')).toEqual({ key: 'browse', current: 'page' });
  });

  it('puts category pages in the Browse section without claiming they are its page', () => {
    expect(currentTab('/wiki/c/Weapons')).toEqual({ key: 'browse', current: 'true' });
    expect(currentTab('/wiki/c/all')).toEqual({ key: 'browse', current: 'true' });
    expect(currentTab('/wiki/c/Armas%20y%20armaduras')).toEqual({ key: 'browse', current: 'true' });
  });

  it('marks the guide as its own tab', () => {
    expect(currentTab('/wiki/guide')).toEqual({ key: 'guide', current: 'page' });
  });

  it('marks the planner as its own tab, a shared list included', () => {
    expect(currentTab('/wiki/craft')).toEqual({ key: 'craft', current: 'page' });
    // A shared list lives in ?l=, so the pathname of a share link stays /wiki/craft.
    expect(currentTab('/wiki/craft/')).toEqual({ key: 'craft', current: 'page' });
  });

  it('marks nothing on an article, which every tab leads to', () => {
    expect(currentTab('/wiki/a/iron-sword')).toBeNull();
  });

  it('does not treat look-alike paths as sections', () => {
    expect(currentTab('/wiki/browser')).toBeNull();
    expect(currentTab('/wiki/c')).toBeNull();
    expect(currentTab('/wiki/guides')).toBeNull();
    expect(currentTab('/wikis')).toBeNull();
    expect(currentTab('/wiki/crafts')).toBeNull();
    expect(currentTab('/wiki/craftsman')).toBeNull();
    expect(currentTab('/wiki/craft/x')).toBeNull();
  });

  it('leads the planner’s tab to the planner’s own address', () => {
    expect(CRAFT_HREF).toBe(craftHref());
  });
});

/*
 * The bar as the server renders it, which is also what the browser's first
 * render must reproduce for the page to hydrate.
 */
describe('the tab bar', () => {
  /** The bar for a reader on `pathname`, parsed. */
  function bar({ pathname = '/wiki', lang = 'es', signedIn = false }: { pathname?: string; lang?: 'es' | 'en'; signedIn?: boolean } = {}) {
    nav.pathname = pathname;
    return load(renderToString(withLang(lang, createElement(TabBar, { lang, signedIn }))));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has five tabs, with the planner in the middle under its own rune', () => {
    const $ = bar();
    const tabs = $('nav ul > li > a').toArray().map((a) => $(a));
    expect(tabs.map((tab) => tab.attr('href'))).toEqual(['/wiki', '/wiki/browse', CRAFT_HREF, '/wiki/guide', CHAT_SIGN_IN_HREF]);
    expect(tabs.map((tab) => tab.find('.truncate').text())).toEqual(['Buscar', 'Explorar', 'Taller', 'Guía', 'Chat']);
    // ᚳ, not ᚲ: ᚲ is already the sixth ordinal rune (Mistlands, the sixth source).
    expect(tabs[2]!.children('[aria-hidden="true"]').first().text()).toBe('ᚳ');
    expect(bar({ lang: 'en' })('nav ul > li > a').eq(2).text()).toBe('ᚳCraft');
  });

  it('marks the planner’s tab on the planner', () => {
    const $ = bar({ pathname: '/wiki/craft' });
    expect($(`nav a[aria-current]`).toArray().map((a) => $(a).attr('href'))).toEqual([CRAFT_HREF]);
    expect($(`nav a[href="${CRAFT_HREF}"]`).attr('aria-current')).toBe('page');
  });

  it('counts nothing in the first render, even where the list could be read', () => {
    // The browser hydrates from this same render, and the server has no list:
    // a count drawn from storage here would not match the page's HTML.
    const items = [1, 2, 3].map((n) => ({ id: `Item${n}`, level: 1, from: 0, qty: 1 }));
    const stored = new Map([[PLANNER_KEY, JSON.stringify({ v: 1, items, have: {}, at: null })]]);
    vi.stubGlobal('window', {
      localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem() {}, removeItem() {} },
      addEventListener() {},
      removeEventListener() {},
    });
    const $ = bar();
    expect($(`nav a[href="${CRAFT_HREF}"]`).text()).toBe('ᚳTaller');
  });
});

describe('install manifest', () => {
  it('offers the planner as a shortcut, right after search', () => {
    const shortcuts = manifest().shortcuts ?? [];
    expect(shortcuts.map((shortcut) => shortcut.url)).toEqual(['/wiki', CRAFT_HREF, '/wiki/guide', '/wiki/browse']);
    expect(shortcuts[1]).toEqual({
      name: 'Taller',
      url: CRAFT_HREF,
      description: 'Tu lista de fabricación y lo que te falta juntar',
    });
  });
});

describe('chatHref', () => {
  it('opens the chat for anyone signed in, by any method', () => {
    expect(chatHref(true)).toBe('/');
  });

  it('sends everyone else to sign in, and back to the chat afterwards', () => {
    expect(chatHref(false)).toBe(CHAT_SIGN_IN_HREF);
    expect(new URL(chatHref(false), 'https://x.test').searchParams.get('next')).toBe('/');
  });
});

describe('searchTermsFromPath', () => {
  it('turns a missing slug back into words', () => {
    expect(searchTermsFromPath('/wiki/a/iron-swrd')).toBe('iron swrd');
    expect(searchTermsFromPath('/wiki/a/Iron_Sword')).toBe('Iron Sword');
  });

  it('decodes escapes and survives malformed ones', () => {
    expect(searchTermsFromPath('/wiki/a/n%C3%BAcleo-de-surtling')).toBe('núcleo de surtling');
    expect(searchTermsFromPath('/wiki/a/bad%E0%A4%A')).toBe('bad%E0%A4%A');
  });

  it('is empty for the root', () => {
    expect(searchTermsFromPath('/')).toBe('');
  });
});

describe('offline banner', () => {
  it('tells a server error apart from no network at all', () => {
    expect(classifyProbe({ status: 204 })).toBe('online');
    expect(classifyProbe({ status: 404 })).toBe('online');
    expect(classifyProbe({ status: 502 })).toBe('degraded');
    expect(classifyProbe({ status: 521 })).toBe('degraded');
    expect(classifyProbe('failed')).toBe('offline');
  });

  it('backs off while healthy, up to a ceiling', () => {
    let delay = nextProbeDelay('online', null, null);
    expect(delay).toBe(HEALTHY_DELAY_MS);
    const seen = [delay];
    for (let i = 0; i < 6; i++) {
      delay = nextProbeDelay('online', 'online', delay);
      seen.push(delay);
    }
    expect(seen[1]).toBe(HEALTHY_DELAY_MS * 2);
    expect(Math.max(...seen)).toBe(HEALTHY_MAX_DELAY_MS);
  });

  it('asks again soon after a failure, and restarts the schedule on a change', () => {
    expect(nextProbeDelay('offline', 'online', HEALTHY_MAX_DELAY_MS)).toBe(FAILING_DELAY_MS);
    expect(nextProbeDelay('offline', 'offline', FAILING_DELAY_MS)).toBe(FAILING_DELAY_MS * 2);
    expect(nextProbeDelay('degraded', 'offline', FAILING_MAX_DELAY_MS)).toBe(FAILING_MAX_DELAY_MS);
    expect(nextProbeDelay('online', 'degraded', FAILING_MAX_DELAY_MS)).toBe(HEALTHY_DELAY_MS);
  });

  it('only links back to a plain path on this site', () => {
    expect(missedPath('/wiki/a/iron-sword')).toBe('/wiki/a/iron-sword');
    expect(missedPath('/wiki/c/all?biome=Meadows')).toBe('/wiki/c/all?biome=Meadows');
    expect(missedPath('/')).toBe('/');
    expect(missedPath('/wiki?q=a//b')).toBe('/wiki?q=a//b');
    expect(missedPath('//evil.example/x')).toBeNull();
    expect(missedPath('/\\evil.example')).toBeNull();
    expect(missedPath('/\t//evil.example')).toBeNull();
    expect(missedPath('https://evil.example/')).toBeNull();
    expect(missedPath('javascript:alert(1)')).toBeNull();
    expect(missedPath(null)).toBeNull();
    expect(missedPath('')).toBeNull();
  });

  it('checks the address after resolving it, so dot segments cannot reach another host', () => {
    // Each of these resolves to `//evil.example…`, which a link reads as another host.
    for (const sneaky of [
      '/.//evil.example/x',
      '/%2e//evil.example/x',
      '/%2E%2E//evil.example',
      '/a/..//evil.example',
      '/..//evil.example',
      '/a/..\\/evil.example',
      '/.\\/evil.example',
    ]) {
      expect(missedPath(sneaky), sneaky).toBeNull();
    }
    // Dot segments that stay on this site are fine, resolved.
    expect(missedPath('/wiki/./a/../a/iron-sword')).toBe('/wiki/a/iron-sword');
  });
});

describe('language cookie', () => {
  it('reads the reader’s choice and tells it apart from no choice', () => {
    expect(langFromCookieString('wv_lang=en')).toBe('en');
    expect(langFromCookieString('a=1; wv_lang=es; b=2')).toBe('es');
    expect(langFromCookieString('a=1')).toBeNull();
    expect(langFromCookieString('wv_lang=fr')).toBeNull();
    expect(langFromCookieString('xwv_lang=en')).toBeNull();
    expect(langFromCookieString('')).toBeNull();
  });

  it('falls back to Spanish when parsing a missing or unknown value', () => {
    expect(parseLang(undefined)).toBe('es');
    expect(parseLang('fr')).toBe('es');
    expect(parseLang('en')).toBe('en');
  });
});
