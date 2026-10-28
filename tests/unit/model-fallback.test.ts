import { APICallError, generateText, NoObjectGeneratedError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTripped, recordFailure, refusalOf, resetCircuits } from '@/lib/rag/circuit';
import {
  AllProvidersFailedError,
  EmptyResponseError,
  isBadReply,
  ResponseTimeoutError,
  streamWithFallback,
  withFallback,
} from '@/lib/rag/fallback';
import type { Candidate } from '@/lib/rag/provider';

/**
 * Two providers exist because one of them is regularly unavailable: Gemini's
 * free tier rate-limits at 20 requests a minute and an unpaid xAI team answers
 * 403 to everything. Those are the ordinary operating conditions here, not
 * exotic failures, so the switch between providers is worth pinning.
 */

const candidate = (name: string): Candidate => ({ name, model: name as never });
const A = candidate('xai/grok');
const B = candidate('google/gemini');

function partStream(parts: unknown[]): ReadableStream<never> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part as never);
      controller.close();
    },
  });
}

const START = { type: 'start' };
const TEXT_START = { type: 'text-start', id: '1' };
const delta = (text: string) => ({ type: 'text-delta', id: '1', text });

async function collect(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe('withFallback', () => {
  it('uses the first provider that works and does not call the rest', async () => {
    const second = vi.fn();
    const { value, candidate: used } = await withFallback([A, B], async (c) => {
      if (c === B) second();
      return c.name;
    });

    expect(value).toBe('xai/grok');
    expect(used).toBe(A);
    expect(second).not.toHaveBeenCalled();
  });

  it('moves to the next provider when the first refuses', async () => {
    const { value, candidate: used } = await withFallback([A, B], async (c) => {
      if (c === A) throw new Error('403 permission-denied: no credits');
      return c.name;
    });

    expect(value).toBe('google/gemini');
    expect(used).toBe(B);
  });

  it('reports every failure when nothing works, not just the last', async () => {
    const attempt = withFallback([A, B], async (c) => {
      throw new Error(c === A ? '403 no credits' : '429 quota exceeded');
    });

    await expect(attempt).rejects.toThrow(AllProvidersFailedError);
    // The operator needs both causes: one key to top up, one quota to wait out.
    await expect(attempt).rejects.toThrow(/403 no credits/);
    await expect(attempt).rejects.toThrow(/429 quota exceeded/);
  });
});

describe('streamWithFallback', () => {
  it('replays the parts it consumed while proving the stream', async () => {
    // `start` and `text-start` are read before the first delta proves the
    // provider is alive. Dropping them leaves the UI with no message to fill.
    const { stream } = await streamWithFallback([A], () => ({
      stream: partStream([START, TEXT_START, delta('Necesitás '), delta('hierro.')]),
    }));

    expect(await collect(stream)).toEqual([
      START,
      TEXT_START,
      delta('Necesitás '),
      delta('hierro.'),
    ]);
  });

  it('switches provider when the first errors before any text', async () => {
    const { stream, candidate: used } = await streamWithFallback([A, B], (c) =>
      c === A
        ? { stream: partStream([START, { type: 'error', error: new Error('403 no credits') }]) }
        : { stream: partStream([START, TEXT_START, delta('Hierro.')]) },
    );

    expect(used).toBe(B);
    expect(await collect(stream)).toEqual([START, TEXT_START, delta('Hierro.')]);
  });

  it('does not switch once text is flowing', async () => {
    /*
     * A provider that dies mid-answer keeps its partial text. Retrying here
     * would either repeat what the reader already saw or discard it in the
     * middle of a sentence, and a truncated answer beats both.
     */
    const second = vi.fn();
    const { stream, candidate: used } = await streamWithFallback([A, B], (c) => {
      if (c === B) second();
      return {
        stream: partStream([START, TEXT_START, delta('Necesitás '), { type: 'error', error: new Error('stream died') }]),
      };
    });

    expect(used).toBe(A);
    expect(second).not.toHaveBeenCalled();
    expect(await collect(stream)).toContainEqual(delta('Necesitás '));
  });

  it('fails loudly when no provider can stream', async () => {
    const attempt = streamWithFallback([A, B], () => ({
      stream: partStream([{ type: 'error', error: new Error('everything is down') }]),
    }));

    await expect(attempt).rejects.toThrow(AllProvidersFailedError);
  });
});

/*
 * Streams that end without text. A Gemini prompt block finishes with no
 * candidates (finishReason `other`), a safety stop finishes before any text,
 * and a reasoning model can spend its whole budget thinking. Each of these
 * used to be accepted as a working provider: the reader got an empty bubble
 * and the next provider was never asked.
 */
describe('streamWithFallback: answers with no text', () => {
  const FINISH = (finishReason: string) => ({ type: 'finish', finishReason, rawFinishReason: finishReason });

  it.each([
    ['a safety stop before any text', [START, FINISH('content-filter')]],
    ['a blocked prompt (finish "other", no candidates)', [START, { type: 'start-step' }, FINISH('other')]],
    ['reasoning only, then the length limit', [START, { type: 'reasoning-delta', id: 'r', text: '…' }, FINISH('length')]],
    ['a stream that just closes', [START]],
    ['an empty text delta', [START, TEXT_START, delta(''), FINISH('stop')]],
    ['line breaks, then a safety stop', [START, TEXT_START, delta('\n\n'), delta(' '), FINISH('content-filter')]],
  ])('moves on after %s', async (_label, parts) => {
    const { stream, candidate: used } = await streamWithFallback([A, B], (c) =>
      c === A ? { stream: partStream(parts) } : { stream: partStream([START, TEXT_START, delta('Hierro.')]) },
    );

    expect(used).toBe(B);
    expect(await collect(stream)).toEqual([START, TEXT_START, delta('Hierro.')]);
  });

  it('keeps leading whitespace once real text follows it', async () => {
    const { stream, candidate: used } = await streamWithFallback([A, B], () => ({
      stream: partStream([START, TEXT_START, delta('\n'), delta('Hierro.')]),
    }));
    expect(used).toBe(A);
    expect(await collect(stream)).toEqual([START, TEXT_START, delta('\n'), delta('Hierro.')]);
  });

  it('treats an abort that is not the caller as that provider timing out', async () => {
    const { candidate: used } = await streamWithFallback([A, B], (c) =>
      c === A
        ? { stream: partStream([START, { type: 'abort', reason: 'Chunk timeout' }]) }
        : { stream: partStream([START, TEXT_START, delta('Hierro.')]) },
    );
    expect(used).toBe(B);
  });

  it('reports every failure as empty when no provider writes anything', async () => {
    const attempt = streamWithFallback([A, B], () => ({ stream: partStream([START, FINISH('content-filter')]) }));

    const error = await attempt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AllProvidersFailedError);
    expect((error as AllProvidersFailedError).failures.map((f) => f.error)).toEqual([
      expect.any(EmptyResponseError),
      expect.any(EmptyResponseError),
    ]);
  });
});

