import { z } from 'zod';
import { MAX_API_BODY_BYTES } from '@/lib/auth/proxy-policy';
import { messageText } from '@/lib/chat-types';
import { jsonError } from './http';
import { codePointLength, storableText } from './text';

/**
 * What a chat request may carry, checked before anything is spent on it.
 *
 * The body used to be `messages: z.array(z.unknown())`: the whole thread as
 * the browser held it, any size, any shape, with the last message's parts
 * stored verbatim. A tiny question beside a 9 MB data part was a 9 MB row,
 * and the "history" the model saw was whatever the client claimed had been
 * said. Now the client sends only the new question, the server rebuilds the
 * history from what it stored itself, and stores only the question's text.
 */

/** A conversation id: the client's `crypto.randomUUID()`, or anything of that alphabet. */
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The id the client generated for a message (the AI SDK's are 16 alphanumerics). */
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Longest question, in characters (code points). The composer caps at the same length. */
export const MAX_QUESTION_CHARS = 2000;

/**
 * Body ceiling for `/api/chat`: the proxy's, which refuses anything larger
 * before a route runs, so a larger number here would only be a promise
 * nothing keeps. The current client sends one message, a few KB at most. A
 * tab still running the previous client uploads the whole thread on every
 * question, about 5 KB per answered turn, so after a dozen or so turns its
 * requests are refused with 413 until it reloads and picks up the new client.
 */
export const CHAT_BODY_MAX_BYTES = MAX_API_BODY_BYTES;

export type StoredIds = { user: string; answer: string };

/**
 * The stored ids for a question and its answer.
 *
 * Prefixed with the conversation id, so the same client id in two
 * conversations names two rows, and a retry of one message in one
 * conversation names the same row again. An id that already carries this
 * conversation's prefix is one the client loaded from history (a reopened
 * conversation) and is used as it is. The answer's id is its question's plus
 * `:a` — two colons, which no question id has.
 *
 * Null for an id outside the alphabet, which the caller rejects.
 */
export function storedMessageIds(conversationId: string, messageId: string): StoredIds | null {
  const prefix = `${conversationId}:`;
  const own = messageId.startsWith(prefix) ? messageId.slice(prefix.length) : messageId;
  if (!CLIENT_MESSAGE_ID.test(own)) return null;
  const user = `${prefix}${own}`;
  return { user, answer: `${user}:a` };
}

const lang = z.enum(['es', 'en']).default('es');
const conversationId = z.string().regex(CONVERSATION_ID);
const messageId = z.string().min(1).max(160);

const userMessage = z.object({
  id: messageId,
  role: z.literal('user'),
  parts: z
    .array(z.object({ type: z.string().max(64), text: z.string().optional() }))
    .min(1)
    .max(16),
});

/**
 * `{ conversationId, lang, message }` — the new question only. `messages`
 * (the whole thread) is still read from clients that predate that, and only
 * its last entry is used.
 */
export const chatBodySchema = z.object({
  conversationId,
  lang,
  message: z.unknown().optional(),
  messages: z.array(z.unknown()).max(1000).optional(),
});

export type ChatBody = z.infer<typeof chatBodySchema>;

/** `/api/chat/prepare`: the question for a model that runs in the browser. */
export const prepareBodySchema = z.object({
  conversationId,
  lang,
  message: z.object({ id: messageId, text: z.string() }),
});

/** Longest answer text `/api/chat/complete` stores. */
export const MAX_ANSWER_CHARS = 12_000;

/** `/api/chat/complete`: what the browser's model wrote, and how it ended. */
export const completeBodySchema = z.object({
  grant: z.string().min(1).max(16_384),
  text: z.string().max(MAX_ANSWER_CHARS),
  outcome: z.enum(['complete', 'stopped', 'error']),
});

/**
 * Body ceiling for `/api/chat/complete`, the proxy's as well. 12,000
 * characters of answer are 12–36 KB in UTF-8 and the grant a few more, so a
 * real answer fits; only text made mostly of characters JSON escapes six
 * bytes at a time would not.
 */
export const COMPLETE_BODY_MAX_BYTES = MAX_API_BODY_BYTES;

export type QuestionCheck = { ok: true; question: string; ids: StoredIds } | { ok: false; response: Response };

/**
 * The question's text and stored ids, or the 400/413 that explains why not.
 * The text is made storable here (see `storableText`), before it is measured,
 * so no lone surrogate or NUL ever reaches a database parameter, a title or a
 * prompt, and a question of nothing but control characters is an empty one.
 */
export function checkQuestion(conversation: string, id: string, raw: string): QuestionCheck {
  const ids = storedMessageIds(conversation, id);
  if (!ids) return { ok: false, response: jsonError(400, 'invalid_request') };

  const question = storableText(raw).trim();
  if (!question) return { ok: false, response: jsonError(400, 'empty_question') };
  if (codePointLength(question) > MAX_QUESTION_CHARS) {
    return { ok: false, response: jsonError(413, 'question_too_long', { max: MAX_QUESTION_CHARS }) };
  }
  return { ok: true, question, ids };
}

/** The question in a `/api/chat` body, from `message` or, for an older client, the last of `messages`. */
export function questionFromChatBody(body: ChatBody): QuestionCheck {
  const raw = body.message ?? body.messages?.at(-1);
  const parsed = userMessage.safeParse(raw);
  if (!parsed.success) return { ok: false, response: jsonError(400, 'invalid_request') };
  return checkQuestion(body.conversationId, parsed.data.id, messageText(parsed.data));
}
