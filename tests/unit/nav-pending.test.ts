import { describe, expect, it } from 'vitest';
import {
  formNavigation,
  linkNavigation,
  linkToPageOnScreen,
  navigationTo,
  outcome,
  type Activation,
  type LinkFacts,
} from '@/components/shell/nav-pending';

const SITE = 'https://valheim.example';
const PLAIN: Activation = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
/** A link as the browser reports it: `href` resolved against the page it is on. */
const link = (href: string, extra: Partial<LinkFacts> = {}, page = SITE): LinkFacts => ({
  href: new URL(href, page).href,
  target: '',
  download: false,
  ...extra,
});

describe('linkNavigation', () => {
  const list = `${SITE}/wiki/c/Weapons`;

  it('starts on a plain click on a link to another page of the site', () => {
    expect(linkNavigation(PLAIN, link('/wiki/a/iron-sword'), list)).toEqual({
      fromPath: '/wiki/c/Weapons',
      fromUrl: '/wiki/c/Weapons',
      to: '/wiki/a/iron-sword',
    });
    // Another view of the same list is another page: the server renders it.
    expect(linkNavigation(PLAIN, link('/wiki/c/Weapons?view=compare'), list)?.to).toBe('/wiki/c/Weapons?view=compare');
    // From a results page to an article: the page is the path and query, not the fragment.
    expect(linkNavigation(PLAIN, link('/wiki/a/troll#drops'), `${SITE}/wiki?q=troll`)).toEqual({
      fromPath: '/wiki',
      fromUrl: '/wiki?q=troll',
      to: '/wiki/a/troll',
    });
    expect(linkNavigation(PLAIN, link('/wiki', { target: '_self' }), list)?.to).toBe('/wiki');
  });

  it('leaves a click with a modifier or another button to the browser', () => {
    const href = link('/wiki/a/iron-sword');
    for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      expect(linkNavigation({ ...PLAIN, [key]: true }, href, list), key).toBeNull();
    }
    expect(linkNavigation({ ...PLAIN, button: 1 }, href, list)).toBeNull();
    expect(linkNavigation({ ...PLAIN, button: 2 }, href, list)).toBeNull();
  });

  it('ignores links that open elsewhere or save a file', () => {
    expect(linkNavigation(PLAIN, link('/wiki/a/iron-sword', { target: '_blank' }), list)).toBeNull();
    expect(linkNavigation(PLAIN, link('/wiki/a/iron-sword', { target: 'other' }), list)).toBeNull();
    expect(linkNavigation(PLAIN, link('/wiki/a/iron-sword', { download: true }), list)).toBeNull();
  });

  it('ignores links that leave the site or the web', () => {
    expect(linkNavigation(PLAIN, link('https://valheim.fandom.com/wiki/Iron_Sword'), list)).toBeNull();
    expect(linkNavigation(PLAIN, link('//valheim.fandom.com/wiki/Iron_Sword'), list)).toBeNull();
    expect(linkNavigation(PLAIN, link('http://valheim.example/wiki/a/troll'), list)).toBeNull(); // another origin
    expect(linkNavigation(PLAIN, link('mailto:someone@example.com'), list)).toBeNull();
    expect(linkNavigation(PLAIN, link('javascript:void(0)'), list)).toBeNull();
  });

  it('ignores a jump within the page and a link to the page on screen', () => {
    const guide = `${SITE}/wiki/guide`;
    expect(linkNavigation(PLAIN, link('#plains', {}, guide), guide)).toBeNull();
    expect(linkNavigation(PLAIN, link('/wiki/guide#plains'), guide)).toBeNull();
    expect(linkNavigation(PLAIN, link('#plains', {}, `${guide}#meadows`), `${guide}#meadows`)).toBeNull();
    const article = `${SITE}/wiki/a/iron-sword?x=1`;
    expect(linkNavigation(PLAIN, link('#main', {}, article), article)).toBeNull();
    // The same page, its fragment dropped or not: nothing to wait for.
    expect(linkNavigation(PLAIN, link('/wiki/guide'), `${guide}#plains`)).toBeNull();
    expect(linkNavigation(PLAIN, link('/wiki/browse'), `${SITE}/wiki/browse`)).toBeNull();
  });

  it('counts a fragment link to another page, or the same path with another query, as a page change', () => {
    expect(linkNavigation(PLAIN, link('/wiki/guide#plains'), `${SITE}/wiki/a/troll`)?.to).toBe('/wiki/guide');
    expect(linkNavigation(PLAIN, link('/wiki?q=troll#x'), `${SITE}/wiki`)?.to).toBe('/wiki?q=troll');
  });
});