/** A provider that never sends anything until its signal aborts — the stall the deadline exists for. */
function stallingStream(signal: AbortSignal): ReadableStream<never> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(START as never);
      signal.addEventListener('abort', () => {
        controller.enqueue({ type: 'abort', reason: String(signal.reason) } as never);
        controller.close();
      });
    },
  });
}

describe('streamWithFallback: deadlines and the reader leaving', () => {
  it('gives up on a silent provider at the deadline and asks the next', async () => {
    const started = Date.now();
    const { stream, candidate: used } = await streamWithFallback(
      [A, B],
      (c, attempt) =>
        c === A ? { stream: stallingStream(attempt.abortSignal) } : { stream: partStream([START, TEXT_START, delta('Hierro.')]) },
      { timeoutMs: 50 },
    );

    expect(used).toBe(B);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await collect(stream)).toContainEqual(delta('Hierro.'));
  });

  it('records the miss as a timeout, which only demotes the provider for a while', async () => {
    const attempt = streamWithFallback([A], (_c, a) => ({ stream: stallingStream(a.abortSignal) }), { timeoutMs: 20 });
    const error = (await attempt.catch((e: unknown) => e)) as AllProvidersFailedError;
    expect(error.failures[0]?.error).toBeInstanceOf(ResponseTimeoutError);
  });

  it('does not start the next provider once the reader has left', async () => {
    const reader = new AbortController();
    const second = vi.fn();
    const attempt = streamWithFallback(
      [A, B],
      (c, a) => {
        if (c === B) second();
        queueMicrotask(() => reader.abort(new DOMException('gone', 'AbortError')));
        return { stream: stallingStream(a.abortSignal) };
      },
      { signal: reader.signal, timeoutMs: 5_000 },
    );

    await expect(attempt).rejects.toThrow(/gone/);
    expect(second).not.toHaveBeenCalled();
  });

  it('refuses to start at all when the reader is already gone', async () => {
    const reader = new AbortController();
    reader.abort(new DOMException('gone', 'AbortError'));
    const build = vi.fn();
    await expect(streamWithFallback([A], build, { signal: reader.signal })).rejects.toThrow(/gone/);
    expect(build).not.toHaveBeenCalled();
  });

  it('hands each attempt a signal that the deadline aborts', async () => {
    let seen: AbortSignal | undefined;
    await streamWithFallback(
      [A, B],
      (c, a) => {
        if (c === A) seen = a.abortSignal;
        return c === A ? { stream: stallingStream(a.abortSignal) } : { stream: partStream([START, TEXT_START, delta('x')]) };
      },
      { timeoutMs: 20 },
    );
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(ResponseTimeoutError);
  });
});

