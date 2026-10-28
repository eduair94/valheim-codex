import type { TextStreamPart, ToolSet } from 'ai';
import { describeError, logWarn } from '@/lib/log';
import { recordFailure, recordSuccess, recordTimeout } from './circuit';
import type { Candidate } from './provider';

/**
 * Runs a model call against each candidate in turn, keeping the first that
 * works.
 *
 * The distinction that matters is *when* a provider fails. A 403 for an unpaid
 * account, a 429 for an exhausted quota and a 500 all arrive before a single
 * token does, which is exactly the window in which switching providers is free
 * and invisible. Once text is flowing the answer is committed: retrying then
 * would either duplicate what the reader has already seen or throw it away
 * mid-sentence, and neither is an improvement on a truncated answer.
 *
 * Two failures arrive without an error at all, and both used to pass for a
 * working provider:
 *
 * - **Silence.** A provider that stalls before its first token held the
 *   request for Node's 300-second fetch timeout, per provider, and one that
 *   kept the connection alive with SSE comments held it forever. Each attempt
 *   now gets a deadline; missing it is a failure like any other, and the next
 *   provider is asked.
 * - **An empty answer.** Gemini blocks a prompt by finishing with no
 *   candidates; a safety stop or a reasoning model that spends its budget
 *   thinking finishes with no text. The stream ends cleanly, so the reader got
 *   an empty bubble and the next provider was never tried. Only text proves a
 *   provider now — and not whitespace: a model that writes a line break and
 *   then stops on a safety filter has said nothing either.
 *
 * The reader leaving is the opposite case: the caller's signal aborts, and the
 * chain stops where it is — no next provider, and nothing held against the
 * current one, since it did nothing wrong.
 */

/** The last error, so a total failure reports the real cause rather than a summary. */
export class AllProvidersFailedError extends Error {
  constructor(readonly failures: { name: string; error: unknown }[]) {
    const detail = failures.map(({ name, error }) => `${name}: ${describeError(error).message}`).join('; ');
    super(`Every model provider failed. ${detail}`);
    this.name = 'AllProvidersFailedError';
  }
}

/** A stream that ended — finished, aborted or closed — without one character of text. */
export class EmptyResponseError extends Error {
  constructor(readonly finishReason?: string) {
    super(
      finishReason
        ? `The model finished (${finishReason}) without writing any text.`
        : 'The model ended its stream without writing any text.',
    );
    this.name = 'EmptyResponseError';
  }
}

/** A provider that did not answer within its deadline. */
export class ResponseTimeoutError extends Error {
  constructor(readonly afterMs?: number) {
    super(afterMs ? `The model did not answer within ${afterMs} ms.` : 'The model stopped answering.');
    this.name = 'ResponseTimeoutError';
  }
}

/**
 * How hard to try one provider before moving to the next.
 *
 * Zero for every provider that has another behind it. The SDK's default is
 * three attempts with exponential backoff, which is right when there is
 * nowhere else to go and wrong here: a rate-limited Gemini spent six seconds
 * failing three times while four other providers sat idle. The last provider
 * keeps its retries, because at that point backoff is the only option left.
 */
function attemptsFor(index: number, total: number): number {
  return index === total - 1 ? 2 : 0;
}

/** Passed to the caller so it can hand the budget and the deadline to the SDK. */
export type Attempt = {
  readonly maxRetries: number;
  /** Aborts when this attempt's deadline passes or the caller's signal does. */
  readonly abortSignal: AbortSignal;
};

export type FallbackOptions = {
  /**
   * The caller's own signal — for the chat, the reader closing the tab or
   * pressing Stop. Aborting it ends the chain instead of moving along it.
   */
  signal?: AbortSignal;
  /**
   * Per-candidate deadline in milliseconds: for the whole call in
   * `withFallback`, for the first text in `streamWithFallback`.
   */
  timeoutMs?: number;
  /**
   * Whether outcomes feed the process-wide circuit breaker. Off for a
   * reader's own key: one reader's revoked key must never demote the
   * operator's provider of the same name for everyone else.
   */
  circuit?: boolean;
  /**
   * Whether missing `timeoutMs` demotes the provider for a minute. Only the
   * chat answer sets it: its first-word deadline is the one stall that says a
   * provider is hanging for everyone. A rewrite's tighter deadline, or a
   * caller's own timer, is evidence about that call alone, and the candidate
   * names are shared across features (see circuit.ts).
   */
  demoteOnTimeout?: boolean;
};

type AttemptControl = {
  signal: AbortSignal;
  /** True once this attempt's own deadline fired. */
  timedOut: () => boolean;
  /** Stops the deadline: the attempt finished, or proved itself. */
  settle: () => void;
};

function startAttempt(outer: AbortSignal | undefined, timeoutMs: number | undefined): AttemptControl {
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new ResponseTimeoutError(timeoutMs));
        }, timeoutMs)
      : undefined;
  return {
    signal: outer ? AbortSignal.any([outer, controller.signal]) : controller.signal,
    timedOut: () => timedOut,
    settle: () => clearTimeout(timer),
  };
}

