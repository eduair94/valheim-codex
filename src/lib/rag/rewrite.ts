import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';

import { clampText } from '@/lib/chat-server/text';
import { describeError, logWarn } from '@/lib/log';
import { withFallback } from './fallback';
import { REWRITE_ATTEMPT_TIMEOUT_MS, REWRITE_TOTAL_TIMEOUT_MS } from './models';
import { rewriteCandidates, type Candidate } from './provider';

/*
 * No upper bound on the array. One query per thing asked about can mean four
 * for "¿qué hago con cobre, estaño, hierro y plata?", and a schema that
 * refused a fourth would fail the whole rewrite and fall back to the raw
 * question. The first MAX_QUERIES are kept instead; the instructions still
 * ask for no more.
 */
const rewriteSchema = z.object({
  queries: z.array(z.string().min(1)).min(1).describe('Between one and three English search queries.'),
});

/** Queries searched per question. Each is a vector search and a full-text search of its own. */
const MAX_QUERIES = 3;

type ProviderOptions = Parameters<typeof generateText>[0]['providerOptions'];

/**
 * One specific model instead of the operator's chain.
 *
 * This is how a reader's own Gemini key rewrites its own questions: one
 * attempt on that model, never the operator's candidates, never the shared
 * circuit breaker. Without it, a guest's question would spend the operator's
 * keys on the rewrite even though the answer runs on the guest's.
 */
export type RewriteModel = {
  name: string;
  model: LanguageModel;
  providerOptions?: ProviderOptions;
  maxRetries?: number;
  /**
   * Failures that end the request rather than degrading it — for a reader's
   * key, the key itself being refused or out of quota. The answer call that
   * follows would fail the same way, after spending another of the reader's
   * requests on it.
   */
  isFatal?: (error: unknown) => boolean;
};

export type RewriteInput = {
  question: string;
  /** Recent turns, oldest first, used to resolve pronouns and ellipsis. */
  history?: { role: 'user' | 'assistant'; text: string }[];
  /**
   * The reader leaving. Aborting it stops the rewrite and rethrows, instead
   * of quietly degrading to the raw question for an answer nobody will read.
   */
  abortSignal?: AbortSignal;
  /**
   * The one model to rewrite with. Left out, the operator's chain answers and
   * the operator pays, so only operator-paid callers leave it out: the chat,
   * through an exhaustive switch on who pays (chat-server/answer.ts), and the
   * operator's own eval script.
   */
  model?: RewriteModel;
  /** Deadlines, overridable for tests. */
  attemptTimeoutMs?: number;
  totalTimeoutMs?: number;
};

/**
 * What the rewrite model is told, exported so a test can read it.
 *
 * The words added after each name were measured on a copy of the corpus.
 * Full-text search ORs a query's terms, so a word found everywhere fills the
 * eight excerpts with other articles. "usage" is in 1,292 of 5,856 chunks,
 * 860 of them infoboxes (851 of the 1,318 infobox chunks print "Usage:"):
 * "X usage" brought in 2.00 other articles' Usage sections per answer and
 * lost Resin's own, while "X used for" found an item's Usage section as often
 * (212 against 210 of 219) and brought in 1.24. "crafting" is in 1,332: "Tin
 * crafting recipes" and "Bronze crafting recipes" filled five of eight
 * excerpts with the Crafting list pages. "recipe", "how to obtain",
 * "spawning" and "stats" each found the right section more often than the
 * word they replace. One query per thing found both items' Usage sections for
 * 46 of 60 pairs, against 35 for one query naming both. "Black metal" is how
 * the wiki writes it; "Blackmetal" is in 12 chunks and no title.
 *
 * No example asks about a thing an eval set asks about, so the eval still
 * measures how the rules carry over to new questions, not whether the model
 * remembers the examples. The German example's query does what it shows:
 * "Leather scraps used for" puts the Leather Scraps Usage section first.
 */
