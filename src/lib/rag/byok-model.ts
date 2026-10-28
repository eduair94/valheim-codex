import 'server-only';

import { createGoogle, type GoogleLanguageModelOptions } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { isByokModel, isPlausibleApiKey, type ByokModel } from '@/lib/auth/byok';

/**
 * The model for a reader who brought their own Gemini key.
 *
 * Built per request from the key in their cookie, used for that request's
 * rewrite and answer, and nothing else: no operator candidate is ever tried
 * behind it, and its failures never reach the shared circuit breaker, where
 * one reader's revoked key would demote the operator's Gemini for everyone.
 *
 * The guard on the key is the important line. `createGoogle({ apiKey:
 * undefined })` does not fail — it quietly reads GOOGLE_GENERATIVE_AI_API_KEY
 * from the environment, which is the operator's key. A cookie that failed to
 * decrypt, a refactor that passed the wrong field, and the reader's question
 * would be answered on the operator's bill with nothing in the logs. So a
 * missing key is an exception here, before any provider exists.
 */

export class ByokKeyMissingError extends Error {
  constructor() {
    super('No usable Gemini key for this request; refusing to build a model that would fall back to the operator key.');
    this.name = 'ByokKeyMissingError';
  }
}

export class ByokModelNotAllowedError extends Error {
  constructor(model: unknown) {
    super(`Model ${JSON.stringify(model)} is not offered for readers' own keys.`);
    this.name = 'ByokModelNotAllowedError';
  }
}

export type ByokAnswerModel = {
  /** For logs only; never sent anywhere. */
  name: string;
  model: LanguageModel;
  providerOptions: { google: GoogleLanguageModelOptions } | undefined;
  /** One retry: the reader's quota pays for each attempt. */
  maxRetries: number;
};

/**
 * Gemini 3 models take a thinking level; `minimal` keeps a grounded answer
 * from spending seconds deliberating over excerpts it only has to read. The
 * 2.5 line has no levels (its Flash-Lite does not think by default) and
 * rejects the field.
 */
export function supportsThinkingLevel(model: ByokModel): boolean {
  return !/^gemini-2(?:[.-]|$)/.test(model);
}

export function byokProviderOptions(model: ByokModel): ByokAnswerModel['providerOptions'] {
  if (!supportsThinkingLevel(model)) return undefined;
  return { google: { thinkingConfig: { thinkingLevel: 'minimal' } } satisfies GoogleLanguageModelOptions };
}

export function byokModel(apiKey: unknown, model: unknown): ByokAnswerModel {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!isPlausibleApiKey(key)) throw new ByokKeyMissingError();
  if (!isByokModel(model)) throw new ByokModelNotAllowedError(model);

  const google = createGoogle({ apiKey: key });
  return {
    name: `byok/${model}`,
    model: google(model),
    providerOptions: byokProviderOptions(model),
    maxRetries: 1,
  };
}
