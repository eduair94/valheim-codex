import { chatBuckets } from '@/lib/auth/limits';
import { isOperatorPaid, type ChatPrincipal } from '@/lib/auth/principal';
import { clientIp } from '@/lib/auth/client-ip';
import { consumeQuota, quotaExceededResponse, type QuotaBucket } from '@/lib/auth/quota';
import { messageText } from '@/lib/chat-types';
import type { Db } from '@/lib/db/create-db';
import type { HistoryRow } from '@/lib/db/repo';
import { describeError, logWarn } from '@/lib/log';
import { forLog, logFailure } from './failure-log';
import { ANSWER_GRANT_TTL_SECONDS, type VerifiedAnswerGrant } from './grant';
import { jsonError, noStore } from './http';
import { clampText, stripCitationMarkers } from './text';

/** Earlier messages replayed to the model with each question. */
export const HISTORY_TURNS = 6;

/** Longest a replayed message may be, in UTF-16 code units. */
export const HISTORY_TEXT_MAX = 1500;

/**
 * How much of a stored answer its markers are stripped from: enough that the
 * cut, made before the markers go, still leaves `HISTORY_TEXT_MAX` of prose
 * unless half the answer was markers. Stored answers are up to 12,000
 * characters from a Puter browser and uncapped (4,096 tokens) from a model
 * here, and all but the first 1,500 are thrown away.
 */
const STRIPPED_TEXT_MAX = HISTORY_TEXT_MAX * 2;

export type HistoryTurn = { role: 'user' | 'assistant'; text: string };

/**
 * The conversation so far, as the model should see it, built from what the
 * server stored rather than from what the browser sends.
 *
 * - Text only. Stored answers are already text; anything else in an old row
 *   (data parts, a client's extras) is not part of the conversation.
 * - Earlier answers lose their `[n]` and `[img:n]` markers, which pointed at
 *   that turn's excerpts and would collide with this turn's numbering.
 * - Empty turns are dropped. An answer that failed or was stopped before its
 *   first word is stored with no text, and replaying it sent Gemini a
 *   `{"role":"model","parts":[]}` that it rejects with a 400 — on every
 *   follow-up in the conversation.
 * - Questions that went unanswered stay: the next question usually refers to
 *   them ("¿y dónde está?").
 * - Each message is capped, so one long answer cannot crowd out the excerpts.
 *
 * Runs on every question, synchronously, on text a Puter reader writes
 * themselves, so the work is bounded whatever the rows hold: rows are read
 * newest first and only until `HISTORY_TURNS` turns are found (the older
 * ones would be dropped anyway), and an answer is cut before its markers are
 * stripped as well as after.
 */
export function historyFromRows(rows: HistoryRow[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (let i = rows.length - 1; i >= 0 && turns.length < HISTORY_TURNS; i--) {
    const row = rows[i]!;
    const parts = row.parts.filter(
      (part): part is { type: string; text?: string } =>
        typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string',
    );
    let text = messageText({ parts });
    if (row.role === 'assistant') text = stripCitationMarkers(clampText(text, STRIPPED_TEXT_MAX));
    text = clampText(text, HISTORY_TEXT_MAX).trim();
    if (text) turns.push({ role: row.role, text });
  }
  return turns.reverse();
}

/**
 * Counts this question against the reader's quotas, before anything is
 * written or any model is called.
 *
 * When the quota store itself fails, the two kinds of reader part ways. A
 * guest's questions cost the operator retrieval and nothing bounds a guest
 * but these counters, so a guest is refused (fail closed). A password holder
 * is one of a few trusted people, and losing their chat to a counter outage
 * would be worse than one unmetered question (fail open, with a warning).
 *
 * Returns the response to send instead, or null to go on.
 */
export async function enforceQuota(db: Db, principal: ChatPrincipal, headers: Headers): Promise<Response | null> {
  try {
    const decision = await consumeQuota(db, chatBuckets(principal, clientIp(headers)));
    return decision.allowed ? null : noStore(quotaExceededResponse(decision));
  } catch (error) {
    // Reduced: the failed statement's parameters are bucket names, which
    // carry the reader's profile and client address.
    if (isOperatorPaid(principal)) {
      const { name, message } = describeError(forLog(error));
      logWarn('chat', 'quota store unavailable; letting a password question through unmetered', {
        error: name,
        message,
      });
      return null;
    }
    logFailure('chat', error, { stage: 'quota', kind: principal.kind });
    return jsonError(503, 'quota_unavailable', {}, { 'Retry-After': '30' });
  }
}

type Env = Record<string, string | undefined>;

/** How many times one grant may save its answer. */
function completionsPerGrant(env: Env): number {
  const value = Number.parseInt(env.CHAT_COMPLETIONS_PER_GRANT ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : 4;
}

/**
 * The ceiling on `/api/chat/complete`: a few saves per grant.
 *
 * A grant is good for fifteen minutes and names one row, and without a
 * ceiling it could rewrite that row, 12,000 characters at a time, as often as
 * a script liked. The browser saves once when the stream ends, perhaps again
 * after a dropped connection or a renewed sign-in, so four is room to spare.
 * Grants themselves are bounded by the chat quota `/api/chat/prepare`
 * enforces, so this bounds the writes one reader can cause.
 *
 * Counted per grant, not per reader, so it never touches a reader's chat
 * quota; and keyed by the grant's issue time as well as its row, because
 * regenerating an answer issues a new grant for the same row. (The windows
 * are fixed, so a grant whose fifteen minutes straddle two of them gets the
 * allowance twice: still a handful.)
 */
export function completionBuckets(grant: VerifiedAnswerGrant, env: Env = process.env): QuotaBucket[] {
  return [
    {
      name: `chat:complete:${grant.answerId}:${grant.issuedAt}`,
      limit: completionsPerGrant(env),
      windowMs: ANSWER_GRANT_TTL_SECONDS * 1000,
    },
  ];
}

/**
 * Counts one save against its grant. Returns the 429 to send instead, or null
 * to go on.
 *
 * Fails open, unlike a guest's question: refusing here would throw away an
 * answer the reader has already paid Puter for, and every grant that could
 * be saved unmetered while the quota store is down was itself issued under
 * the chat quota before it went down.
 */
export async function enforceCompletionQuota(db: Db, grant: VerifiedAnswerGrant): Promise<Response | null> {
  try {
    const decision = await consumeQuota(db, completionBuckets(grant));
    return decision.allowed ? null : noStore(quotaExceededResponse(decision));
  } catch (error) {
    const { name, message } = describeError(forLog(error));
    logWarn('chat-complete', 'quota store unavailable; saving the answer unmetered', { error: name, message });
    return null;
  }
}
