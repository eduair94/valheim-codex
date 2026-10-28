import { forbiddenOriginResponse, isSameOriginRequest } from '@/lib/auth/origin';
import { getChatPrincipal } from '@/lib/auth/principal-server';
import { purposeKey } from '@/lib/auth/secrets';
import { logFailure } from '@/lib/chat-server/failure-log';
import { signAnswerGrant } from '@/lib/chat-server/grant';
import { jsonError, noStore, privateJson } from '@/lib/chat-server/http';
import { checkQuestion, prepareBodySchema } from '@/lib/chat-server/request';
import { conversationTitle } from '@/lib/chat-server/text';
import { enforceQuota, historyFromRows } from '@/lib/chat-server/turn';
import { getDb, type Db } from '@/lib/db/client';
import { beginTurn, questionHash, saveAnswer, type TurnStartResult } from '@/lib/db/repo';
import { readJsonBody } from '@/lib/http/json-body';
import { titleLinker } from '@/lib/rag/intent';
import { buildContext, buildSystemPrompt, buildUserPrompt, noContextAnswer } from '@/lib/rag/prompt';
import { retrieve } from '@/lib/rag/retrieve';
import { deterministicQueries } from '@/lib/rag/rewrite';
import { getSearchIndexData } from '@/lib/wiki/data';

export const runtime = 'nodejs';

/**
 * Output ceiling the browser passes to `puter.ai.chat`. Puter reserves the
 * reader's credit for `max_tokens` up front; without it one request can
 * reserve the whole balance and a second, concurrent one is refused.
 */
const PUTER_MAX_TOKENS = 1200;

/**
 * The server's half of a Puter reader's question.
 *
 * Their model runs in their browser, on their Puter account. The server does
 * what only it can: checks the quota and the conversation's owner, stores the
 * question, retrieves the excerpts and builds the prompt. It returns that
 * prompt with a signed grant that lets the browser save the answer afterwards
 * through `/api/chat/complete`.
 *
 * The query rewrite is deterministic here — the question, the previous
 * question folded in front of it, and the glossary's English terms — because
 * the server has no model to rewrite with on a reader's behalf.
 *
 * When nothing is retrieved, the no-context answer is stored and returned as
 * `empty`, and no model is needed at all. When retrieval fails after the
 * question was stored, the turn is stored as failed, as `/api/chat` does: the
 * browser has no grant to report the failure with, and a bare question would
 * read back as one still waiting for its answer.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return noStore(forbiddenOriginResponse());

  const principal = await getChatPrincipal();
  if (!principal) return jsonError(401, 'unauthorized');
  if (principal.kind !== 'puter') return jsonError(409, 'use_server_transport');

  const body = await readJsonBody(request, prepareBodySchema);
  if (!body.ok) return noStore(body.response);
  const { conversationId, lang, message } = body.data;
  const checked = checkQuestion(conversationId, message.id, message.text);
  if (!checked.ok) return checked.response;
  const { question, ids } = checked;

  // Before anything is written: without it no grant can be issued, and the
  // question would be stored only to fail.
  const grantKey = await purposeKey('answer-grant');
  if (!grantKey) return jsonError(500, 'server_misconfigured');

  let db: Db;
  try {
    db = await getDb();
  } catch (error) {
    logFailure('chat-prepare', error, { stage: 'db' });
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
    logFailure('chat-prepare', error, { stage: 'begin-turn' });
    return jsonError(500, 'internal_error');
  }
  if (!turn.owned) return jsonError(404, 'conversation_not_found');

  const history = historyFromRows(turn.history);
  // The question as it was asked: an answer saved after an edit changed it
  // (another tab can edit) would answer a question no longer there.
  const asked = questionHash(question);
  const answer = {
    id: ids.answer,
    conversationId,
    profile: principal.profile,
    userMessageId: ids.user,
    questionHash: asked,
  };

  try {
    // The question itself too: with no model to rewrite it, a question about
    // what a thing is for or where it is relies on the section retrieval pins
    // from the question (`intent.ts`), linked through the search's cached index.
    const chunks = await retrieve(db, {
      queries: deterministicQueries(question, history),
      question,
      linker: titleLinker(getSearchIndexData),
    });
    const { context, citations } = buildContext(chunks);

    if (chunks.length === 0) {
      const empty = noContextAnswer(lang);
      await saveAnswer(db, { ...answer, text: empty, citations, outcome: 'complete' });
      return privateJson({ assistantId: ids.answer, citations, empty, maxTokens: PUTER_MAX_TOKENS });
    }

    const grant = await signAnswerGrant(
      { profile: principal.profile, answerId: ids.answer, conversationId, citations, questionHash: asked },
      grantKey,
    );

    return privateJson({
      assistantId: ids.answer,
      citations,
      grant,
      messages: [
        { role: 'system', content: buildSystemPrompt(lang) },
        ...history.map((turn) => ({ role: turn.role, content: turn.text })),
        { role: 'user', content: buildUserPrompt(question, context) },
      ],
      maxTokens: PUTER_MAX_TOKENS,
    });
  } catch (error) {
    logFailure('chat-prepare', error, { stage: 'retrieve' });
    try {
      await saveAnswer(db, { ...answer, text: '', citations: [], outcome: 'error' });
    } catch (persistError) {
      logFailure('chat-prepare', persistError, { stage: 'persist', outcome: 'error' });
    }
    return jsonError(500, 'internal_error');
  }
}
