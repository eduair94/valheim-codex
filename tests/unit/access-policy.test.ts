import { describe, expect, it } from 'vitest';
import { AUTHENTICATED_HOME, isPublicPath, loginHref, PUBLIC_HOME } from '@/lib/auth/access';

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
      '/api/wiki/search',
      '/api/wiki/index',
      '/login',
      '/api/auth/login',
      '/api/auth/session',
      '/api/health',
    ])('serves %s without a session', (path) => {
      expect(isPublicPath(path)).toBe(true);
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
  });

  describe('prefix matching', () => {
    /*
     * The reason `isPublicPath` does not use `startsWith`. A route added later
     * whose name merely begins with a public prefix must not inherit its
     * openness.
     */
    it.each(['/wikileaks', '/wiki-admin', '/logins', '/api/wiki-admin', '/api/healthcheck'])(
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
});
