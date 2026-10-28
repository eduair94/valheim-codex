import { APICallError, NoObjectGeneratedError, type TextStreamPart, type ToolSet } from 'ai';
import { describeError, logWarn } from '@/lib/log';
import { isTripped, recordFailure, recordSuccess, recordTimeout, refusalOf, statedWaitMs, statusOf } from './circuit';
import { RATE_LIMIT_WAIT_MS } from './models';
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
 * Two failures are worth asking the same provider again for, before moving
 * on:
 *
 * - **A short rate limit.** "Please try again in 510ms" is a provider saying
 *   when it will answer. Moving on instead reached, in production, four
 *   providers that were out of credit or out of their day, and a translation
 *   run stopped for want of a provider while the one that worked was half a
 *   second from answering. A wait the refusal states is sat out on the same
 *   provider when it is short enough for the caller (`maxWaitMs`) and still
 *   leaves the provider a third of its deadline to answer in; otherwise the
 *   chain moves on, so the chat's first word is never later for it.
 * - **A bad reply** (`isBadReply`): the provider is up, and asked once more it
 *   usually gets the reply right. Then the chain moves on as for any failure,
 *   holding nothing against it.
 *
 * And the last provider, with nowhere to move on to, is asked again after a
 * server error, an overloaded spell or a network that did not connect, after
 * two seconds and then four (`isLastResort`). The chain does all of this
 * asking itself, and the SDK none: its retries sat out a rate limit where the
 * chain could not see it, so the deadline missed after that wait read as a
 * request too long to answer (`ResponseTimeoutError.afterWait`).
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

/**
 * A provider that did not answer within its deadline.
 *
 * Its message never uses the words of a refusal. A failure that carries no
 * status is read by its words (circuit.ts), and "rate limit" in this one made
 * the translator take a provider that had waited as it was told, and then run
 * out of time, for one that refused: a run a reader was waiting on stopped on
 * the spot.
 */
export class ResponseTimeoutError extends Error {
  constructor(
    readonly afterMs?: number,
    /**
     * True when the provider spent part of that deadline waiting before it
     * was asked again: out a rate limit it stated, or a backoff after a
     * server error. It had what was left to answer in — a third of the
     * deadline at the least (`ROOM_TO_ANSWER`) — so missing it says nothing
     * about how long the request takes to answer, nor that the provider hangs.
     */
    readonly afterWait = false,
  ) {
    super(
      afterMs
        ? `The model did not answer within ${afterMs} ms${afterWait ? ', part of them spent waiting to ask it again' : ''}.`
        : 'The model stopped answering.',
    );
    this.name = 'ResponseTimeoutError';
  }
}

/**
 * Whether a candidate is backed off and asked again after a transient
 * failure, rather than left for the next one: the last, since there is no
 * next — unless it is last because the breaker set it aside
 * (`orderByCircuit`). Out of credit or out of its day, it refuses every retry
 * the same way: Gemini's spent daily quota, last in line, cost three requests
 * and six seconds of backoff on every chain that reached it.
 *
 * Every other provider is left at its first failure. Backing off is right
 * when there is nowhere else to go and wrong otherwise: a rate-limited
 * Gemini spent six seconds failing three times while four other providers
 * sat idle.
 */
function isLastResort(candidate: Candidate, index: number, total: number): boolean {
  return index === total - 1 && !isTripped(candidate.name);
}

/** Backoffs the last resort gets after a transient failure: the SDK's own two. */
const BACKOFFS = 2;

/** The first of them, doubled for the second: the SDK's two seconds, then four. */
const BACKOFF_MS = 2_000;

/** Passed to the caller so it can hand the budget and the deadline to the SDK. */
export type Attempt = {
  /**
   * Always 0, for the SDK: the chain asks again itself (`againAfter`), where
   * it sees each wait and keeps the provider's deadline.
   */
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
  /**
   * The longest wait a rate limit may state for it to be sat out on the same
   * provider. Twenty seconds unless the caller can afford longer (the
   * translator); `timeoutMs` bounds it further.
   */
  maxWaitMs?: number;
  /** The clock and the wait, for a test. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type AttemptControl = {
  signal: AbortSignal;
  /** True once this attempt's own deadline fired. */
  timedOut: () => boolean;
  /** Stops the deadline: the attempt finished, or proved itself. */
  settle: () => void;
  /** Milliseconds of this attempt's deadline left at `now`: unbounded without one. */
  left: (now: number) => number;
};

