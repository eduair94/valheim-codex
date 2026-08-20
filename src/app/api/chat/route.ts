import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
} from 'ai';
import { z } from 'zod';
import { getSession, unauthorizedResponse } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import {
  appendMessage,
  createConversation,
  getConversation,
  touchConversation,
} from '@/lib/db/repo';
import type { Citation } from '@/lib/db/schema';
import { messageText, type ValheimUIMessage } from '@/lib/chat-types';
import { strings } from '@/lib/i18n/strings';
import { buildContext, buildSystemPrompt, buildUserPrompt, noContextAnswer } from '@/lib/rag/prompt';
import { retrieve } from '@/lib/rag/retrieve';
import { streamWithFallback } from '@/lib/rag/fallback';
import { answerCandidates } from '@/lib/rag/provider';
import { getLeadImages } from '@/lib/db/wiki-repo';
import { rewriteQueries } from '@/lib/rag/rewrite';

export const runtime = 'nodejs';
/** Retrieval plus generation can exceed the default limit on a cold start. */
export const maxDuration = 60;

const bodySchema = z.object({
  /**
   * Not `id`: the AI SDK transport puts the chat's own id under that key, so
   * the conversation this thread belongs to is sent under its own name.
   */
  conversationId: z.string().min(1).max(64),
  lang: z.enum(['es', 'en']).default('es'),
  messages: z.array(z.unknown()).min(1),
});

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });

  const { conversationId, lang } = parsed.data;
  const messages = parsed.data.messages as ValheimUIMessage[];
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== 'user') {
    return Response.json({ error: 'last_message_must_be_user' }, { status: 400 });
  }

  const question = messageText(lastMessage);
  if (!question) return Response.json({ error: 'empty_question' }, { status: 400 });

  const db = await getDb();

  // Create the conversation on first use, titled from the opening question.
  const existing = await getConversation(db, conversationId, session.profile);
  if (!existing) {
    await createConversation(db, {
      id: conversationId,
      profile: session.profile,
      title: question.slice(0, 60),
      lang,
    });
  }

  await appendMessage(db, {
    id: lastMessage.id,
    conversationId,
    role: 'user',
    parts: lastMessage.parts,
  });

  const history = messages.slice(0, -1).slice(-6).map((m) => ({
    role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    text: messageText(m),
  }));

  const stream = createUIMessageStream<ValheimUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: 'data-status', id: 'status', data: { stage: 'rewriting' } });
      const queries = await rewriteQueries({ question, history });

      writer.write({ type: 'data-status', id: 'status', data: { stage: 'searching', queries } });
      const chunks = await retrieve(db, { queries });

      const { context, citations } = buildContext(chunks);

      /*
       * Attach each cited article's lead image before the sources go out, so
       * an `[img:n]` marker in the answer already has an address to resolve
       * against by the time it streams in. One query for the whole set.
       */
      const images = await getLeadImages(
        db,
        citations.map((citation) => citation.slug ?? '').filter(Boolean),
      );
      for (const citation of citations) {
        citation.image = citation.slug ? (images.get(citation.slug) ?? null) : null;
      }

      writer.write({ type: 'data-sources', id: 'sources', data: { citations } });

      // Nothing retrieved: say so directly instead of asking the model to
      // improvise an answer with no grounding.
      if (chunks.length === 0) {
        const text = noContextAnswer(lang);
        writer.write({ type: 'text-start', id: 'empty' });
        writer.write({ type: 'text-delta', id: 'empty', delta: text });
        writer.write({ type: 'text-end', id: 'empty' });
        await persistAssistant(conversationId, text, citations);
        return;
      }

      writer.write({ type: 'data-status', id: 'status', data: { stage: 'answering' } });

      const modelMessages = await convertToModelMessages([
        ...history.map((h) => ({
          role: h.role,
          parts: [{ type: 'text' as const, text: h.text }],
        })),
        { role: 'user' as const, parts: [{ type: 'text' as const, text: buildUserPrompt(question, context) }] },
      ] as Omit<ValheimUIMessage, 'id'>[]);

      /*
       * Grok first, Gemini behind it. A provider that is going to refuse —
       * an unpaid account, an exhausted quota — does so before the first
       * token, so `streamWithFallback` waits for that token before committing
       * and the reader never sees a switch happen.
       */
      const { stream, candidate } = await streamWithFallback(answerCandidates(), (c, attempt) =>
        streamText({
          model: c.model,
          maxRetries: attempt.maxRetries,
          system: buildSystemPrompt(lang),
          messages: modelMessages,
          temperature: 0.2,
          onFinish: async ({ text }) => {
            await persistAssistant(conversationId, text, citations);
          },
        }),
      );
      console.info(`[chat] answered by ${candidate.name}`);

      // `sendStart: false` because the surrounding stream already opened this
      // message to carry the citations. Letting the model stream announce its
      // own start makes the client render a second assistant message, so the
      // answer appears twice with the sources duplicated under each copy.
      writer.merge(toUIMessageStream({ stream, sendStart: false }));
    },
    onError: (error) => {
      console.error('[chat]', error);

      /*
       * A rate limit is the most likely failure on a free-tier key, and it is
       * the one the reader can act on: waiting fixes it. Saying so beats a
       * generic "something broke" that invites a pointless retry loop.
       */
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited =
        /429|RESOURCE_EXHAUSTED|quota/i.test(message) ||
        (typeof error === 'object' && error !== null && 'statusCode' in error &&
          (error as { statusCode?: number }).statusCode === 429);

      if (rateLimited) return strings(lang).errorRateLimited;

      return lang === 'es'
        ? 'Se cortó la respuesta. Probá de nuevo.'
        : 'The response failed. Please try again.';
    },
  });

  async function persistAssistant(id: string, text: string, citations: Citation[]): Promise<void> {
    try {
      await appendMessage(db, {
        id: crypto.randomUUID(),
        conversationId: id,
        role: 'assistant',
        parts: [{ type: 'text', text }],
        citations,
      });
      await touchConversation(db, id);
    } catch (error) {
      // Losing history is bad but must not fail a response already streamed.
      console.error('[chat] failed to persist assistant message', error);
    }
  }

  return createUIMessageStreamResponse({ stream });
}
