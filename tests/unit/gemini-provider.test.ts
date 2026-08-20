import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetGeminiProvider, resolveApiKey } from '@/lib/rag/gemini';

const ORIGINAL = {
  google: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
};

beforeEach(() => {
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  resetGeminiProvider();
});

afterEach(() => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = ORIGINAL.google;
  process.env.GEMINI_API_KEY = ORIGINAL.gemini;
  resetGeminiProvider();
});

describe('resolveApiKey', () => {
  it('accepts the SDK variable name', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'from-sdk-name';
    expect(resolveApiKey()).toBe('from-sdk-name');
  });

  it('accepts the name AI Studio hands out', () => {
    // Without this the app starts fine and then fails at the first question
    // with AI_LoadAPIKeyError, despite a perfectly valid key being configured.
    process.env.GEMINI_API_KEY = 'from-ai-studio';
    expect(resolveApiKey()).toBe('from-ai-studio');
  });

  it('prefers the SDK variable when both are set', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'explicit';
    process.env.GEMINI_API_KEY = 'fallback';
    expect(resolveApiKey()).toBe('explicit');
  });

  it('ignores an empty value rather than passing it through', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
    process.env.GEMINI_API_KEY = 'real';
    expect(resolveApiKey()).toBe('real');
  });

  it('returns undefined when neither is set', () => {
    expect(resolveApiKey()).toBeUndefined();
  });
});

describe('gemini()', () => {
  it('fails with an actionable message when no key is configured', async () => {
    const { gemini } = await import('@/lib/rag/gemini');
    expect(() => gemini()).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY.*GEMINI_API_KEY/s);
  });

  it('builds a provider when a key is present', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const { gemini } = await import('@/lib/rag/gemini');
    expect(typeof gemini()).toBe('function');
  });
});
