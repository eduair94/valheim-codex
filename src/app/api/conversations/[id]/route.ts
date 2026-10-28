import { z } from 'zod';
import { forbiddenOriginResponse, isSameOriginRequest } from '@/lib/auth/origin';
import { getChatPrincipal } from '@/lib/auth/principal-server';
import { logFailure } from '@/lib/chat-server/failure-log';
import { jsonError, noStore, privateJson } from '@/lib/chat-server/http';
import { limitConversationRead } from '@/lib/chat-server/read-limit';
import { CONVERSATION_ID } from '@/lib/chat-server/request';
import { storableText, truncateGraphemes } from '@/lib/chat-server/text';
import { getDb } from '@/lib/db/client';
import { deleteConversation, getConversation, listRecentMessages, renameConversation } from '@/lib/db/repo';
import { readJsonBody } from '@/lib/http/json-body';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/*
 * One conversation, for whichever kind of reader owns it. Ownership is a
 * condition of every query, so a guessed id reads, renames and deletes
 * nothing; and an id that could never have been issued is refused before
 * reaching the database at all.
 */

/**
 * A code the client can map, rather than an empty 500, when the database
 * fails. Logged reduced: the failed statement's parameters are a reader's
 * new title and their profile (see failure-log.ts).
 */
function unavailable(error: unknown, stage: string): Response {
  logFailure('conversations', error, { stage });
  return jsonError(503, 'unavailable', {}, { 'Retry-After': '30' });
}

/**
 * The conversation and its newest messages, oldest first: at most 200, and
 * about a megabyte (see `listRecentMessages`). `truncated` says older ones
 * exist that this response leaves out; the window then opens on a question.
 *
 * Sixty reads a minute per reader and per address
 * (`CONVERSATION_READS_PER_MINUTE`), then 429 `rate_limited` with
 * `Retry-After`; see read-limit.ts.
 */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const principal = await getChatPrincipal();
  if (!principal) return jsonError(401, 'unauthorized');

  const { id } = await params;
  if (!CONVERSATION_ID.test(id)) return jsonError(404, 'not_found');

  const limited = limitConversationRead(principal.profile, request.headers);
  if (limited) return limited;

  let found;
  try {
    const db = await getDb();
    found = await Promise.all([
      getConversation(db, id, principal.profile),
      listRecentMessages(db, id, principal.profile),
    ]);
  } catch (error) {
    return unavailable(error, 'read');
  }
  const [conversation, { messages: rows, truncated }] = found;
  if (!conversation) return jsonError(404, 'not_found');

  return privateJson({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      lang: conversation.lang,
    },
    truncated,
    messages: rows.map((m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts,
      citations: m.citations,
      // How an answer ended; a cut-off one should read as cut off.
      outcome: m.outcome,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return noStore(forbiddenOriginResponse());

  const principal = await getChatPrincipal();
  if (!principal) return jsonError(401, 'unauthorized');

  const { id } = await params;
  if (!CONVERSATION_ID.test(id)) return jsonError(404, 'not_found');

  let deleted: boolean;
  try {
    deleted = await deleteConversation(await getDb(), id, principal.profile);
  } catch (error) {
    return unavailable(error, 'delete');
  }
  if (!deleted) return jsonError(404, 'not_found');
  return privateJson({ ok: true });
}

const patchSchema = z.object({ title: z.string().min(1).max(400) });

/** Longest title kept, in characters. */
const TITLE_MAX = 120;

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return noStore(forbiddenOriginResponse());

  const principal = await getChatPrincipal();
  if (!principal) return jsonError(401, 'unauthorized');

  const body = await readJsonBody(request, patchSchema);
  if (!body.ok) return noStore(body.response);
  // Storable before it is judged empty: a NUL used to reach Postgres, which
  // refused it, and the rename was answered as an outage to retry.
  const title = truncateGraphemes(storableText(body.data.title).replace(/\s+/g, ' ').trim(), TITLE_MAX);
  if (!title) return jsonError(400, 'invalid_request');

  const { id } = await params;
  if (!CONVERSATION_ID.test(id)) return jsonError(404, 'not_found');

  let renamed: boolean;
  try {
    renamed = await renameConversation(await getDb(), id, principal.profile, title);
  } catch (error) {
    return unavailable(error, 'rename');
  }
  if (!renamed) return jsonError(404, 'not_found');
  return privateJson({ ok: true });
}