/*
 * A missed deadline demotes a provider for a minute — for every feature, since
 * the rewrite, the answer and translation share candidate names. So only the
 * answer's first-word deadline may do it.
 */
describe('which timeouts demote a provider', () => {
  beforeEach(() => resetCircuits());

  it('the answer’s first-word deadline does, when the caller asks for it', async () => {
    await streamWithFallback(
      [A, B],
      (c, a) => (c === A ? { stream: stallingStream(a.abortSignal) } : { stream: partStream([START, TEXT_START, delta('x')]) }),
      { timeoutMs: 20, demoteOnTimeout: true },
    );
    expect(isTripped(A.name)).toBe(true);
    expect(isTripped(B.name)).toBe(false);
  });

  it('a deadline that was not asked to demote (the rewrite’s) does not', async () => {
    await withFallback(
      [A, B],
      (c, attempt) =>
        c === A
          ? new Promise<string>((_resolve, reject) => {
              attempt.abortSignal.addEventListener('abort', () => reject(attempt.abortSignal.reason));
            })
          : Promise.resolve('B answered'),
      { timeoutMs: 20 },
    );
    expect(isTripped(A.name)).toBe(false);
  });

  it('a caller’s own timer (translation’s AbortSignal.timeout) does not', async () => {
    await withFallback([A, B], (c) =>
      c === A
        ? Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        : Promise.resolve('B answered'),
    );
    expect(isTripped(A.name)).toBe(false);
  });

  it('a permanent refusal still does, for everyone', async () => {
    await withFallback([A, B], (c) =>
      c === A ? Promise.reject(Object.assign(new Error('forbidden'), { statusCode: 403 })) : Promise.resolve('B'),
    );
    expect(isTripped(A.name)).toBe(true);
  });

  it('nothing does when the circuit is off (a reader’s own key)', async () => {
    await streamWithFallback(
      [A],
      (_c, a) => ({ stream: stallingStream(a.abortSignal) }),
      { timeoutMs: 20, demoteOnTimeout: true, circuit: false },
    ).catch(() => {});
    expect(isTripped(A.name)).toBe(false);
  });
});

describe('withFallback: deadlines and the reader leaving', () => {
  it('moves on when a provider misses its deadline', async () => {
    const { value } = await withFallback(
      [A, B],
      (c, attempt) =>
        c === A
          ? new Promise<string>((_resolve, reject) => {
              attempt.abortSignal.addEventListener('abort', () => reject(attempt.abortSignal.reason));
            })
          : Promise.resolve('B answered'),
      { timeoutMs: 30 },
    );
    expect(value).toBe('B answered');
  });

  it('stops the chain, without trying the next, when the caller aborts', async () => {
    const reader = new AbortController();
    const second = vi.fn();
    const attempt = withFallback(
      [A, B],
      (c, a) => {
        if (c === B) second();
        return new Promise<string>((_resolve, reject) => {
          a.abortSignal.addEventListener('abort', () => reject(new DOMException('gone', 'AbortError')));
          reader.abort();
        });
      },
      { signal: reader.signal },
    );
    await expect(attempt).rejects.toThrow(/gone/);
    expect(second).not.toHaveBeenCalled();
  });
});

