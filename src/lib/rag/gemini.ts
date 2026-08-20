import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from '@ai-sdk/google';

/**
 * The Gemini provider, built with an explicitly resolved API key.
 *
 * The AI SDK reads `GOOGLE_GENERATIVE_AI_API_KEY` and nothing else, while
 * Google AI Studio hands out a key it calls `GEMINI_API_KEY`. Documenting that
 * both work is only true if something actually resolves them, so the provider
 * is constructed here rather than using the default export — otherwise a key
 * set under the AI Studio name produces `AI_LoadAPIKeyError` at request time,
 * on a server that started up perfectly happily.
 */

let cached: GoogleGenerativeAIProvider | null = null;

export function resolveApiKey(): string | undefined {
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY || undefined;
}

export function gemini(): GoogleGenerativeAIProvider {
  if (cached) return cached;

  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      'No Gemini API key. Set GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) in .env.local.',
    );
  }

  cached = createGoogleGenerativeAI({ apiKey });
  return cached;
}

/** Test-only: forget the memoised provider so an env change takes effect. */
export function resetGeminiProvider(): void {
  cached = null;
}
