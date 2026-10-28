import { APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { Candidate } from '@/lib/rag/provider';
import type { Pacer } from '@/lib/wiki/translate';

/**
 * A translation model for tests, so nothing here ever reaches a provider.
 *
 * It reads the strings back out of the prompt the translator built — one
 * numbered JSON string per line — and answers with `respond(strings)`,
 * by default `ES:` + each string, so a value landing in the wrong slot is
 * visible. Every request's strings are recorded in `calls`.
 */

type Message = { role: string; content: string | { type: string; text?: string }[] };

/** The strings one translation request carried. */
export function promptStrings(prompt: unknown): string[] {
  const text = (prompt as Message[])
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('')))
    .join('\n');
  return text.split('\n').flatMap((line) => {
    const match = /^\d+\. (".*")$/.exec(line);
    return match ? [JSON.parse(match[1]!) as string] : [];
  });
}

export type Respond = (
  strings: string[],
  call: number,
  signal?: AbortSignal,
) => string[] | Error | Promise<string[] | Error>;

export const spanish: Respond = (strings) => strings.map((s) => `ES:${s}`);

/** What `garbage()` returns: answered, as text that is not the JSON asked for. */
class UnusableReply extends Error {}

export function mockTranslator(respond: Respond = spanish, name = 'mock/translator') {
  const calls: string[][] = [];
  const reply = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    warnings: [],
  });
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'translator',
    doGenerate: async (options) => {
      const strings = promptStrings(options.prompt);
      calls.push(strings);
      const out = await respond(strings, calls.length - 1, options.abortSignal);
      if (out instanceof UnusableReply) return reply(out.message);
      if (out instanceof Error) throw out;
      return reply(JSON.stringify({ translations: out }));
    },
  });
  const candidate: Candidate = { name, model };
  return { candidate, candidates: () => [candidate], calls };
}

/** A provider refusing for a reason about the account or its quota (not retried by the SDK). */
export function refusal(status = 429): Error {
  return Object.assign(new Error(status === 429 ? 'Too Many Requests' : 'Forbidden'), { statusCode: status });
}

/**
 * The model answered, and what it wrote is not the list asked for: the SDK
 * fails to parse it and raises its own `NoObjectGeneratedError`, exactly as
 * for a real reply in prose. Held against the strings.
 */
export function garbage(): Error {
  return new UnusableReply('Sorry, I can only translate one string at a time.');
}

/**
 * A provider that could not answer at all, the way the SDK reports it: a 5xx
 * or "overloaded" (`status`), or with no status a network that never
 * connected. Marked not retryable, so the SDK does not back off for seconds
 * in a test. Never held against the strings.
 */
export function unavailable(status?: number): APICallError {
  return new APICallError({
    message: status === undefined ? 'Cannot connect to API: getaddrinfo ENOTFOUND provider.test' : 'The model is overloaded.',
    url: 'https://provider.test/v1/generate',
    requestBodyValues: {},
    statusCode: status,
    isRetryable: false,
  });
}

/**
 * Turns granted at once, in place of the reader endpoint's shared pacer (one
 * request every four seconds), and a count of how many were asked for.
 */
export function instantPacer(): Pacer & { turns: number } {
  const pacer = {
    turns: 0,
    take: async () => {
      pacer.turns += 1;
      return true;
    },
  };
  return pacer;
}