/*
 * The production translation run of 2026-10-28 stopped on a Groq refusal that
 * said "Please try again in 510ms": the chain moved on to four providers that
 * were out of credit or out of their day, and every one refused. A provider
 * that says when it will answer is waited for, as long as the wait leaves it
 * time to answer before its deadline.
 */

function refused(status: number, message: string, body?: string): APICallError {
  return new APICallError({
    message,
    url: 'https://provider.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: status,
    responseBody: body,
    isRetryable: false,
  });
}

const groqPerMinute = (wait: string) =>
  refused(
    429,
    'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_test` service tier `on_demand` on ' +
      `tokens per minute (TPM): Limit 8000, Used 6176, Requested 1892. Please try again in ${wait}.`,
  );
const GEMINI_DAY = refused(
  429,
  'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: ' +
    'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-2.5-flash-lite, ' +
    'description: Generate content requests per day limit exceeded on Free Tier.\nPlease retry in 2s.',
);
const groqBadJson = () =>
  refused(
    400,
    "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
    JSON.stringify({ error: { type: 'invalid_request_error', code: 'json_validate_failed', failed_generation: '{"translations":[1]}' } }),
  );

/** A clock that only moves when the code under test waits on it. */
function fakeClock(start = 1_000_000) {
  let time = start;
  const waits: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
    waits,
  };
}