describe('navigationTo', () => {
  it('reads a relative address against the page on screen, as the router does', () => {
    expect(navigationTo('iron-sword', `${SITE}/wiki/a/troll`)?.to).toBe('/wiki/a/iron-sword');
    expect(navigationTo('?view=compare', `${SITE}/wiki/c/Weapons`)?.to).toBe('/wiki/c/Weapons?view=compare');
  });

  it('keeps the encoding the address bar will show', () => {
    expect(navigationTo("/wiki/c/Can't be Teleported?view=compare", `${SITE}/wiki/browse`)?.to).toBe(
      "/wiki/c/Can't%20be%20Teleported?view=compare",
    );
    expect(navigationTo('/wiki?q=núcleo', `${SITE}/wiki/browse`)?.to).toBe('/wiki?q=n%C3%BAcleo');
  });

  it('is null for an address it cannot read', () => {
    expect(navigationTo('http://[bad', `${SITE}/wiki`)).toBeNull();
    expect(navigationTo('/wiki', 'not a url')).toBeNull();
  });
});

describe('formNavigation', () => {
  const article = `${SITE}/wiki/a/iron-sword`;
  const fields = (...pairs: [string, string][]) => () => pairs;

  it('starts on a search form that names its page (next/form)', () => {
    expect(formNavigation({ action: '/wiki', method: null, target: null }, fields(['q', 'iron sword']), article)).toEqual({
      fromPath: '/wiki/a/iron-sword',
      fromUrl: '/wiki/a/iron-sword',
      // Spaces as a form sends them, which is what the router puts in the address.
      to: '/wiki?q=iron+sword',
    });
    expect(formNavigation({ action: '/wiki', method: 'GET', target: '_self' }, fields(['q', '']), article)?.to).toBe(
      '/wiki?q=',
    );
  });

  it("replaces the action's own query with the fields", () => {
    expect(formNavigation({ action: '/wiki?q=old&x=1', method: 'get', target: '' }, fields(['q', 'troll']), article)?.to).toBe(
      '/wiki?q=troll',
    );
    expect(formNavigation({ action: '/wiki?q=old', method: 'get', target: '' }, fields(), article)?.to).toBe('/wiki');
  });

  it("leaves a form without an action alone, and never reads its fields", () => {
    const untouched = () => {
      throw new Error('fields read');
    };
    // The chat's question, the sign-in, the search page's own field.
    expect(formNavigation({ action: null, method: null, target: null }, untouched, article)).toBeNull();
    expect(formNavigation({ action: '/api/auth/login', method: 'post', target: null }, untouched, article)).toBeNull();
    expect(formNavigation({ action: '/wiki', method: 'dialog', target: null }, untouched, article)).toBeNull();
    expect(formNavigation({ action: '/wiki', method: 'get', target: '_blank' }, untouched, article)).toBeNull();
  });

  it('ignores a form that leads off the site or back to the page on screen', () => {
    expect(
      formNavigation({ action: 'https://duckduckgo.com/', method: null, target: null }, fields(['q', 'x']), article),
    ).toBeNull();
    expect(
      formNavigation({ action: '/wiki', method: null, target: null }, fields(['q', 'troll']), `${SITE}/wiki?q=troll`),
    ).toBeNull();
  });
});

