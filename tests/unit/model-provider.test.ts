import { generateText, streamText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordFailure, resetCircuits } from '@/lib/rag/circuit';
import { resetGeminiProvider } from '@/lib/rag/gemini';
import { MAX_ANSWER_TOKENS, MAX_REWRITE_TOKENS } from '@/lib/rag/models';
import {
  answerCandidates,
  orderByCircuit,
  resetProviders,
  rewriteCandidates,
  type Candidate,
} from '@/lib/rag/provider';

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

/*
 * A request without an output ceiling is priced at the model's: OpenRouter
 * reserved 65,536 tokens for every rewrite and translation, on a key that
 * could afford 15,993, and refused them all with 402. So every model in the
 * operator's chain carries a ceiling for its job, whether or not the call
 * that uses it remembers to set one.
 */
describe('the output ceiling on every call the operator’s chain makes', () => {
  const KEYS = ['XAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY'] as const;
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetProviders();
    resetGeminiProvider();
    vi.unstubAllGlobals();
  });

  /** Every provider configured, and every request answered 400 here, before it can leave the machine. */
  function allProvidersOffline(): { name: string; body: string }[] {
    for (const key of KEYS) process.env[key] = `test-${key.toLowerCase()}`;
    resetProviders();
    resetGeminiProvider();
    const requests: { name: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ name: String(url), body: typeof init?.body === 'string' ? init.body : '' });
      return Response.json({ error: { message: 'offline in tests', type: 'invalid_request_error', code: 400 } }, { status: 400 });
    });
    return requests;
  }

  /** The ceiling a request body asks for, whichever field its provider uses. */
  const ceilingOf = (body: string): number | undefined => {
    const match = /"(?:max_tokens|max_completion_tokens|max_output_tokens|maxOutputTokens)":(\d+)/.exec(body);
    return match ? Number(match[1]) : undefined;
  };

  it('asks no provider for more than a rewrite needs when the rewrite sets no ceiling of its own', async () => {
    const requests = allProvidersOffline();
    const chain = rewriteCandidates();
    expect(chain.map((c) => c.name.split('/')[0])).toEqual(['xai', 'google', 'groq', 'cerebras', 'openrouter']);
    for (const candidate of chain) {
      await generateText({ model: candidate.model, prompt: 'Question: ¿dónde hay cobre?', maxRetries: 0 }).catch(() => {});
    }
    expect(requests).toHaveLength(5);
    expect(requests.map((r) => ceilingOf(r.body))).toEqual(Array(5).fill(MAX_REWRITE_TOKENS));
  });

  it('caps the answer at its own ceiling, and lets a call that sets one keep it', async () => {
    const requests = allProvidersOffline();
    for (const candidate of answerCandidates()) {
      const result = streamText({ model: candidate.model, prompt: 'x', maxRetries: 0, onError: () => {} });
      await Promise.resolve(result.consumeStream()).catch(() => {});
    }
    for (const candidate of rewriteCandidates()) {
      await generateText({ model: candidate.model, prompt: 'x', maxRetries: 0, maxOutputTokens: 1_234 }).catch(() => {});
    }
    expect(requests.map((r) => ceilingOf(r.body))).toEqual([...Array(5).fill(MAX_ANSWER_TOKENS), ...Array(5).fill(1_234)]);
  });
});
