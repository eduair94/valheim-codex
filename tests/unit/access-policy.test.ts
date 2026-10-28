import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_HOME,
  CHAT_QUERY_PARAMS,
  hasChatIntent,
  isPublicPath,
  loginHref,
  PUBLIC_HOME,
  requiredAccess,
  safeNext,
} from '@/lib/auth/access';
import { CONVERSATION_PARAM, conversationHref } from '@/lib/chat/conversation-url';
import { GRAPH_URL } from '@/lib/craft/graph-client';

/**
 * The reader is public and the chat is not. That split is the whole security
 * posture of this deployment, and it is one edited list away from either
 * locking the site back up or handing the model bill to the internet — so it
 * is pinned here rather than left to reviewers noticing a changed constant.
 */
describe('access policy', () => {
  describe('public surface', () => {
    it.each([
      '/wiki',
      '/wiki/browse',
      '/wiki/a/iron-sword',
      '/wiki/c/Weapons',
      '/wiki/craft',
      '/api/wiki/search',
      '/api/wiki/index',
      '/api/wiki/recipes',
      '/login',
      '/api/auth/login',
      '/api/auth/session',
      '/api/auth/byok',
      '/api/auth/puter',
      '/api/health',
      '/api/csp-report',
      '/robots.txt',
      '/sitemap.xml',
    ])('serves %s without a session', (path) => {
      expect(isPublicPath(path)).toBe(true);
      expect(requiredAccess(path)).toBe('public');
    });

    it('serves the recipe graph the planner downloads without a session', () => {
      // By the address the planner asks for: gated, the planner of a reader
      // who never signed in would have nothing to compute with.
      const { pathname } = new URL(GRAPH_URL, 'https://valheim.example');
      expect(requiredAccess(pathname)).toBe('public');
    });
  });

  describe('gated surface', () => {
    /*
     * Everything that spends model tokens or reads someone's conversations.
     * A failure here is not a broken feature, it is an open tab on the bill.
     */
    it.each([
      '/',
      '/api/chat',
      '/api/conversations',
      '/api/conversations/abc-123',
      '/api/ingest',
    ])('requires a session for %s', (path) => {
      expect(isPublicPath(path)).toBe(false);
    });

    it.each(['/', '/api/chat', '/api/chat/prepare', '/api/chat/complete', '/api/conversations', '/api/conversations/x'])(
      'opens %s to anyone signed in by any method',
      (path) => {
        expect(requiredAccess(path)).toBe('chat');
      },
    );

    it.each(['/api/ingest', '/api/chatter', '/api/conversationsx', '/random-junk', '/api/new-thing'])(
      'keeps %s to the password holder',
      (path) => {
        // Re-indexing, plus anything nobody has opened on purpose yet.
        expect(requiredAccess(path)).toBe('password');
      },
    );
  });

  describe('prefix matching', () => {
    /*
     * The reason `isPublicPath` does not use `startsWith`. A route added later
     * whose name merely begins with a public prefix must not inherit its
     * openness.
     */
    it.each(['/wikileaks', '/wiki-admin', '/logins', '/api/wiki-admin', '/api/healthcheck', '/robots.txt.bak', '/sitemap.xmlx'])(
      'does not let %s inherit a public prefix',
      (path) => {
        expect(isPublicPath(path)).toBe(false);
      },
    );

    it('matches a prefix exactly and at a path boundary only', () => {
      expect(isPublicPath('/wiki')).toBe(true);
      expect(isPublicPath('/wiki/')).toBe(true);
      expect(isPublicPath('/wikix')).toBe(false);
    });
  });

  describe('login destinations', () => {
    it('sends anonymous visitors to the reader, not the chat', () => {
      expect(PUBLIC_HOME).toBe('/wiki');
      expect(isPublicPath(PUBLIC_HOME)).toBe(true);
    });

    it('keeps the chat as the destination after signing in', () => {
      expect(AUTHENTICATED_HOME).toBe('/');
    });

    it('omits a redundant next parameter for the default destination', () => {
      expect(loginHref()).toBe('/login');
      expect(loginHref(AUTHENTICATED_HOME)).toBe('/login');
    });

    it('encodes the destination so a path with a query survives the round trip', () => {
      expect(loginHref('/api/conversations?id=1&x=2')).toBe(
        '/login?next=%2Fapi%2Fconversations%3Fid%3D1%26x%3D2',
      );
    });
  });

  describe('chat intent on the bare domain', () => {
    it('is the chat’s own parameters, and nothing a shared link picks up on the way', () => {
      expect(CHAT_QUERY_PARAMS).toEqual(['about', 'c']);
      expect(hasChatIntent(new URLSearchParams('about=Iron%20Sword'))).toBe(true);
      expect(hasChatIntent(new URLSearchParams('about='))).toBe(true);
      for (const query of ['', 'fbclid=abc', 'utm_source=x&utm_medium=y', 'gclid=1', 'q=hierro', 'cc=1', 'C=abc']) {
        expect(hasChatIntent(new URLSearchParams(query)), query).toBe(false);
      }
    });

    it('includes the open conversation (`/?c=<id>`), which the chat keeps in the address', () => {
      // The parameter the chat writes (`conversationHref`), so the two cannot drift apart.
      expect(CHAT_QUERY_PARAMS).toContain(CONVERSATION_PARAM);
      const written = new URL(conversationHref('2b0c1f6e-9a8d-4c3b-8e7f-1a2b3c4d5e6f'), 'https://x.invalid');
      expect(hasChatIntent(written.searchParams)).toBe(true);
      expect(hasChatIntent(new URLSearchParams('c=abc&utm_source=x'))).toBe(true);
      expect(hasChatIntent({ c: 'abc' })).toBe(true);
      expect(hasChatIntent({ c: ['a', 'b'] })).toBe(true);
      // And the sign-in brings the reader back to it.
      expect(loginHref(conversationHref('abc'))).toBe('/login?next=%2F%3Fc%3Dabc');
      expect(safeNext('/?c=abc')).toBe('/?c=abc');
    });

    it('reads a page’s resolved searchParams the same way', () => {
      expect(hasChatIntent({ about: 'Iron Sword' })).toBe(true);
      expect(hasChatIntent({ about: ['a', 'b'] })).toBe(true);
      expect(hasChatIntent({ fbclid: 'abc', about: undefined })).toBe(false);
      expect(hasChatIntent({})).toBe(false);
    });
  });
});