describe('a short rate limit is waited out on the same provider', () => {
  beforeEach(() => {
    resetCircuits();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits the time the refusal states and asks the same provider again, never the next', async () => {
    const clock = fakeClock();
    const asked: string[] = [];
    const { value, candidate: used } = await withFallback(
      [A, B],
      async (c) => {
        asked.push(c.name);
        if (asked.length === 1) throw groqPerMinute('510ms');
        return `${c.name} answered`;
      },
      { timeoutMs: 60_000, now: clock.now, sleep: clock.sleep },
    );
    expect(value).toBe('xai/grok answered');
    expect(used).toBe(A);
    expect(asked).toEqual([A.name, A.name]);
    expect(clock.waits).toEqual([510]);
  });

  it('moves on when the stated wait is longer than the caller will wait', async () => {
    const clock = fakeClock();
    const { candidate: used } = await withFallback(
      [A, B],
      async (c) => {
        if (c === A) throw groqPerMinute('45s');
        return 'B';
      },
      { timeoutMs: 120_000, maxWaitMs: 20_000, now: clock.now, sleep: clock.sleep },
    );
    expect(used).toBe(B);
    expect(clock.waits).toEqual([]);
  });

  it('moves on when waiting would leave the provider too little of its deadline to answer in', async () => {
    // The chat's first word is due within 15 seconds: 12.8 of them spent waiting leaves no time to answer.
    const late = fakeClock();
    const { candidate: used } = await withFallback(
      [A, B],
      async (c) => {
        if (c === A) throw groqPerMinute('12.7875s');
        return 'B';
      },
      { timeoutMs: 15_000, now: late.now, sleep: late.sleep },
    );
    expect(used).toBe(B);
    expect(late.waits).toEqual([]);

    const soon = fakeClock();
    let first = true;
    const again = await withFallback(
      [A, B],
      async (c) => {
        if (c === A && first) {
          first = false;
          throw groqPerMinute('5s');
        }
        return c.name;
      },
      { timeoutMs: 15_000, now: soon.now, sleep: soon.sleep },
    );
    expect(again.candidate).toBe(A);
    expect(soon.waits).toEqual([5_000]);
  });

  it('never waits on a daily quota, whatever wait its message mentions', async () => {
    const clock = fakeClock();
    const { candidate: used } = await withFallback(
      [A, B],
      async (c) => {
        if (c === A) throw GEMINI_DAY;
        return 'B';
      },
      { timeoutMs: 60_000, now: clock.now, sleep: clock.sleep },
    );
    expect(used).toBe(B);
    expect(clock.waits).toEqual([]);
  });

  it('gives a provider that keeps refusing three waits, then moves on', async () => {
    const clock = fakeClock();
    const asked: string[] = [];
    const { candidate: used } = await withFallback(
      [A, B],
      async (c) => {
        asked.push(c.name);
        if (c === A) throw groqPerMinute('1s');
        return 'B';
      },
      { timeoutMs: 60_000, now: clock.now, sleep: clock.sleep },
    );
    expect(used).toBe(B);
    expect(asked).toEqual([A.name, A.name, A.name, A.name, B.name]);
    expect(clock.waits).toEqual([1_000, 1_000, 1_000]);
  });

  it('stops waiting, and asks no one else, when the caller leaves', async () => {
    const reader = new AbortController();
    const second = vi.fn();
    const attempt = withFallback(
      [A, B],
      async (c) => {
        if (c === B) second();
        throw groqPerMinute('5s');
      },
      {
        signal: reader.signal,
        timeoutMs: 60_000,
        sleep: () => {
          reader.abort(new DOMException('gone', 'AbortError'));
          return new Promise<void>(() => {});
        },
      },
    );
    await expect(attempt).rejects.toThrow(/gone/);
    expect(second).not.toHaveBeenCalled();
  });

  it('opens the same provider’s stream again for the chat, once the wait is over', async () => {
    const clock = fakeClock();
    const opened: string[] = [];
    const { stream, candidate: used } = await streamWithFallback(
      [A, B],
      (c) => {
        opened.push(c.name);
        return opened.length === 1
          ? { stream: partStream([START, { type: 'error', error: groqPerMinute('2s') }]) }
          : { stream: partStream([START, TEXT_START, delta('Hierro.')]) };
      },
      { timeoutMs: 15_000, demoteOnTimeout: true, now: clock.now, sleep: clock.sleep },
    );
    expect(used).toBe(A);
    expect(opened).toEqual([A.name, A.name]);
    expect(clock.waits).toEqual([2_000]);
    expect(await collect(stream)).toContainEqual(delta('Hierro.'));
  });

  it('keeps the chat’s first word on time: a wait longer than its deadline allows goes to the next provider', async () => {
    const clock = fakeClock();
    const { candidate: used } = await streamWithFallback(
      [A, B],
      (c) =>
        c === A
          ? { stream: partStream([START, { type: 'error', error: groqPerMinute('12.7875s') }]) }
          : { stream: partStream([START, TEXT_START, delta('Hierro.')]) },
      { timeoutMs: 15_000, demoteOnTimeout: true, now: clock.now, sleep: clock.sleep },
    );
    expect(used).toBe(B);
    expect(clock.waits).toEqual([]);
  });

  it('does not demote a provider that waited out a rate limit and then ran out of time', async () => {
    let opened = 0;
    await streamWithFallback(
      [A, B],
      (c, a) => {
        if (c === B) return { stream: partStream([START, TEXT_START, delta('x')]) };
        opened += 1;
        return opened === 1
          ? { stream: partStream([START, { type: 'error', error: groqPerMinute('1ms') }]) }
          : { stream: stallingStream(a.abortSignal) };
      },
      { timeoutMs: 60, demoteOnTimeout: true },
    );
    expect(opened).toBe(2);
    expect(isTripped(A.name)).toBe(false);
  });

  it('says so when a deadline was missed after a wait, so the caller does not take it for the request’s length', async () => {
    // The translator holds a timeout on a long string against the text: a
    // provider that spent two thirds of its time waiting as it was told had
    // only the rest to write in.
    const hang = (attempt: { abortSignal: AbortSignal }) =>
      new Promise<string>((_resolve, reject) => {
        attempt.abortSignal.addEventListener('abort', () => reject(attempt.abortSignal.reason));
      });
    let calls = 0;
    const waited = (await withFallback(
      [A],
      async (_c, attempt) => {
        calls += 1;
        if (calls === 1) throw groqPerMinute('1ms');
        return hang(attempt);
      },
      { timeoutMs: 60 },
    ).catch((e: unknown) => e)) as AllProvidersFailedError;
    const late = (await withFallback([A], (_c, attempt) => hang(attempt), { timeoutMs: 60 }).catch(
      (e: unknown) => e,
    )) as AllProvidersFailedError;

    expect(waited.failures.map((f) => f.error)).toEqual([expect.any(ResponseTimeoutError)]);
    expect((waited.failures[0]!.error as ResponseTimeoutError).afterWait).toBe(true);
    expect((late.failures[0]!.error as ResponseTimeoutError).afterWait).toBe(false);
  });

  it('words that deadline so nothing reads it as a rate limit: a provider that ran out of time did not refuse', () => {
    // Refusals are read from their words when they carry no status, and a
    // refusal ends a translation the reader is waiting on at once.
    expect(refusalOf(new ResponseTimeoutError(15_000, true))).toBeNull();
    expect(refusalOf(new ResponseTimeoutError(15_000))).toBeNull();
  });
});