function startAttempt(outer: AbortSignal | undefined, timeoutMs: number | undefined, now: number): AttemptControl {
  const controller = new AbortController();
  let timedOut = false;
  const bounded = timeoutMs !== undefined && timeoutMs > 0;
  const timer = bounded
    ? setTimeout(() => {
        timedOut = true;
        controller.abort(new ResponseTimeoutError(timeoutMs));
      }, timeoutMs)
    : undefined;
  const endsAt = bounded ? now + timeoutMs : Number.POSITIVE_INFINITY;
  return {
    signal: outer ? AbortSignal.any([outer, controller.signal]) : controller.signal,
    timedOut: () => timedOut,
    settle: () => clearTimeout(timer),
    left: (at) => endsAt - at,
  };
}

/**
 * A reply that came back and does not fit what was asked: text the SDK could
 * not read as the object requested (`NoObjectGeneratedError`), or a reply the
 * provider checked against the schema itself and turned down — Groq answers
 * 400 "Failed to validate JSON", or "Failed to generate JSON", with the
 * model's text in `failed_generation`. The provider is up and answering; the
 * production run took Groq for one that was not, and lost the batch.
 */
export function isBadReply(error: unknown): boolean {
  if (NoObjectGeneratedError.isInstance(error)) return true;
  if (statusOf(error) !== 400 || typeof error !== 'object' || error === null) return false;
  const { message, responseBody } = error as { message?: unknown; responseBody?: unknown };
  const said = `${typeof message === 'string' ? message : ''}\n${typeof responseBody === 'string' ? responseBody.slice(0, 4_000) : ''}`;
  return /failed to (?:validate|generate) json|failed_generation|json_(?:validate|generate)_failed/i.test(said);
}

/** Rate-limit waits sat out on one provider before moving on, however short each one is. */
const MAX_WAITS = 3;

/**
 * The share of its deadline a provider must still have after a wait: asked
 * again with no time left to answer in, it was waited on for nothing.
 */
const ROOM_TO_ANSWER = 1 / 3;

/**
 * What one provider's attempt has spent on asking again — rate-limit waits,
 * backoffs, bad replies — and the bad reply that made it ask: if the second
 * try fails another way, the provider still answered once, and the caller is
 * told so (`failuresOf`).
 */
type Tries = { waits: number; backoffs: number; badReplies: number; badReply?: unknown };

/** Whether the provider spent part of its deadline waiting before it was asked again. */
function waited(tries: Tries): boolean {
  return tries.waits + tries.backoffs > 0;
}

/**
 * A failure worth backing off on and asking the last resort again for: one
 * the SDK would have retried (`isRetryable`: a server error, an overloaded
 * provider, a network that did not connect, a rate limit), but no refusal for
 * good or for the day, and no rate limit that named a wait of its own, which
 * is sat out as stated or not at all.
 */
function isTransient(error: unknown, now: number): boolean {
  if (!APICallError.isInstance(error) || !error.isRetryable) return false;
  const refusal = refusalOf(error);
  if (refusal === 'permanent' || refusal === 'daily') return false;
  return refusal !== 'rate-limit' || statedWaitMs(error, now) === undefined;
}

/**
 * What one provider's attempt reports: its last failure, after the bad reply
 * it gave first when the try after that failed some other way.
 */
function failuresOf(name: string, failure: unknown, tries: Tries): { name: string; error: unknown }[] {
  const answeredFirst = tries.badReply !== undefined && !isBadReply(failure);
  return answeredFirst ? [{ name, error: tries.badReply }, { name, error: failure }] : [{ name, error: failure }];
}

/**
 * How long to wait before asking the same provider again after `error`, or
 * undefined to move on: no time at all, once, after a bad reply; the wait a
 * per-minute rate limit states, when the caller will wait that long; and,
 * for the last resort alone, two seconds and then four after a transient
 * failure. Every wait must leave the provider a third of its deadline to
 * answer in. A daily quota is never waited for here, whatever its message
 * says: Google's names a wait of seconds, which is its per-minute window's,
 * not the day's.
 */
function againAfter(
  name: string,
  error: unknown,
  attempt: AttemptControl,
  tries: Tries,
  options: FallbackOptions,
  now: number,
  lastResort: boolean,
): number | undefined {
  if (isBadReply(error)) {
    if (tries.badReplies >= 1) return undefined;
    tries.badReplies += 1;
    tries.badReply = error;
    logWarn('model', `${name} replied with JSON that does not fit the schema; asking it once more`);
    return 0;
  }
  const room = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs * ROOM_TO_ANSWER : 0;
  const fits = (wait: number): boolean => wait <= attempt.left(now) - room;
  const summary = describeError(error);
  const stated = refusalOf(error) === 'rate-limit' ? statedWaitMs(error, now) : undefined;
  if (stated !== undefined) {
    if (tries.waits >= MAX_WAITS || stated > (options.maxWaitMs ?? RATE_LIMIT_WAIT_MS) || !fits(stated)) return undefined;
    tries.waits += 1;
    logWarn('model', `${name} is rate-limited; asking it again in ${(stated / 1000).toFixed(1)} s rather than the next provider`, {
      status: summary.statusCode,
      message: summary.message,
    });
    return stated;
  }
  if (!lastResort || tries.backoffs >= BACKOFFS || !isTransient(error, now)) return undefined;
  const backoff = BACKOFF_MS * 2 ** tries.backoffs;
  if (!fits(backoff)) return undefined;
  tries.backoffs += 1;
  logWarn('model', `${name} failed with no provider behind it; asking it again in ${(backoff / 1000).toFixed(1)} s`, {
    status: summary.statusCode,
    message: summary.message,
  });
  return backoff;
}