/**
 * What the breaker learns from one failed attempt. `failure` is a
 * `ResponseTimeoutError` when this attempt's own deadline fired, or when the
 * stream stalled before its first word (`proveStream`); a caller's timer
 * that fired instead (translation's `AbortSignal.timeout`) arrives as its own
 * `TimeoutError`, is not a permanent refusal, and so records nothing.
 */
function remember(name: string, failure: unknown, options: FallbackOptions): void {
  if (options.circuit === false) return;
  if (failure instanceof ResponseTimeoutError) {
    if (options.demoteOnTimeout) recordTimeout(name);
    return;
  }
  recordFailure(name, failure);
}

function warnFallback(name: string, error: unknown, hasNext: boolean): void {
  const summary = describeError(error);
  logWarn(
    'model',
    `${name} failed${hasNext ? ', trying the next provider' : ' and no provider is left'}`,
    { error: summary.name, status: summary.statusCode, message: summary.message },
  );
}

/** For a non-streaming call — the query rewrite. */
export async function withFallback<T>(
  list: Candidate[],
  run: (candidate: Candidate, attempt: Attempt) => Promise<T>,
  options: FallbackOptions = {},
): Promise<{ value: T; candidate: Candidate }> {
  const failures: { name: string; error: unknown }[] = [];
  const circuit = options.circuit ?? true;

  for (const [index, candidate] of list.entries()) {
    options.signal?.throwIfAborted();
    const attempt = startAttempt(options.signal, options.timeoutMs);
    try {
      const value = await run(candidate, {
        maxRetries: attemptsFor(index, list.length),
        abortSignal: attempt.signal,
      });
      if (circuit) recordSuccess(candidate.name);
      return { value, candidate };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = attempt.timedOut() ? new ResponseTimeoutError(options.timeoutMs) : error;
      remember(candidate.name, failure, options);
      failures.push({ name: candidate.name, error: failure });
      warnFallback(candidate.name, failure, index < list.length - 1);
    } finally {
      attempt.settle();
    }
  }

  throw new AllProvidersFailedError(failures);
}

type Part = TextStreamPart<ToolSet>;

/**
 * Reads a stream until it proves itself, then replays everything it read.
 *
 * "Proves itself" means the first `text-delta` with something other than
 * whitespace in it: a provider that is going to reject the request does so
 * before producing any text, so waiting for some distinguishes a working
 * provider from a failing one without the caller seeing a partial answer from
 * a provider that is about to die. The parts read during that wait — leading
 * line breaks included — are buffered and re-emitted, so the consumer receives
 * the stream intact, `start` and `text-start` too, which the UI needs.
 *
 * Everything else that can end the wait is a failure: an `error` part, an
 * `abort` part (this attempt's deadline, or the caller leaving), and a
 * `finish` or a closed stream with no text before it.
 */
async function proveStream(stream: ReadableStream<Part>, caller: AbortSignal | undefined): Promise<ReadableStream<Part>> {
  const reader = stream.getReader();
  const buffered: Part[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new EmptyResponseError();

      /*
       * The SDK reports a provider rejection as a part rather than a rejected
       * promise, so this is the failure path, not an edge case.
       */
      if (value.type === 'error') throw value.error;
      if (value.type === 'abort') {
        if (caller?.aborted) throw caller.reason;
        throw new ResponseTimeoutError();
      }
      if (value.type === 'finish') throw new EmptyResponseError(value.rawFinishReason ?? value.finishReason);

      buffered.push(value);
      if (value.type === 'text-delta' && /\S/.test(value.text)) break;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  return new ReadableStream<Part>({
    start(controller) {
      for (const part of buffered) controller.enqueue(part);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** For the streaming answer call. */
export async function streamWithFallback(
  list: Candidate[],
  // Structural, not `StreamTextResult`: this needs the stream and nothing
  // else, and naming the SDK's result type would drag three generic
  // parameters through a module that has no opinion about any of them.
  build: (candidate: Candidate, attempt: Attempt) => { readonly stream: ReadableStream<Part> },
  options: FallbackOptions = {},
): Promise<{ stream: ReadableStream<Part>; candidate: Candidate }> {
  const failures: { name: string; error: unknown }[] = [];
  const circuit = options.circuit ?? true;

  for (const [index, candidate] of list.entries()) {
    options.signal?.throwIfAborted();
    const attempt = startAttempt(options.signal, options.timeoutMs);
    try {
      const built = build(candidate, {
        maxRetries: attemptsFor(index, list.length),
        abortSignal: attempt.signal,
      });
      const stream = await proveStream(built.stream, options.signal);
      // Text arrived in time. From here a stall is the caller's chunk
      // deadline to enforce; this one is spent.
      attempt.settle();
      if (circuit) recordSuccess(candidate.name);
      return { stream, candidate };
    } catch (error) {
      attempt.settle();
      if (options.signal?.aborted) throw error;
      const failure = attempt.timedOut() ? new ResponseTimeoutError(options.timeoutMs) : error;
      remember(candidate.name, failure, options);
      failures.push({ name: candidate.name, error: failure });
      warnFallback(candidate.name, failure, index < list.length - 1);
    }
  }

  throw new AllProvidersFailedError(failures);
}