/*
 * The last provider is asked again after a backoff, for want of anywhere else
 * to go — by the chain itself, never by the SDK. The SDK's retries sat out a
 * rate limit where the chain could not see it, so a deadline missed after
 * that wait read as a request too long to answer; and they backed off blind
 * to the wait Groq writes in its message and Google in its body. Nor is a
 * provider the breaker set aside asked again: out of credit, or out of its
 * day, it answers every retry the same way. Gemini's spent daily quota, last
 * in line, cost three requests and six seconds of backoff on every chain that
 * reached it.
 */
describe('asking the last provider again', () => {
  beforeEach(() => {
    resetCircuits();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A failure the SDK would have retried. */
  const transient = (status: number, message: string) =>
    new APICallError({
      message,
      url: 'https://provider.test/v1/chat/completions',
      requestBodyValues: {},
      statusCode: status,
      isRetryable: true,
    });

  it('gives the SDK no retries: every one goes through the chain, which sees the wait', async () => {
    const budgets: number[] = [];
    await withFallback([A, B], async (_c, attempt) => {
      budgets.push(attempt.maxRetries);
      throw refused(503, 'The model is overloaded.');
    }).catch(() => {});
    expect(budgets).toEqual([0, 0]);
  });

  it('asks the last live provider again after two seconds and four, as the SDK did, and no one else', async () => {
    const clock = fakeClock();
    const asked: string[] = [];
    const fail = async (c: Candidate) => {
      asked.push(c.name);
      throw transient(503, 'The model is overloaded.');
    };
    await withFallback([A, B], fail, { timeoutMs: 60_000, now: clock.now, sleep: clock.sleep }).catch(() => {});
    expect(asked).toEqual([A.name, B.name, B.name, B.name]);
    expect(clock.waits).toEqual([2_000, 4_000]);

    // Set aside for the day, it is asked once and left.
    asked.length = 0;
    clock.waits.length = 0;
    recordFailure(B.name, GEMINI_DAY);
    await withFallback([A, B], fail, { timeoutMs: 60_000, now: clock.now, sleep: clock.sleep }).catch(() => {});
    expect(asked).toEqual([A.name, B.name]);
    expect(clock.waits).toEqual([]);
  });

  it('sits out the wait a last provider’s rate limit states, where the SDK would have guessed', async () => {
    const clock = fakeClock();
    let calls = 0;
    const { candidate: used } = await withFallback(
      [A],
      async () => {
        calls += 1;
        if (calls === 1) throw transient(429, groqPerMinute('7.5s').message);
        return 'answered';
      },
      { timeoutMs: 60_000, now: clock.now, sleep: clock.sleep },
    );
    expect(used).toBe(A);
    expect(clock.waits).toEqual([7_500]);
  });

  it('backs off only while the deadline still leaves a third of it to answer in', async () => {
    // Three seconds: the two-second backoff leaves one to answer in, the four-second one none.
    const clock = fakeClock();
    let calls = 0;
    await withFallback(
      [A],
      async () => {
        calls += 1;
        throw transient(503, 'The model is overloaded.');
      },
      { timeoutMs: 3_000, now: clock.now, sleep: clock.sleep },
    ).catch(() => {});
    expect(calls).toBe(2);
    expect(clock.waits).toEqual([2_000]);
  });

  it('says a deadline missed after the last provider backed off came after a wait', async () => {
    const clock = fakeClock();
    let calls = 0;
    const error = (await withFallback(
      [A],
      async (_c, attempt) => {
        calls += 1;
        if (calls === 1) throw transient(503, 'The model is overloaded.');
        return new Promise<string>((_resolve, reject) => {
          attempt.abortSignal.addEventListener('abort', () => reject(attempt.abortSignal.reason));
        });
      },
      { timeoutMs: 3_000, now: clock.now, sleep: clock.sleep },
    ).catch((e: unknown) => e)) as AllProvidersFailedError;
    expect(calls).toBe(2);
    expect((error.failures.at(-1)!.error as ResponseTimeoutError).afterWait).toBe(true);
  }, 20_000);

  it('never ask a spent daily quota again through the SDK’s backoff', async () => {
    const calls = { gemini: 0 };
    const gemini: Candidate = {
      name: 'google/gemini-2.5-flash-lite',
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          calls.gemini += 1;
          // How the Google adapter reports it: a 429, which the SDK retries.
          throw new APICallError({
            message: GEMINI_DAY.message,
            url: 'https://provider.test/v1beta/models',
            requestBodyValues: {},
            statusCode: 429,
            isRetryable: true,
          });
        },
      }),
    };
    const groq: Candidate = {
      name: 'groq/openai/gpt-oss-120b',
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw refused(503, 'The model is overloaded.');
        },
      }),
    };
    // Spent a while ago; the ten-minute cooldowns of the others have run out.
    recordFailure(gemini.name, GEMINI_DAY);

    const started = Date.now();
    await withFallback([groq, gemini], (c, attempt) =>
      generateText({ model: c.model, prompt: 'x', maxRetries: attempt.maxRetries, abortSignal: attempt.abortSignal }),
    ).catch(() => {});
    expect(calls.gemini).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 20_000);
});