/** Waits `ms`, or rejects with the reason `signal` aborts with, whichever comes first. */
async function pause(ms: number, signal: AbortSignal, sleep: ((ms: number) => Promise<void>) | undefined): Promise<void> {
  signal.throwIfAborted();
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => {};
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (sleep) sleep(ms).then(resolve, reject);
      else timer = setTimeout(resolve, ms);
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * What the breaker learns from one failed attempt. `failure` is a
 * `ResponseTimeoutError` when this attempt's own deadline fired, or when the
 * stream stalled before its first word (`proveStream`); a caller's timer
 * that fired instead (translation's `AbortSignal.timeout`) arrives as its own
 * `TimeoutError`, is not a permanent refusal, and so records nothing. Nor is
 * a deadline missed after a wait — out a rate limit, or a backoff: the
 * provider spent that time waiting as it was told, not hanging.
 */
function remember(name: string, failure: unknown, options: FallbackOptions, afterWait: boolean): void {
  if (options.circuit === false) return;
  if (failure instanceof ResponseTimeoutError) {
    if (options.demoteOnTimeout && !afterWait) recordTimeout(name);
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

/** For a non-streaming call — the query rewrite, a translation batch. */
export async function withFallback<T>(
  list: Candidate[],
  run: (candidate: Candidate, attempt: Attempt) => Promise<T>,
  options: FallbackOptions = {},
): Promise<{ value: T; candidate: Candidate }> {
  const failures: { name: string; error: unknown }[] = [];
  const circuit = options.circuit ?? true;
  const now = options.now ?? Date.now;

  for (const [index, candidate] of list.entries()) {
    options.signal?.throwIfAborted();
    const attempt = startAttempt(options.signal, options.timeoutMs, now());
    const tries: Tries = { waits: 0, backoffs: 0, badReplies: 0 };
    const lastResort = isLastResort(candidate, index, list.length);
    try {
      for (;;) {
        try {
          const value = await run(candidate, { maxRetries: 0, abortSignal: attempt.signal });
          if (circuit) recordSuccess(candidate.name);
          return { value, candidate };
        } catch (error) {
          if (options.signal?.aborted || attempt.timedOut()) throw error;
          const wait = againAfter(candidate.name, error, attempt, tries, options, now(), lastResort);
          if (wait === undefined) throw error;
          await pause(wait, attempt.signal, options.sleep);
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = attempt.timedOut() ? new ResponseTimeoutError(options.timeoutMs, waited(tries)) : error;
      remember(candidate.name, failure, options, waited(tries));
      failures.push(...failuresOf(candidate.name, failure, tries));
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
  const now = options.now ?? Date.now;

  for (const [index, candidate] of list.entries()) {
    options.signal?.throwIfAborted();
    const attempt = startAttempt(options.signal, options.timeoutMs, now());
    const tries: Tries = { waits: 0, backoffs: 0, badReplies: 0 };
    const lastResort = isLastResort(candidate, index, list.length);
    try {
      for (;;) {
        try {
          const built = build(candidate, { maxRetries: 0, abortSignal: attempt.signal });
          const stream = await proveStream(built.stream, options.signal);
          // Text arrived in time. From here a stall is the caller's chunk
          // deadline to enforce; this one is spent.
          attempt.settle();
          if (circuit) recordSuccess(candidate.name);
          return { stream, candidate };
        } catch (error) {
          if (options.signal?.aborted || attempt.timedOut()) throw error;
          // A refusal arrives as the stream's first part; the same provider's
          // stream is opened again once the wait it states is over.
          const wait = againAfter(candidate.name, error, attempt, tries, options, now(), lastResort);
          if (wait === undefined) throw error;
          await pause(wait, attempt.signal, options.sleep);
        }
      }
    } catch (error) {
      attempt.settle();
      if (options.signal?.aborted) throw error;
      const failure = attempt.timedOut() ? new ResponseTimeoutError(options.timeoutMs, waited(tries)) : error;
      remember(candidate.name, failure, options, waited(tries));
      failures.push(...failuresOf(candidate.name, failure, tries));
      warnFallback(candidate.name, failure, index < list.length - 1);
    }
  }

  throw new AllProvidersFailedError(failures);
}
