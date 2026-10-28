import type { Strings } from '@/lib/i18n/strings';
import { PUTER_MODEL_KEY, readStored, writeStored, type StorageLike } from './storage';

/**
 * The models a reader can pick, and what to call them.
 *
 * Gemini models for a reader's own key come from the server
 * (`/api/auth/session` → `byokModels`), which decides what it will run. Puter
 * models are chosen here, because the model runs in the reader's browser and
 * is billed to their Puter account: Flash-Lite first (the cheapest that
 * answers well from excerpts, about $0.0008 an answer), a newer Flash-Lite,
 * and Puter's own default.
 */
export const PUTER_MODELS = ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gpt-5.4-nano'] as const;
export type PuterModel = (typeof PUTER_MODELS)[number];
export const DEFAULT_PUTER_MODEL: PuterModel = 'gemini-2.5-flash-lite';

export function isPuterModel(value: unknown): value is PuterModel {
  return typeof value === 'string' && (PUTER_MODELS as readonly string[]).includes(value);
}

/** The Puter model this browser chose last, or the default. */
export function readPuterModel(storage?: StorageLike | null): PuterModel {
  const stored = readStored(PUTER_MODEL_KEY, storage);
  return isPuterModel(stored) ? stored : DEFAULT_PUTER_MODEL;
}

export function rememberPuterModel(model: PuterModel, storage?: StorageLike | null): void {
  writeStored(PUTER_MODEL_KEY, model, storage);
}

/** Proper names, the same in every language. */
const NAMES: Record<string, string> = {
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
  'gpt-5.4-nano': 'GPT-5.4 nano',
};

/**
 * "Gemini 3.5 Flash-Lite", and for the moving alias a word instead of a
 * version. An id this list does not know is shown as it is: a name the
 * reader can look up beats a guess at prettifying it.
 *
 * Names only, short enough for a closed menu on a phone; what sets a model
 * apart goes in `modelHint`.
 */
export function modelName(id: string, t: Strings): string {
  if (id === 'gemini-flash-lite-latest') return t.chatModelLatestFlashLite;
  return NAMES[id] ?? id;
}

/**
 * A line under a model menu about the model chosen in it, or null: that it
 * is the recommended one, that the moving alias follows Google's newest
 * Flash-Lite, and, for a reader's own Gemini key, that Google only serves
 * Gemini 2.5 to keys that used it before. (Puter serves it to everyone.)
 *
 * Under the menu, not in its options: a qualifier in the option's text was
 * cut off mid-word in the closed menu on a phone ("Gemini 3.5 Flash-Lite ·
 * recomendad").
 */
export function modelHint(id: string, t: Strings, options: { defaultModel: string; ownKey: boolean }): string | null {
  if (id === options.defaultModel) return t.chatModelHintRecommended;
  if (id === 'gemini-flash-lite-latest') return t.chatModelHintLatest;
  if (options.ownKey && id === 'gemini-2.5-flash-lite') return t.chatModelHintLegacyKeys;
  return null;
}
