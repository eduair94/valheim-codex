import { generateText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  byokModel,
  byokProviderOptions,
  ByokKeyMissingError,
  ByokModelNotAllowedError,
  supportsThinkingLevel,
} from '@/lib/rag/byok-model';

/**
 * A reader's own key must be the only key a BYOK request can ever use.
 * `createGoogle({ apiKey: undefined })` silently reads the operator's
 * GOOGLE_GENERATIVE_AI_API_KEY instead, so the guard and the header are
 * pinned here, with fetch intercepted and nothing sent anywhere.
 */

const USER_KEY = 'AIzaUSERKEYuserkeyUSERKEYuserkey12345';
const OPERATOR_KEY = 'AIzaOPERATORoperatorOPERATORoperator12';

const ORIGINAL = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

beforeEach(() => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = OPERATOR_KEY;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  else process.env.GOOGLE_GENERATIVE_AI_API_KEY = ORIGINAL;
  vi.unstubAllGlobals();
});

describe('byokModel', () => {
  it.each([[undefined], [null], [''], ['   '], ['too-short'], [42]])('refuses to build a model without a key (%s)', (key) => {
    expect(() => byokModel(key, 'gemini-3.5-flash-lite')).toThrow(ByokKeyMissingError);
  });

  it('offers only the allowed models', () => {
    expect(() => byokModel(USER_KEY, 'gemini-3.6-flash')).toThrow(ByokModelNotAllowedError);
    expect(() => byokModel(USER_KEY, 'grok-4')).toThrow(ByokModelNotAllowedError);
    expect(byokModel(USER_KEY, 'gemini-3.1-flash-lite').name).toBe('byok/gemini-3.1-flash-lite');
  });

  it('sends the reader’s key and never the operator’s', async () => {
    const seen: { url: string; key: string | null; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        key: new Headers(init?.headers).get('x-goog-api-key'),
        body: JSON.parse(String(init?.body ?? 'null')),
      });
      return Response.json({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hola.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      });
    });

    const byok = byokModel(USER_KEY, 'gemini-3.5-flash-lite');
    const { text } = await generateText({
      model: byok.model,
      prompt: 'hola',
      providerOptions: byok.providerOptions,
      maxRetries: 0,
    });

    expect(text).toBe('Hola.');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain('generativelanguage.googleapis.com');
    expect(seen[0]!.key).toBe(USER_KEY);
    expect(seen[0]!.key).not.toBe(OPERATOR_KEY);
    expect(JSON.stringify(seen)).not.toContain(OPERATOR_KEY);
    // And the thinking level reached the request.
    expect(JSON.stringify(seen[0]!.body)).toMatch(/"thinkingLevel":"minimal"/);
  });
});

describe('thinking level', () => {
  it('asks Gemini 3 models for minimal thinking and leaves 2.5 alone', () => {
    expect(supportsThinkingLevel('gemini-3.5-flash-lite')).toBe(true);
    expect(supportsThinkingLevel('gemini-flash-lite-latest')).toBe(true);
    expect(supportsThinkingLevel('gemini-2.5-flash-lite')).toBe(false);
    expect(byokProviderOptions('gemini-3.1-flash-lite')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'minimal' } },
    });
    expect(byokProviderOptions('gemini-2.5-flash-lite')).toBeUndefined();
  });

  it('retries once at most, since each attempt spends the reader’s quota', () => {
    expect(byokModel(USER_KEY, 'gemini-3.5-flash-lite').maxRetries).toBe(1);
  });
});