describe('safeNext', () => {
  /*
   * Every one of these left the site after a real sign-in on production, or
   * would have with the first proposed fix, which validated the input but
   * returned the parser's normalised output: dot segments collapse
   * `/.//evil` into `//evil`, which a browser reads as another host.
   */
  it.each([
    ['protocol-relative', '//x'],
    ['backslash', '/\\x'],
    ['tab', '/\t/x'],
    ['newline', '/\n/x'],
    ['carriage return', '/\r/x'],
    ['dot segment', '/.//x'],
    ['parent segment', '/a/..//x'],
    ['encoded dot', '/%2e//x'],
    ['dot and backslash', '/./\\x'],
    ['several dots', '/././/x'],
    ['javascript: URL', 'javascript:x'],
    ['absolute URL', 'https://evil.example/phish'],
    ['scheme-relative with userinfo', '//user@evil.example'],
    ['backslash pair', '/\\\\evil.example'],
  ])('sends a %s target home', (_name, raw) => {
    expect(safeNext(raw)).toBe(AUTHENTICATED_HOME);
  });

  it('never returns anything another host could be read from', () => {
    for (const raw of ['//x', '/\\x', '/\t/x', '/.//x', '/a/..//x', '/%2e//x', '/./\\x', '/%2e%2e//x', '/..//x']) {
      const out = safeNext(raw);
      expect(new URL(out, 'https://valheim.digitalshopuy.com').origin).toBe('https://valheim.digitalshopuy.com');
    }
  });

  it('sends anything that is not a single string home', () => {
    // A repeated `?next=` reaches the page as an array.
    expect(safeNext(['/a', '/b'])).toBe(AUTHENTICATED_HOME);
    expect(safeNext(undefined)).toBe(AUTHENTICATED_HOME);
    expect(safeNext(null)).toBe(AUTHENTICATED_HOME);
    expect(safeNext(42)).toBe(AUTHENTICATED_HOME);
    expect(safeNext('')).toBe(AUTHENTICATED_HOME);
    expect(safeNext('wiki')).toBe(AUTHENTICATED_HOME);
  });

  it.each(['/', '/wiki/a/iron-sword', '/c/abc?x=1&y=2#h', '/?about=Iron%20Sword', '/wiki/c/Stacks%20%26%20Piles'])(
    'keeps the legitimate destination %s unchanged',
    (path) => {
      expect(safeNext(path)).toBe(path);
    },
  );
});
