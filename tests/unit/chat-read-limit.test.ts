import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationReadLimitFromEnv, createConversationReadLimit } from '@/lib/chat-server/read-limit';

/**
 * Opening a conversation costs no quota and can cost a megabyte; this is the
 * ceiling on how often a reader, or an address, may do it.
 */

const from = (ip?: string) => new Headers(ip ? { 'cf-connecting-ip': ip } : {});

describe('conversation reads', () => {
  it('refuses a reader past the ceiling with a 429 in the quota shape, then lets them back in', async () => {
    const limit = createConversationReadLimit({ limit: 2, windowMs: 60_000 });
    expect(limit('puter:ana', from(), 0)).toBeNull();
    expect(limit('puter:ana', from(), 1)).toBeNull();

    const refused = limit('puter:ana', from(), 10_000);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toBe('50');
    expect(refused?.headers.get('cache-control')).toBe('private, no-store');
    expect(await refused?.json()).toEqual({ error: 'rate_limited', bucket: 'conversations:read', retryAfter: 50 });

    // Someone else is not affected, and the window ends.
    expect(limit('puter:beto', from(), 10_000)).toBeNull();
    expect(limit('puter:ana', from(), 60_000)).toBeNull();
  });

  it('counts an address across the readers behind it', async () => {
    const limit = createConversationReadLimit({ limit: 2, windowMs: 60_000 });
    expect(limit('puter:a', from('203.0.113.9'), 0)).toBeNull();
    expect(limit('puter:b', from('203.0.113.9'), 0)).toBeNull();
    const refused = limit('puter:c', from('203.0.113.9'), 0);
    expect(await refused?.json()).toMatchObject({ error: 'rate_limited', bucket: 'conversations:read-ip' });
  });

  it('counts a request with no usable address per reader only', () => {
    const limit = createConversationReadLimit({ limit: 1, windowMs: 60_000 });
    expect(limit('puter:a', from(), 0)).toBeNull();
    expect(limit('puter:b', from(), 0)).toBeNull();
  });

  it('reads its ceiling from the environment, sixty by default, zero for none', () => {
    expect(conversationReadLimitFromEnv({})).toEqual({ limit: 60, windowMs: 60_000 });
    expect(conversationReadLimitFromEnv({ CONVERSATION_READS_PER_MINUTE: '5' }).limit).toBe(5);
    expect(conversationReadLimitFromEnv({ CONVERSATION_READS_PER_MINUTE: 'lots' }).limit).toBe(60);

    const off = createConversationReadLimit(conversationReadLimitFromEnv({ CONVERSATION_READS_PER_MINUTE: '0' }));
    for (let i = 0; i < 100; i++) expect(off('puter:a', from('203.0.113.9'), 0)).toBeNull();
  });

  describe('one ceiling for every copy of the module', () => {
    const SHARED = Symbol.for('wiki-valheim.conversation-read-limit');

    afterEach(() => {
      delete (globalThis as Record<symbol, unknown>)[SHARED];
      vi.unstubAllEnvs();
    });

    // Next bundles the module once for pages and once for route handlers;
    // vi.resetModules() between two imports gives two copies the same way.
    it('counts the chat page and the conversation route against the same reads', async () => {
      vi.stubEnv('CONVERSATION_READS_PER_MINUTE', '2');
      vi.resetModules();
      const page = await import('@/lib/chat-server/read-limit');
      vi.resetModules();
      const route = await import('@/lib/chat-server/read-limit');
      expect(page).not.toBe(route);

      expect(page.limitConversationRead('puter:ana', from('203.0.113.77'))).toBeNull();
      expect(route.limitConversationRead('puter:ana', from('203.0.113.77'))).toBeNull();
      const refused = route.limitConversationRead('puter:ana', from('203.0.113.77'));
      expect(refused?.status).toBe(429);
      expect(await refused?.json()).toMatchObject({ error: 'rate_limited', bucket: 'conversations:read' });
      expect(page.limitConversationRead('puter:ana', from('203.0.113.77'))?.status).toBe(429);
    });
  });
});
