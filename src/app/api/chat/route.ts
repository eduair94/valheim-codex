import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { forbiddenOriginResponse, isSameOriginRequest } from '@/lib/auth/origin';
import { getChatPrincipal } from '@/lib/auth/principal-server';
import { answerTurn } from '@/lib/chat-server/answer';
import { chatErrorText } from '@/lib/chat-server/errors';
import { logFailure } from '@/lib/chat-server/failure-log';
import { jsonError, noStore, PRIVATE_NO_STORE } from '@/lib/chat-server/http';
import { payerFor, type Payer } from '@/lib/chat-server/payer';
import { CHAT_BODY_MAX_BYTES, chatBodySchema, questionFromChatBody } from '@/lib/chat-server/request';
import { conversationTitle } from '@/lib/chat-server/text';
import { enforceQuota, historyFromRows } from '@/lib/chat-server/turn';
import type { ValheimUIMessage } from '@/lib/chat-types';
import { getDb, type Db } from '@/lib/db/client';
import { beginTurn, type TurnStartResult } from '@/lib/db/repo';
import { readJsonBody } from '@/lib/http/json-body';

export const runtime = 'nodejs';
/** Retrieval plus generation can exceed the default limit on a cold start. */
export const maxDuration = 60;

/**
 * Answers a question for the readers whose model runs on this server: a
 * password holder (the operator's model chain) or a reader with their own
 * Gemini key (that key, and nothing else). A Puter reader's model runs in
 * their browser, through `/api/chat/prepare` and `/api/chat/complete`.
 *
 * Everything that can refuse the request does so before the stream opens,
 * with a status and a JSON code: the origin, the sign-in, who pays, the body,
 * the quota, the conversation's owner. Only then is anything written, and
 * only then is any model asked.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return noStore(forbiddenOriginResponse());

  const principal = await getChatPrincipal();
  if (!principal) return jsonError(401, 'unauthorized');
  if (principal.kind === 'puter') return jsonError(409, 'use_puter_transport');

  /*
   * Who pays, decided by the two tests allowed to decide it (see payer.ts),
   * and decided here, before anything is read or written. A principal that
   * is neither is refused rather than treated as either. A key that cannot
   * build a model stops the request too: never undefined, see byok-model.ts.
   */
  let payer: Payer | null;
  try {
    payer = payerFor(principal);
  } catch (error) {
    logFailure('chat', error, { stage: 'byok-model' });
    return jsonError(401, 'unauthorized');
  }
  if (!payer) return jsonError(403, 'forbidden');

  const body = await readJsonBody(request, chatBodySchema, CHAT_BODY_MAX_BYTES);
  if (!body.ok) return noStore(body.response);
  const { conversationId, lang } = body.data;
  const checked = questionFromChatBody(body.data);
  if (!checked.ok) return checked.response;
  const { question, ids } = checked;

  let db: Db;
  try {
    db = await getDb();
  } catch (error) {
    logFailure('chat', error, { stage: 'db' });
    return jsonError(503, 'unavailable', {}, { 'Retry-After': '30' });
  }

  const limited = await enforceQuota(db, principal, request.headers);
  if (limited) return limited;

  let turn: TurnStartResult;
  try {
    turn = await beginTurn(db, {
      conversationId,
      profile: principal.profile,
      title: conversationTitle(question),
      lang,
      userMessageId: ids.user,
      answerId: ids.answer,
      question,
    });
  } catch (error) {
    logFailure('chat', error, { stage: 'begin-turn' });
    return jsonError(500, 'internal_error');
  }
  if (!turn.owned) return jsonError(404, 'conversation_not_found');

  const history = historyFromRows(turn.history);

  const stream = createUIMessageStream<ValheimUIMessage>({
    execute: async ({ writer }) => {
      // The answer's id is the stored one, so the client's copy and the
      // database's are the same message.
      writer.write({ type: 'start', messageId: ids.answer });
      await answerTurn({
        writer,
        db,
        profile: principal.profile,
        conversationId,
        ids,
        question,
        history,
        lang,
        payer,
        signal: request.signal,
      });
    },
    // A backstop: `answerTurn` handles its own failures. Anything that still
    // escapes gets the plain sentence, never the SDK's English default.
    onError: (error) => {
      logFailure('chat', error, { stage: 'stream' });
      return chatErrorText('generic', lang);
    },
  });

  return createUIMessageStreamResponse({ stream, headers: { 'Cache-Control': PRIVATE_NO_STORE } });
}
