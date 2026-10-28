import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordFailure, resetCircuits } from '@/lib/rag/circuit';
import { orderByCircuit, type Candidate } from '@/lib/rag/provider';

/**
 * The chain's order: live providers first, tripped ones after them, nobody
 * dropped. Dropping is the bug this pins: `ordered()` asked the breaker twice
 * per provider, and a cooldown that expired between the two answers made the
 * provider count as neither live nor tripped.
 */

const candidate = (name: string): Candidate => ({ name, model: name as never });
const XAI = candidate('xai/grok');
const GEMINI = candidate('google/gemini');
const GROQ = candidate('groq/gpt-oss');

afterEach(() => {
  resetCircuits();
  vi.restoreAllMocks();
});

describe('orderByCircuit', () => {
  it('keeps the configured order while nothing is tripped', () => {
    expect(orderByCircuit([XAI, GEMINI, GROQ])).toEqual([XAI, GEMINI, GROQ]);
  });

  it('moves a refusing provider to the back instead of dropping it', () => {
    recordFailure(XAI.name, { statusCode: 403 });
    expect(orderByCircuit([XAI, GEMINI, GROQ])).toEqual([GEMINI, GROQ, XAI]);
  });

  it('keeps a provider whose cooldown ends while the list is being ordered', () => {
    const start = 5_000_000;
    recordFailure(XAI.name, { statusCode: 403 }, start - 10 * 60 * 1000 + 1);
    // Every clock reading a millisecond later than the last: with two reads
    // per provider the cooldown would end between them.
    let tick = start;
    vi.spyOn(Date, 'now').mockImplementation(() => tick++);

    const list = orderByCircuit([XAI]);
    expect(list).toEqual([XAI]);
  });

  it('decides every provider against the same instant', () => {
    const now = 9_000_000;
    recordFailure(XAI.name, { statusCode: 403 }, now - 10 * 60 * 1000 + 5);
    expect(orderByCircuit([XAI, GEMINI], now)).toEqual([GEMINI, XAI]);
    expect(orderByCircuit([XAI, GEMINI], now + 10)).toEqual([XAI, GEMINI]);
  });
});
