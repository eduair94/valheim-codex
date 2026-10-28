import { isValidElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatPrincipal } from '@/lib/auth/principal';

/*
 * The chat page's server half, with its data sources replaced: who is asking,
 * the conversation `?c=` names, and the read ceiling. What it decides is
 * checked on the element it renders, without rendering it.
 */

const state: { principal: ChatPrincipal | null; limited: boolean } = { principal: null, limited: false };

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7' }),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
}));
vi.mock('@/lib/auth/principal-server', () => ({ getChatPrincipal: async () => state.principal }));
vi.mock('@/lib/db/client', () => ({ getDb: async () => ({}) }));
vi.mock('@/lib/db/create-db', () => ({ rawQuery: async () => [{ chunks: '10', pages: '2', last_indexed: null }] }));

const repo = vi.hoisted(() => ({
  listConversations: vi.fn(async () => []),
  getConversation: vi.fn(async (_db: unknown, id: string) => ({ id, title: 'Bonemass', lang: 'es' })),
  listRecentMessages: vi.fn(async () => ({
    messages: [{ id: 'abc:q1', role: 'user' as const, parts: [{ type: 'text', text: '¿Cómo invoco a Bonemass?' }], citations: [] }],
    truncated: false,
  })),
}));
vi.mock('@/lib/db/repo', () => repo);

const limit = vi.hoisted(() => ({
  limitConversationRead: vi.fn((): Response | null => null),
}));
vi.mock('@/lib/chat-server/read-limit', () => limit);

const { default: Page } = await import('@/app/page');

type ChatProps = { initialConversation: { id: string } | null };

async function render(params: Record<string, string | string[]>): Promise<ReactElement<ChatProps>> {
  const element: unknown = await Page({ searchParams: Promise.resolve(params) });
  if (!isValidElement(element)) throw new Error('the chat page rendered no element');
  return element as ReactElement<ChatProps>;
}

async function redirected(params: Record<string, string | string[]>): Promise<string | undefined> {
  return render(params).then(
    () => undefined,
    (error: unknown) => (error as { url?: string }).url,
  );
}

beforeEach(() => {
  state.principal = { kind: 'password', profile: 'Ragnar' };
  limit.limitConversationRead.mockImplementation(() => (state.limited ? Response.json({ error: 'rate_limited' }, { status: 429 }) : null));
});

afterEach(() => {
  state.limited = false;
  vi.clearAllMocks();
});

describe('the chat page', () => {
  describe('signed out (the proxy decides first; the page agrees)', () => {
    it('sends a reload of a conversation to sign in, and back to it', async () => {
      state.principal = null;
      expect(await redirected({ c: 'abc' })).toBe('/login?next=%2F%3Fc%3Dabc');
      expect(await redirected({ about: 'Iron Sword' })).toBe('/login?next=%2F%3Fabout%3DIron%2BSword');
    });

    it('opens the reader for the bare domain and shared-link noise', async () => {
      state.principal = null;
      expect(await redirected({})).toBe('/wiki');
      expect(await redirected({ fbclid: 'x' })).toBe('/wiki');
    });
  });

  describe('opening `?c=` on the server', () => {
    it('loads the conversation, counted against the read ceiling', async () => {
      const element = await render({ c: 'abc' });
      expect(element.props.initialConversation).toMatchObject({ id: 'abc' });
      expect(limit.limitConversationRead).toHaveBeenCalledTimes(1);
      expect(limit.limitConversationRead).toHaveBeenCalledWith('Ragnar', expect.any(Headers));
    });

    it('opens without it past the ceiling, leaving the browser to say how long to wait', async () => {
      state.limited = true;
      const element = await render({ c: 'abc' });
      expect(element.props.initialConversation).toBeNull();
      expect(repo.getConversation).not.toHaveBeenCalled();
      expect(repo.listRecentMessages).not.toHaveBeenCalled();
    });

    it('counts nothing when no conversation is asked for', async () => {
      const unaddressed: Record<string, string | string[]>[] = [{}, { about: 'Iron Sword' }, { c: ['a', 'b'] }, { c: 'not an id!' }];
      for (const params of unaddressed) {
        const element = await render(params);
        expect(element.props.initialConversation).toBeNull();
      }
      expect(limit.limitConversationRead).not.toHaveBeenCalled();
    });
  });
});
