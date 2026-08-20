import { generateObject } from 'ai';
import { z } from 'zod';

import { gemini } from './gemini';
import { REWRITE_MODEL } from './models';

const rewriteSchema = z.object({
  queries: z
    .array(z.string().min(1))
    .min(1)
    .max(3)
    .describe('Between one and three English search queries.'),
});

export type RewriteInput = {
  question: string;
  /** Recent turns, oldest first, used to resolve pronouns and ellipsis. */
  history?: { role: 'user' | 'assistant'; text: string }[];
};

const SYSTEM = `You turn a player's question about the game Valheim into search queries for an English wiki index.

Rules:
- Always answer with English queries, whatever language the question is in.
- Use the exact in-game English names (Yagluth, Surtling core, Deathsquito, Blackmetal, Fenris).
- Resolve pronouns and ellipsis from the conversation. "and its damage?" after a question about the Iron Sword becomes "Iron Sword damage stats".
- Produce one query for a simple question. Produce two or three only when the question genuinely covers separate topics, or when a synonym is likely to matter.
- Queries are keyword-style, not sentences. No punctuation, no question marks.`;

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
 * so any error falls back to searching the question verbatim.
 */
export async function rewriteQueries(input: RewriteInput): Promise<string[]> {
  const question = input.question.trim();
  if (!question) return [];

  const history = (input.history ?? [])
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'Player' : 'Assistant'}: ${m.text.slice(0, 500)}`)
    .join('\n');

  try {
    const { object } = await generateObject({
      model: gemini()(REWRITE_MODEL),
      schema: rewriteSchema,
      system: SYSTEM,
      prompt: history
        ? `Conversation so far:\n${history}\n\nNew question: ${question}`
        : `Question: ${question}`,
      // Rewriting is a mechanical transformation; sampling adds nothing.
      temperature: 0,
    });

    const queries = object.queries.map((q) => q.trim()).filter(Boolean);
    return queries.length > 0 ? queries : fallback(question);
  } catch (error) {
    /*
     * Never silent. A failing rewrite still answers the question, but it
     * answers it badly: the index is English, so a Spanish question that is
     * not rewritten retrieves almost nothing useful. Swallowing this without
     * a word once hid a completely broken model id behind merely mediocre
     * answers.
     */
    console.error(
      `[rewrite] falling back to the raw question — retrieval quality will suffer. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return fallback(question);
  }
}
