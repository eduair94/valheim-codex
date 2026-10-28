import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTripped, resetCircuits } from '@/lib/rag/circuit';
import {
  AllProvidersFailedError,
  EmptyResponseError,
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