export const REWRITE_INSTRUCTIONS = `You turn a player's question about the game Valheim into search queries for an English wiki index.

Rules:
- Always answer with English queries, whatever language the question is in.
- Use the exact in-game English names (Yagluth, Surtling core, Deathsquito, Black metal, Fenris).
- Resolve pronouns and ellipsis from the conversation. "and its damage?" after a question about the Iron Sword becomes "Iron Sword stats".
- After each name, add the words for what is asked:
  what you can make or build with X, what X is for: "X used for"
  how to make or build X, what X costs: "X recipe" (never "crafting")
  how to get or find an item X: "X how to obtain"
  where a creature X lives: "X spawning"
  damage, armor, health: "X stats"
  anything else: the name and the question's key words
- When the question asks about several things, write one query per thing. A name of several words is one thing ("Mead ketill"): never split it.
- Otherwise one query; a second or third only for a separate topic. Never more than three.
- Queries are keyword-style, not sentences. No punctuation, no question marks.

Examples:
¿Qué puedo hacer con pedernal y piedra? → ["Flint used for", "Stone used for"]
¿Dónde consigo ojos de enano gris? → ["Greydwarf eye how to obtain"]
How do I make a bronze axe? → ["Bronze axe recipe"]
Was kann ich mit Lederresten bauen? → ["Leather scraps used for"]
What is a Seeker? → ["Seeker"]`;

/** Fallback when the model is unavailable: search the raw question. */
function fallback(question: string): string[] {
  return [question.trim()].filter(Boolean);
}

/**
 * Rewrites a question into English wiki search queries.
 *
 * This one cheap call is what makes both bilingual support and follow-up
 * questions work: the index holds English text, and "¿y cuánto daño hace?"
 * carries no searchable content until the previous turn is folded into it.
 * A failure here degrades retrieval quality but must never fail the request,
 * so any error — a refusal, a stall past the deadline, every provider out of
 * quota — falls back to searching the question verbatim. The one exception is
 * the reader leaving, which is passed on so the request can stop.
 */
export async function rewriteQueries(input: RewriteInput): Promise<string[]> {
  const question = input.question.trim();
  if (!question) return [];

  const history = (input.history ?? [])
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'Player' : 'Assistant'}: ${clampText(m.text, 500)}`)
    .join('\n');

  const deadline = AbortSignal.timeout(input.totalTimeoutMs ?? REWRITE_TOTAL_TIMEOUT_MS);
  const signal = input.abortSignal ? AbortSignal.any([input.abortSignal, deadline]) : deadline;
  const override = input.model;
  const list: Candidate[] = override ? [{ name: override.name, model: override.model }] : rewriteCandidates();

  try {
    const { value: object } = await withFallback(
      list,
      (candidate, attempt) =>
        generateText({
          model: candidate.model,
          maxRetries: override?.maxRetries ?? attempt.maxRetries,
          abortSignal: attempt.abortSignal,
          output: Output.object({ schema: rewriteSchema }),
          instructions: REWRITE_INSTRUCTIONS,
          prompt: history
            ? `Conversation so far:\n${history}\n\nNew question: ${question}`
            : `Question: ${question}`,
          // Rewriting is a mechanical transformation; sampling adds nothing.
          temperature: 0,
          providerOptions: override?.providerOptions,
        }).then((r) => r.output),
      {
        signal,
        timeoutMs: input.attemptTimeoutMs ?? REWRITE_ATTEMPT_TIMEOUT_MS,
        circuit: !override,
      },
    );

    const queries = object.queries.map((q) => q.trim()).filter(Boolean).slice(0, MAX_QUERIES);
    return queries.length > 0 ? queries : fallback(question);
  } catch (error) {
    if (input.abortSignal?.aborted) throw input.abortSignal.reason ?? error;
    if (override?.isFatal?.(error)) throw error;

    /*
     * Never silent. A failing rewrite still answers the question, but it
     * answers it badly: the index is English, so a Spanish question that is
     * not rewritten retrieves almost nothing useful. Swallowing this without
     * a word once hid a completely broken model id behind merely mediocre
     * answers.
     */
    logWarn('rewrite', 'falling back to the raw question — retrieval quality will suffer', {
      error: describeError(error).message,
      deadline: deadline.aborted,
    });
    return fallback(question);
  }
}

/**
 * Queries for a turn whose model runs in the reader's browser (Puter), where
 * the server has no model to rewrite with.
 *
 * The question itself, plus — when there is a conversation — the previous
 * question folded in front of it, which is what resolves "¿y dónde está?" to
 * the thing the reader was asking about. `retrieve` adds the glossary's
 * English form of any Spanish game term on top of both.
 */
export function deterministicQueries(
  question: string,
  history: { role: 'user' | 'assistant'; text: string }[] = [],
): string[] {
  const asked = question.trim();
  if (!asked) return [];
  const previous = [...history].reverse().find((turn) => turn.role === 'user')?.text.trim();
  return previous ? [asked, `${clampText(previous, 500)} ${asked}`] : [asked];
}
