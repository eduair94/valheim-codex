import { describe, expect, it, vi } from 'vitest';
import { AllProvidersFailedError, streamWithFallback, withFallback } from '@/lib/rag/fallback';
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