/*
 * Groq checks a structured reply against the schema itself, and answers 400
 * "Failed to validate JSON" when the model's reply does not fit. That is an
 * answer, if a bad one: the provider is up, and the same request often comes
 * back right the second time. The production run took it for a provider that
 * could not answer.
 */
describe('a reply that fails validation is a bad reply, not a dead provider', () => {
  beforeEach(() => {
    resetCircuits();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['Groq’s 400 "Failed to validate JSON"', groqBadJson()],
    ['Groq’s 400 "Failed to generate JSON"', refused(400, "Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.")],
    ['the SDK’s NoObjectGeneratedError', new NoObjectGeneratedError({ message: 'No object generated: response did not match schema.', text: '{}' } as never)],
  ])('recognises %s', (_label, error) => {
    expect(isBadReply(error)).toBe(true);
  });

  it.each([
    ['a refusal', groqPerMinute('1s')],
    ['a server error', refused(503, 'The model is overloaded.')],
    ['a 400 about something else', refused(400, 'max_tokens must be at least 1')],
  ])('does not take %s for one', (_label, error) => {
    expect(isBadReply(error)).toBe(false);
  });

  it('asks the same provider once more, at once', async () => {
    const asked: string[] = [];
    const { value, candidate: used } = await withFallback([A, B], async (c) => {
      asked.push(c.name);
      if (asked.length === 1) throw groqBadJson();
      return 'translated';
    });
    expect(value).toBe('translated');
    expect(used).toBe(A);
    expect(asked).toEqual([A.name, A.name]);
  });

  it('reports the bad reply a provider gave before it refused, so the caller knows it answered', async () => {
    // A provider that replied has done work that was paid for, even if the
    // second try was refused: the translator keeps a reader's unit for it.
    let calls = 0;
    const attempt = withFallback([A], async () => {
      calls += 1;
      throw calls === 1 ? groqBadJson() : groqPerMinute('90s');
    });
    const error = (await attempt.catch((e: unknown) => e)) as AllProvidersFailedError;
    expect(error.failures.map((f) => isBadReply(f.error))).toEqual([true, false]);
    expect(error.failures.map((f) => f.name)).toEqual([A.name, A.name]);
  });

  it('moves on after a second bad reply, holding nothing against the provider', async () => {
    const asked: string[] = [];
    const attempt = withFallback([A, B], async (c) => {
      asked.push(c.name);
      throw groqBadJson();
    });
    const error = (await attempt.catch((e: unknown) => e)) as AllProvidersFailedError;
    expect(error).toBeInstanceOf(AllProvidersFailedError);
    expect(asked).toEqual([A.name, A.name, B.name, B.name]);
    expect(error.failures.every((f) => isBadReply(f.error))).toBe(true);
    expect(isTripped(A.name)).toBe(false);
    expect(isTripped(B.name)).toBe(false);
  });
});
