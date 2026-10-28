import { forbiddenOriginResponse, isSameOriginRequest } from '@/lib/auth/origin';
import { getChatPrincipal } from '@/lib/auth/principal-server';
import { purposeKey } from '@/lib/auth/secrets';
import { logFailure } from '@/lib/chat-server/failure-log';
import { verifyAnswerGrant } from '@/lib/chat-server/grant';
import { jsonError, noStore, privateJson } from '@/lib/chat-server/http';
import { COMPLETE_BODY_MAX_BYTES, completeBodySchema } from '@/lib/chat-server/request';
import { storableText } from '@/lib/chat-server/text';
import { enforceCompletionQuota } from '@/lib/chat-server/turn';
import type { MessageOutcome } from '@/lib/chat-types';
import { getDb, type Db } from '@/lib/db/client';
import { getConversation, saveAnswer } from '@/lib/db/repo';
import { readJsonBody } from '@/lib/http/json-body';

export const runtime = 'nodejs';

/**
 * Saves the answer a Puter reader's browser generated for a prepared question.
 *
 * The grant from `/api/chat/prepare` names the conversation, the answer row,
 * the citations and the question as it was asked; this route only adds the
 * text and how it ended. So the browser can store its own text, in its own
 * conversation, under the sources the server chose — and nothing else. A
 * grant minted for someone else, or altered in any byte, is refused.
 *
 * Idempotent: the browser sends this with `keepalive` when the stream ends,
 * and may send it again; the same grant always writes the same row. A
 * stopped or failed answer is kept with that outcome, so the reopened
 * conversation shows it as cut short rather than as a whole answer. A grant
 * saves a few times at most (see `completionBuckets`), not as often as a
 * script likes for its fifteen minutes.
 *
 * Nothing is saved for a question that was edited or removed (by an edit of
 * an earlier one) since the grant was issued: 409 `question_superseded`, as
 * final as a save. 404 `conversation_not_found` when the conversation itself
 * is gone.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return noStore(forbiddenOriginResponse());

  const principal = await getChatPrincipal();
  if (!principal) return jsonError(401, 'unauthorized');
  if (principal.kind !== 'puter') return jsonError(409, 'use_server_transport');

  const body = await readJsonBody(request, completeBodySchema, COMPLETE_BODY_MAX_BYTES);
  if (!body.ok) return noStore(body.response);

  const key = await purposeKey('answer-grant');
  if (!key) return jsonError(500, 'server_misconfigured');
  const grant = await verifyAnswerGrant(body.data.grant, key);

  /*
   * One answer `jti` names one row: `<conversation>:<question>:a`. The grant
   * is ours, so this holds; checking it anyway costs nothing and means a
   * future change to the id scheme cannot turn a grant into a pen for some
   * other row.
   */
  const valid =
    grant !== null &&
    grant.profile === principal.profile &&
    grant.answerId.startsWith(`${grant.conversationId}:`) &&
    grant.answerId.endsWith(':a');
  if (!valid) return jsonError(403, 'invalid_grant');

  // Made storable before it is judged empty: a text of nothing but NULs is
  // no answer, and would otherwise be refused by Postgres with a 500.
  const text = storableText(body.data.text);
  // "Complete" with nothing in it is not an answer.
  const outcome: MessageOutcome = body.data.outcome === 'complete' && !text.trim() ? 'error' : body.data.outcome;

  let db: Db;
  try {
    db = await getDb();
  } catch (error) {
    logFailure('chat-complete', error, { stage: 'db' });
    return jsonError(503, 'unavailable', {}, { 'Retry-After': '30' });
  }

  const limited = await enforceCompletionQuota(db, grant);
  if (limited) return limited;

  let saved: boolean;
  try {
    saved = await saveAnswer(db, {
      id: grant.answerId,
      conversationId: grant.conversationId,
      profile: principal.profile,
      userMessageId: grant.answerId.slice(0, -':a'.length),
      questionHash: grant.questionHash,
      text,
      citations: grant.citations,
      outcome,
    });
  } catch (error) {
    logFailure('chat-complete', error, { stage: 'persist', outcome });
    return jsonError(500, 'internal_error');
  }
  if (saved) return privateJson({ ok: true });

  /*
   * Nothing written. Which code is worth one more query, on this path only:
   * the conversation deleted between prepare and complete, or its question
   * edited or removed by an edit, perhaps in another tab. Either way there is
   * nothing for the browser to retry.
   */
  try {
    const conversation = await getConversation(db, grant.conversationId, principal.profile);
    return conversation ? jsonError(409, 'question_superseded') : jsonError(404, 'conversation_not_found');
  } catch (error) {
    logFailure('chat-complete', error, { stage: 'persist-check' });
    return jsonError(404, 'conversation_not_found');
  }
}
