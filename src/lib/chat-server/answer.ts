import {
  streamText,
  toUIMessageChunk,
  type InferUIMessageChunk,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
  type UIMessageStreamWriter,
} from 'ai';
import type { MessageOutcome, ValheimUIMessage } from '@/lib/chat-types';
import type { Db } from '@/lib/db/create-db';
import { questionHash, saveAnswer } from '@/lib/db/repo';
import type { Citation } from '@/lib/db/schema';
import { logWarn } from '@/lib/log';
import { streamWithFallback } from '@/lib/rag/fallback';
import { CHUNK_TIMEOUT_MS, FIRST_TEXT_TIMEOUT_MS, MAX_ANSWER_TOKENS } from '@/lib/rag/models';
import { titleLinker } from '@/lib/rag/intent';
import { planQueries } from '@/lib/rag/plan';
import { buildContext, buildSystemPrompt, buildUserPrompt, noContextAnswer, type Lang } from '@/lib/rag/prompt';
import { answerCandidates } from '@/lib/rag/provider';
import { retrieve } from '@/lib/rag/retrieve';
import { rewriteQueries, type RewriteModel } from '@/lib/rag/rewrite';
import { getSearchIndexData } from '@/lib/wiki/data';
import { chatErrorData, chatErrorText, classifyChatError, type ChatError } from './errors';
import { logFailure } from './failure-log';
import { unknownPayer, type Payer } from './payer';
import type { StoredIds } from './request';
import type { HistoryTurn } from './turn';

/**
 * One answer, from the question to the stored row, for the readers whose
 * model runs on this server: password holders on the operator's chain, and
 * readers with their own Gemini key on that key alone.
 *
 * What happens when the reader leaves. The browser's Stop, a new
 * conversation, a closed tab or a dropped connection all end the request, and
 * Next aborts `request.signal`. That signal reaches every model call, so the
 * provider stops generating — and billing — instead of the server draining
 * the whole answer into a stream nobody reads, as it used to. The server
 * cannot tell Stop from a phone locking, so either way the answer is kept as
 * far as it got, marked `stopped`.
 *
 * What is stored, exactly once per turn, after the stream has ended:
 *
 * | ending                                    | outcome    | text                |
 * |-------------------------------------------|------------|---------------------|
 * | the model finished normally               | `complete` | the answer          |
 * | nothing retrieved                         | `complete` | the no-context note |
 * | the reader left                           | `stopped`  | what they had seen  |
 * | failed or cut off (error, timeout, limit) | `error`    | what had arrived    |
 *
 * so a reopened conversation never shows half an answer as the whole of one,
 * and a failed turn is visibly a failure rather than a bare question.
 *
 * Errors reach the reader as a transient `data-error` part with a code, then
 * the `error` part with a sentence already in their language.
 */

type Writer = UIMessageStreamWriter<ValheimUIMessage>;
type Part = TextStreamPart<ToolSet>;

export type AnswerTurn = {
  writer: Writer;
  db: Db;
  profile: string;
  conversationId: string;
  ids: StoredIds;
  question: string;
  history: HistoryTurn[];
  lang: Lang;
  /** Who pays for the model calls: the operator's chain, or the reader's own key alone. */
  payer: Payer;
  /** The request's signal: the reader leaving. */
  signal: AbortSignal;
};

/**
 * A reader's key refused for a reason the answer call would hit just the
 * same: no point spending another of their requests to find out again.
 */
function isKeyFailure(error: unknown): boolean {
  const { code } = classifyChatError(error, { byok: true, streamed: false });
  return (
    code === 'byok_key_invalid' ||
    code === 'byok_quota' ||
    code === 'byok_model_unavailable' ||
    code === 'byok_region_unavailable'
  );
}

/** The transient code part, then the error part the client shows. */
export function writeChatError(writer: Writer, error: ChatError, lang: Lang): void {
  writer.write({ type: 'data-error', data: chatErrorData(error), transient: true });
  writer.write({ type: 'error', errorText: chatErrorText(error.code, lang, error.retryAfter) });
}

/**
 * The rewrite's model: the reader's own for their key's turn, so a guest's
 * question never spends the operator's keys on its rewrite; the operator's
 * chain (no override) for the operator's.
 */
