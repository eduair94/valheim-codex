import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';
import { gemini, resolveApiKey as resolveGeminiKey } from './gemini';
import {
  ANSWER_MODEL,
  GROK_ANSWER_MODEL,
  GROK_REWRITE_MODEL,
  OPENROUTER_ANSWER_MODEL,
  OPENROUTER_REWRITE_MODEL,
  REWRITE_MODEL,
} from './models';

/**
 * The ordered list of models to try for one call.
 *
 * Grok first, Gemini behind it. Two providers rather than one because the
 * failure this app actually hits is a rate limit, not a bug: Gemini's free tier
 * allows 20 generate_content requests a minute, and the answer path spends two
 * of them per question. A second provider turns "the app is broken for the next
 * minute" into a slower answer nobody notices.
 *
 * Order is preference, not fallback-only — Grok serves every request it can,
 * and Gemini exists for when it cannot. A provider with no key configured is
 * left out of the list entirely rather than tried and failed, so a deployment
 * with one key behaves exactly as it did before this existed.
 */

export type Candidate = {
  /** Provider and model, for logs and for the `x-answered-by` header. */
  readonly name: string;
  readonly model: LanguageModel;
};

let cachedXai: ReturnType<typeof createXai> | null = null;
let cachedOpenRouter: ReturnType<typeof createOpenRouter> | null = null;

function xai(): ReturnType<typeof createXai> | null {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;
  cachedXai ??= createXai({ apiKey });
  return cachedXai;
}

function openrouter(): ReturnType<typeof createOpenRouter> | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  cachedOpenRouter ??= createOpenRouter({ apiKey });
  return cachedOpenRouter;
}

function candidates(grokModel: string, geminiModel: string, openRouterModel: string): Candidate[] {
  const list: Candidate[] = [];

  const x = xai();
  if (x) list.push({ name: `xai/${grokModel}`, model: x(grokModel) });

  if (resolveGeminiKey()) list.push({ name: `google/${geminiModel}`, model: gemini()(geminiModel) });

  const or = openrouter();
  if (or) list.push({ name: `openrouter/${openRouterModel}`, model: or(openRouterModel) });

  if (list.length === 0) {
    throw new Error(
      'No model provider configured. Set XAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY or ' +
        'OPENROUTER_API_KEY in the environment.',
    );
  }
  return list;
}

/** Models that generate the grounded answer, best first. */
export function answerCandidates(): Candidate[] {
  return candidates(GROK_ANSWER_MODEL, ANSWER_MODEL, OPENROUTER_ANSWER_MODEL);
}

/** Models that rewrite a question into search queries, best first. */
export function rewriteCandidates(): Candidate[] {
  return candidates(GROK_REWRITE_MODEL, REWRITE_MODEL, OPENROUTER_REWRITE_MODEL);
}

/** Test-only: forget the memoised provider so an env change takes effect. */
export function resetProviders(): void {
  cachedXai = null;
  cachedOpenRouter = null;
}
