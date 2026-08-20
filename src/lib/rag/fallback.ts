import type { TextStreamPart, ToolSet } from 'ai';
import { recordFailure, recordSuccess } from './circuit';
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
 */

/** The last error, so a total failure reports the real cause rather than a summary. */
export class AllProvidersFailedError extends Error {
  constructor(readonly failures: { name: string; error: unknown }[]) {
    const detail = failures
      .map(({ name, error }) => `${name}: ${error instanceof Error ? error.message : String(error)}`)
      .join('; ');
    super(`Every model provider failed. ${detail}`);
    this.name = 'AllProvidersFailedError';
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

/** Passed to the caller so it can hand the budget to the SDK. */
export type Attempt = { readonly maxRetries: number };

/** For a non-streaming call — the query rewrite. */
export async function withFallback<T>(
  list: Candidate[],
  run: (candidate: Candidate, attempt: Attempt) => Promise<T>,
): Promise<{ value: T; candidate: Candidate }> {
  const failures: { name: string; error: unknown }[] = [];

  for (const [index, candidate] of list.entries()) {
    try {
      const value = await run(candidate, { maxRetries: attemptsFor(index, list.length) });
      recordSuccess(candidate.name);
      return { value, candidate };
    } catch (error) {
      recordFailure(candidate.name, error);
      failures.push({ name: candidate.name, error });
      console.warn(`[model] ${candidate.name} failed, trying the next provider:`, error);
    }
  }

  throw new AllProvidersFailedError(failures);
}

type Part = TextStreamPart<ToolSet>;

/**
 * Reads a stream until it proves itself, then replays everything it read.
 *
 * "Proves itself" means the first `text-delta`: a provider that is going to
 * reject the request does so before producing any text, so waiting for one
 * distinguishes a working provider from a failing one without the caller
 * seeing a partial answer from a provider that is about to die. The parts read
 * during that wait are buffered and re-emitted, so the consumer receives the
 * stream intact — `start` and `text-start` included, which the UI needs.
 */
async function proveStream(stream: ReadableStream<Part>): Promise<ReadableStream<Part>> {
  const reader = stream.getReader();
  const buffered: Part[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      /*
       * The SDK reports a provider rejection as a part rather than a rejected
       * promise, so this is the failure path, not an edge case.
       */
      if (value.type === 'error') throw value.error;

      buffered.push(value);
      if (value.type === 'text-delta' || value.type === 'finish') break;
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
): Promise<{ stream: ReadableStream<Part>; candidate: Candidate }> {
  const failures: { name: string; error: unknown }[] = [];

  for (const [index, candidate] of list.entries()) {
    try {
      const built = build(candidate, { maxRetries: attemptsFor(index, list.length) });
      const stream = await proveStream(built.stream);
      recordSuccess(candidate.name);
      return { stream, candidate };
    } catch (error) {
      recordFailure(candidate.name, error);
      failures.push({ name: candidate.name, error });
      console.warn(`[model] ${candidate.name} failed before streaming, trying the next:`, error);
    }
  }

  throw new AllProvidersFailedError(failures);
}