function rewriteModelFor(payer: Payer): RewriteModel | undefined {
  switch (payer.kind) {
    case 'byok':
      return {
        name: payer.model.name,
        model: payer.model.model,
        providerOptions: payer.model.providerOptions,
        maxRetries: payer.model.maxRetries,
        isFatal: isKeyFailure,
      };
    case 'operator':
      return undefined;
    default:
      return unknownPayer(payer);
  }
}

/**
 * Awaited before the stream closes, on purpose, though it costs a round
 * trip after the last word: the next question's history is read from the
 * database, and an answer still being written when the reader asks again
 * would be missing from it.
 *
 * Saved only while the question still reads as it did when this turn began
 * (see `saveAnswer`): an edit in another tab while this answer streamed
 * leaves it answering a question no longer there.
 */
async function store(turn: AnswerTurn, text: string, outcome: MessageOutcome, citations: Citation[]): Promise<void> {
  try {
    const saved = await saveAnswer(turn.db, {
      id: turn.ids.answer,
      conversationId: turn.conversationId,
      profile: turn.profile,
      userMessageId: turn.ids.user,
      questionHash: questionHash(turn.question),
      text,
      citations,
      outcome,
    });
    // Not a failure: the reader deleted the conversation, or edited the
    // question, while the answer was on its way.
    if (!saved) logWarn('chat', 'answer not stored: its conversation or question is gone or changed', { outcome });
  } catch (error) {
    // Losing history is bad but must not fail a response already streamed.
    logFailure('chat', error, { stage: 'persist', outcome });
  }
}

function openStream(turn: AnswerTurn, messages: ModelMessage[]) {
  const shared = {
    instructions: buildSystemPrompt(turn.lang),
    messages,
    temperature: 0.2,
    maxOutputTokens: MAX_ANSWER_TOKENS,
    // After the first word, a provider that goes quiet this long is gone.
    timeout: { chunkMs: CHUNK_TIMEOUT_MS },
    // The SDK's default logs the whole error object, prompt included. Errors
    // are classified and logged, reduced, where they are handled.
    onError: () => {},
  };

  const { payer } = turn;
  switch (payer.kind) {
    case 'byok': {
      // The reader's key alone: no candidate behind it, and nothing it does
      // reaches the shared circuit breaker.
      const byok = payer.model;
      return streamWithFallback(
        [{ name: byok.name, model: byok.model }],
        (candidate, attempt) =>
          streamText({
            ...shared,
            model: candidate.model,
            maxRetries: byok.maxRetries,
            abortSignal: attempt.abortSignal,
            providerOptions: byok.providerOptions,
          }),
        { signal: turn.signal, timeoutMs: FIRST_TEXT_TIMEOUT_MS, circuit: false },
      );
    }

    case 'operator':
      /*
       * Grok first, Gemini behind it. A provider that is going to refuse —
       * an unpaid account, an exhausted quota — does so before the first
       * token, so `streamWithFallback` waits for that token before committing
       * and the reader never sees a switch happen. Missing the first-word
       * deadline here, and only here, demotes the provider for a minute.
       */
      return streamWithFallback(
        answerCandidates(),
        (candidate, attempt) =>
          streamText({
            ...shared,
            model: candidate.model,
            maxRetries: attempt.maxRetries,
            abortSignal: attempt.abortSignal,
          }),
        { signal: turn.signal, timeoutMs: FIRST_TEXT_TIMEOUT_MS, demoteOnTimeout: true },
      );

    default:
      return unknownPayer(payer);
  }
}

type Relayed = { text: string; outcome: MessageOutcome };

/**
 * Forwards a proven answer stream to the reader and works out how it ended.
 *
 * Read here rather than merged with `writer.merge`, for three reasons: the
 * text has to be collected for storage whatever happens; an error part needs
 * its code written before it, in the reader's language (the SDK's default is
 * "An error occurred."); and the `finish` part is held back until the answer
 * is known to be whole, so a length or safety stop ends in an error the
 * reader can see instead of a clean finish on a truncated answer.
 */
