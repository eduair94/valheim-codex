/**
 * The conversation on screen, kept in the address as `/?c=<id>`.
 *
 * The thread used to live only in component state, so following a citation
 * and coming back — or a reload, or the chat tab — opened an empty chat, and
 * the reader's follow-up ("¿y cuánto daño hace?") went out as a new,
 * context-free conversation. With the id in the address a reload, a new tab or
 * a bookmark finds the thread again; the session store
 * (`./session-store.ts`) covers navigation within the app, which Next serves
 * from its client cache without asking the server.
 */

/** The query parameter. */
export const CONVERSATION_PARAM = 'c';

/** Longest question, in characters; the server refuses more (`MAX_QUESTION_CHARS` in chat-server/request.ts). */
export const MAX_QUESTION_CHARS = 2000;

/** The alphabet the server accepts for a conversation id (`CONVERSATION_ID` in chat-server/request.ts). */
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID.test(value);
}

/**
 * The conversation id a page's `searchParams` or a `location.search` names,
 * or null. A repeated parameter (`?c=a&c=b`) names none: guessing which one
 * was meant could open the wrong thread.
 */
export function conversationFromParams(params: URLSearchParams | Record<string, string | string[] | undefined>): string | null {
  const raw = params instanceof URLSearchParams ? params.getAll(CONVERSATION_PARAM) : [params[CONVERSATION_PARAM]].flat();
  const values = raw.filter((value): value is string => typeof value === 'string');
  return values.length === 1 && isConversationId(values[0]) ? values[0] : null;
}

/** `/?c=<id>`, or `/` for no conversation. */
export function conversationHref(id: string | null): string {
  return id ? `/?${CONVERSATION_PARAM}=${encodeURIComponent(id)}` : '/';
}
