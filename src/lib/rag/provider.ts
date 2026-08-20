import { createCerebras } from '@ai-sdk/cerebras';
import { createGroq } from '@ai-sdk/groq';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';
import { isTripped } from './circuit';
import { gemini, resolveApiKey as resolveGeminiKey } from './gemini';
import {
  ANSWER_MODEL,
  GROK_ANSWER_MODEL,
  GROK_REWRITE_MODEL,
  GROQ_ANSWER_MODEL,
  GROQ_REWRITE_MODEL,
  CEREBRAS_ANSWER_MODEL,
  CEREBRAS_REWRITE_MODEL,
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
let cachedGroq: ReturnType<typeof createGroq> | null = null;
let cachedCerebras: ReturnType<typeof createCerebras> | null = null;

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

function groq(): ReturnType<typeof createGroq> | null {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  cachedGroq ??= createGroq({ apiKey });
  return cachedGroq;
}

function cerebras(): ReturnType<typeof createCerebras> | null {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) return null;
  cachedCerebras ??= createCerebras({ apiKey });
  return cachedCerebras;
}

function candidates(
  grokModel: string,
  geminiModel: string,
  groqModel: string,
  cerebrasModel: string,
  openRouterModel: string,
): Candidate[] {
  const list: Candidate[] = [];

  const x = xai();
  if (x) list.push({ name: `xai/${grokModel}`, model: x(grokModel) });

  if (resolveGeminiKey()) list.push({ name: `google/${geminiModel}`, model: gemini()(geminiModel) });

  const g = groq();
  if (g) list.push({ name: `groq/${groqModel}`, model: g(groqModel) });

  const c = cerebras();
  if (c) list.push({ name: `cerebras/${cerebrasModel}`, model: c(cerebrasModel) });

  const or = openrouter();
  if (or) list.push({ name: `openrouter/${openRouterModel}`, model: or(openRouterModel) });

  if (list.length === 0) {
    throw new Error(
      'No model provider configured. Set one of XAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, ' +
        'GROQ_API_KEY, CEREBRAS_API_KEY or OPENROUTER_API_KEY in the environment.',
    );
  }
  return list;
}

/**
 * Moves providers that are currently refusing to the back rather than dropping
 * them.
 *
 * Demoted, not removed, because the cooldown is a guess. If every other
 * provider is also down, a key that was out of credit ten minutes ago is still
 * worth one attempt — better a slow answer than a refusal based on stale
 * information.
 */
function ordered(list: Candidate[]): Candidate[] {
  const live = list.filter((c) => !isTripped(c.name));
  const tripped = list.filter((c) => isTripped(c.name));
  return [...live, ...tripped];
}

/** Models that generate the grounded answer, best first. */
export function answerCandidates(): Candidate[] {
  return ordered(
    candidates(
      GROK_ANSWER_MODEL,
      ANSWER_MODEL,
      GROQ_ANSWER_MODEL,
      CEREBRAS_ANSWER_MODEL,
      OPENROUTER_ANSWER_MODEL,
    ),
  );
}

/** Models that rewrite a question into search queries, best first. */
export function rewriteCandidates(): Candidate[] {
  return ordered(
    candidates(
      GROK_REWRITE_MODEL,
      REWRITE_MODEL,
      GROQ_REWRITE_MODEL,
      CEREBRAS_REWRITE_MODEL,
      OPENROUTER_REWRITE_MODEL,
    ),
  );
}

/** Test-only: forget the memoised provider so an env change takes effect. */
export function resetProviders(): void {
  cachedXai = null;
  cachedOpenRouter = null;
  cachedGroq = null;
  cachedCerebras = null;
}