describe('linkToPageOnScreen', () => {
  const guide = `${SITE}/wiki/guide`;

  it('is true for a plain click on a link to the page on screen, or to a place on it', () => {
    expect(linkToPageOnScreen(PLAIN, link('/wiki/guide'), guide)).toBe(true);
    expect(linkToPageOnScreen(PLAIN, link('#plains', {}, guide), guide)).toBe(true);
    expect(linkToPageOnScreen(PLAIN, link('/wiki/guide'), `${guide}#plains`)).toBe(true);
    // The tab bar's own tab, on the page it names.
    expect(linkToPageOnScreen(PLAIN, link('/wiki/browse', { target: '_self' }), `${SITE}/wiki/browse`)).toBe(true);
  });

  it('is false for a link to another page, which is a change of its own', () => {
    expect(linkToPageOnScreen(PLAIN, link('/wiki/a/troll'), guide)).toBe(false);
    expect(linkToPageOnScreen(PLAIN, link('/wiki/guide?x=1'), guide)).toBe(false);
  });

  it('is false for a click the browser takes elsewhere, and for a link off the site', () => {
    expect(linkToPageOnScreen({ ...PLAIN, ctrlKey: true }, link('/wiki/guide'), guide)).toBe(false);
    expect(linkToPageOnScreen({ ...PLAIN, button: 1 }, link('/wiki/guide'), guide)).toBe(false);
    expect(linkToPageOnScreen(PLAIN, link('/wiki/guide', { target: '_blank' }), guide)).toBe(false);
    expect(linkToPageOnScreen(PLAIN, link('/wiki/guide', { download: true }), guide)).toBe(false);
    expect(linkToPageOnScreen(PLAIN, link('https://valheim.fandom.com/wiki/guide'), guide)).toBe(false);
  });
});

describe('outcome', () => {
  const toArticle = { fromPath: '/wiki', fromUrl: '/wiki?q=troll', to: '/wiki/a/troll' };

  it('is waiting while the address is the one the tap was made from', () => {
    expect(outcome(toArticle, { pathname: '/wiki', search: '?q=troll' })).toBe('waiting');
  });

  it('has landed once the reader is on another page, wherever a redirect took them', () => {
    expect(outcome(toArticle, { pathname: '/wiki/a/troll', search: '' })).toBe('landed');
    const caseVariant = { fromPath: '/wiki/browse', fromUrl: '/wiki/browse', to: '/wiki/c/weapons' };
    expect(outcome(caseVariant, { pathname: '/wiki/c/Weapons', search: '' })).toBe('landed');
    const signIn = { fromPath: '/wiki', fromUrl: '/wiki', to: '/' };
    expect(outcome(signIn, { pathname: '/login', search: '?next=%2F' })).toBe('landed');
  });

  it('has landed, for a change of query alone, only on the very address it went to', () => {
    const compare = { fromPath: '/wiki/c/Weapons', fromUrl: '/wiki/c/Weapons', to: '/wiki/c/Weapons?view=compare' };
    expect(outcome(compare, { pathname: '/wiki/c/Weapons', search: '' })).toBe('waiting');
    expect(outcome(compare, { pathname: '/wiki/c/Weapons', search: '?view=compare' })).toBe('landed');
  });

  it('is dropped once the page writes another query under the same path, as Next then drops the change', () => {
    // With no state, which Next takes in as a restore. (The search page writes
    // what is typed so, but not once a tap on a link to another page has set
    // it leaving: its writes then pass the router by.)
    const fromList = { fromPath: '/wiki/c/Weapons', fromUrl: '/wiki/c/Weapons', to: '/wiki/a/iron-sword' };
    expect(outcome(fromList, { pathname: '/wiki/c/Weapons', search: '?x=1' })).toBe('dropped');
    const fromCompare = { ...fromList, fromUrl: '/wiki/c/Weapons?view=compare' };
    expect(outcome(fromCompare, { pathname: '/wiki/c/Weapons', search: '?view=compare&x=1' })).toBe('dropped');
    expect(outcome(fromCompare, { pathname: '/wiki/c/Weapons', search: '' })).toBe('dropped');
    // Another query than the one asked for, under the same path.
    const compare = { fromPath: '/wiki/c/Weapons', fromUrl: '/wiki/c/Weapons', to: '/wiki/c/Weapons?view=compare' };
    expect(outcome(compare, { pathname: '/wiki/c/Weapons', search: '?view=compare&tab=2' })).toBe('dropped');
  });
});