async function relay(turn: AnswerTurn, stream: ReadableStream<Part>, provider: string): Promise<Relayed> {
  const { writer, signal, lang } = turn;
  const byok = turn.payer.kind === 'byok';
  const reader = stream.getReader();
  let text = '';
  let finishReason: string | undefined;
  let finish: InferUIMessageChunk<ValheimUIMessage> | undefined;
  let failure: ChatError | null = null;

  try {
    for (;;) {
      const { done, value: part } = await reader.read();
      if (done) break;

      if (part.type === 'error') {
        failure = classifyChatError(part.error, { byok, streamed: true });
        logFailure('chat', part.error, { stage: 'stream', provider, code: failure.code });
        break;
      }
      if (part.type === 'abort') {
        // Not the reader: the chunk deadline. The provider stalled mid-answer.
        if (!signal.aborted) failure = { code: 'timeout' };
        break;
      }

      if (part.type === 'text-delta') text += part.text;
      // `sendReasoning: false`: gpt-oss's chain of thought is not the answer,
      // and nothing shows it.
      const chunk = toUIMessageChunk<ToolSet, ValheimUIMessage>(part, { sendStart: false, sendReasoning: false });
      if (!chunk) continue;
      if (part.type === 'finish') {
        finishReason = part.finishReason;
        finish = chunk;
        continue;
      }
      writer.write(chunk);
    }
  } catch (error) {
    // The provider's stream itself broke: a dropped connection mid-answer.
    if (!signal.aborted) {
      failure = classifyChatError(error, { byok, streamed: true });
      logFailure('chat', error, { stage: 'stream', provider, code: failure.code });
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (signal.aborted) return { text, outcome: 'stopped' };

  if (!failure && (finishReason !== 'stop' || !text.trim())) {
    // Finished, but not because the answer was done: a length or safety stop
    // after some text, or (with no text) a provider that said nothing.
    failure = { code: text.trim() ? 'interrupted' : 'empty_answer' };
  }
  if (failure) {
    writeChatError(writer, failure, lang);
    return { text, outcome: 'error' };
  }

  if (finish) writer.write(finish);
  return { text, outcome: 'complete' };
}

export async function answerTurn(turn: AnswerTurn): Promise<void> {
  const { writer, signal, lang } = turn;
  let citations: Citation[] = [];

  try {
    // The cached title index the wiki search serves, linked once for the
    // turn: the plan and the retrieval both read the question's names with it.
    const linker = titleLinker(getSearchIndexData);
    /*
     * A model rewrite only when the question needs one (`plan.ts`), for both
     * payers: on a reader's own key the call skipped is one of their requests.
     * The stage is announced when the rewrite starts, so a question searched
     * as asked goes straight to 'searching'; until a status arrives the client
     * shows the question being read, which is what planning is.
     */
    const { queries, rewritten } = await planQueries({
      question: turn.question,
      history: turn.history,
      linker,
      rewrite: () => {
        writer.write({ type: 'data-status', id: 'status', data: { stage: 'rewriting' } });
        return rewriteQueries({
          question: turn.question,
          history: turn.history,
          abortSignal: signal,
          model: rewriteModelFor(turn.payer),
        });
      },
    });
    signal.throwIfAborted();

    writer.write({ type: 'data-status', id: 'status', data: { stage: 'searching', queries } });
    const chunks = await retrieve(turn.db, { queries, rewritten, question: turn.question, linker });
    signal.throwIfAborted();

    const built = buildContext(chunks);
    citations = built.citations;
    writer.write({ type: 'data-sources', id: 'sources', data: { citations } });

    // Nothing retrieved: say so directly instead of asking the model to
    // improvise an answer with no grounding.
    if (chunks.length === 0) {
      const text = noContextAnswer(lang);
      writer.write({ type: 'text-start', id: 'empty' });
      writer.write({ type: 'text-delta', id: 'empty', delta: text });
      writer.write({ type: 'text-end', id: 'empty' });
      await store(turn, text, 'complete', citations);
      return;
    }

    writer.write({ type: 'data-status', id: 'status', data: { stage: 'answering' } });
    const messages: ModelMessage[] = [
      ...turn.history.map((h): ModelMessage => ({ role: h.role, content: h.text })),
      { role: 'user', content: buildUserPrompt(turn.question, built.context) },
    ];

    const { stream, candidate } = await openStream(turn, messages);
    const { text, outcome } = await relay(turn, stream, candidate.name);
    await store(turn, text, outcome, citations);
  } catch (error) {
    if (signal.aborted) {
      await store(turn, '', 'stopped', citations);
      return;
    }
    const failure = classifyChatError(error, { byok: turn.payer.kind === 'byok', streamed: false });
    logFailure('chat', error, { stage: 'answer', code: failure.code });
    writeChatError(writer, failure, lang);
    await store(turn, '', 'error', citations);
  }
}
