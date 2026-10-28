import type { Lang } from '@/lib/i18n/strings';
import { errorFromResponse, waitPhrase, type Notice } from './errors';
import { parseConversationResponse, type LoadedConversation } from './history';

/**
 * The reader's saved conversations: the sidebar list, opening one, deleting
 * one. Each call answers with a code instead of throwing, so the chat can say
 * what happened — a failed open or delete used to do nothing at all.
 */

export type ConversationSummary = {
  id: string;
  title: string;
  lang: Lang;
  updatedAt: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Failure = { ok: false; code: string; status: number | null; retryAfter?: number };

function parseList(body: unknown): ConversationSummary[] | null {
  const list = (body as { conversations?: unknown } | null)?.conversations;
  if (!Array.isArray(list)) return null;
  return list.filter(
    (c): c is ConversationSummary =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as ConversationSummary).id === 'string' &&
      typeof (c as ConversationSummary).title === 'string' &&
      typeof (c as ConversationSummary).updatedAt === 'string',
  );
}

async function request(
  path: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<{ ok: true; response: Response } | Failure> {
  try {
    const response = await fetchImpl(path, init);
    if (response.ok) return { ok: true, response };
    const error = await errorFromResponse(response);
    return { ok: false, code: error.code, status: error.status, retryAfter: error.retryAfter };
  } catch {
    return { ok: false, code: 'network', status: null };
  }
}

export async function fetchConversations(
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; conversations: ConversationSummary[] } | Failure> {
  const result = await request('/api/conversations', {}, fetchImpl);
  if (!result.ok) return result;
  const conversations = parseList(await result.response.json().catch(() => null));
  return conversations ? { ok: true, conversations } : { ok: false, code: 'generic', status: result.response.status };
}

export async function fetchConversation(
  id: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; conversation: LoadedConversation } | Failure> {
  const result = await request(`/api/conversations/${encodeURIComponent(id)}`, {}, fetchImpl);
  if (!result.ok) return result;
  const conversation = parseConversationResponse(await result.response.json().catch(() => null));
  return conversation ? { ok: true, conversation } : { ok: false, code: 'generic', status: result.response.status };
}

/** Deleting what is already gone (another tab got there first) is a success. */
export async function deleteConversation(id: string, fetchImpl: FetchLike = fetch): Promise<{ ok: true } | Failure> {
  const result = await request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetchImpl);
  if (result.ok || result.status === 404) return { ok: true };
  return result;
}

/**
 * What the chat says when opening or deleting a conversation failed.
 *
 * A refused read says how long to wait. Opening conversations is capped per
 * reader and per address (`GET /api/conversations/[id]`: 429 `rate_limited`,
 * `CONVERSATION_READS_PER_MINUTE`), and that refusal used to read as "something
 * failed, try again" — at once, which the cap would refuse again. The wait
 * comes from the body's `retryAfter`, else the `Retry-After` header
 * (`errorFromResponse`); with neither, the sentence still says to wait.
 */
export function conversationNotice(failure: Failure, action: 'open' | 'delete'): Notice {
  if (failure.code === 'unauthorized') return { text: (t) => t.chatErrorSessionEnded, actions: ['signin'] };
  if (failure.status === 404) return { text: (t) => t.chatNoticeOpenNotFound };
  if (failure.code === 'network') return { text: (t) => t.errorNetwork };
  if (failure.code === 'rate_limited') {
    const wait = failure.retryAfter;
    if (action === 'open') {
      return {
        text: (t) => (wait ? t.chatNoticeOpenRateLimitedWait.replace('{wait}', waitPhrase(wait, t)) : t.chatNoticeOpenRateLimited),
      };
    }
    // No route caps deleting; this is a rule at the edge, and says so in its own words.
    return { text: (t) => (wait ? t.authErrorRateLimited.replace('{wait}', waitPhrase(wait, t)) : t.loginRateLimited) };
  }
  // The database down, or a gateway's page during a deploy (`errorFromResponse`).
  if (failure.code === 'unavailable') return { text: (t) => t.chatErrorUnavailable };
  return { text: (t) => t.errorGeneric };
}

/** Refusals about the moment, not about the conversation: it may well open later. */
const REFUSED_FOR_NOW = new Set(['rate_limited', 'unavailable', 'network']);

/**
 * Whether the address goes on naming a conversation (`/?c=<id>`) that could
 * not be opened from it, rather than going back to what is on screen
 * (`shown`: that conversation's id, or null for an empty thread).
 *
 * Only after a refusal for now (the read limit's wait, the server down, no
 * network) and only while nothing else is on screen: a reload once the wait
 * is over then opens the conversation, where it used to open an empty chat.
 * With a thread on screen the address names that one, because coming back
 * to the page (Back, after following a citation) opens what the address
 * names. A conversation that is gone or someone else's, a session that
 * ended, or an answer that made no sense: the address lets it go.
 */
export function keepsAddress(failure: Failure, shown: string | null): boolean {
  return shown === null && failure.status !== 404 && REFUSED_FOR_NOW.has(failure.code);
}
