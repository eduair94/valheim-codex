import type { Citation } from '@/lib/db/schema';
import type { ScoredChunk } from './retrieve';

export type Lang = 'es' | 'en';

const LANGUAGE_RULE: Record<Lang, string> = {
  es: 'Responde SIEMPRE en español, aunque los fragmentos estén en inglés. Mantén los nombres propios del juego en inglés (Yagluth, Surtling core, Deathsquito) porque así aparecen dentro del juego, y añade la traducción entre paréntesis la primera vez si ayuda.',
  en: 'Always answer in English.',
};

/**
 * System prompt for the answering call.
 *
 * The grounding rules are stated as prohibitions rather than preferences
 * because a wiki assistant that quietly fills gaps from the model's own
 * knowledge of Valheim is worse than one that says it does not know: the
 * player cannot tell the two apart, and patch-specific numbers are exactly
 * where the model's memory is least reliable.
 */
export function buildSystemPrompt(lang: Lang): string {
  return `You are a Valheim wiki assistant. You answer strictly from the wiki excerpts provided in the user message.

${LANGUAGE_RULE[lang]}

Grounding rules:
- Use ONLY the numbered excerpts. Never use your own knowledge of Valheim to add, correct or complete a fact.
- Cite every factual claim with its excerpt number in square brackets, like [1] or [2][3]. Put the citation right after the claim.
- When a whole list comes from the same excerpts, cite once after the line that introduces it, not on every bullet. Repeating the same markers down a list is noise.
- Cite the most specific excerpt that supports the claim. If two say the same thing, cite one.
- If the excerpts do not contain the answer, say so plainly and state what is missing. Do not guess. Do not offer a "probably".
- If the excerpts disagree, say so and cite both.
- Never invent numbers. Quantities, damage values and crafting costs must appear verbatim in an excerpt.

Style:
- Answer the question first, in one or two sentences. Details after.
- Use a short bullet list for crafting materials or stat breakdowns.
- Do not mention "excerpts", "context" or "the wiki says" — just answer and cite.
- Keep it concise. No preamble, no closing offer of further help.`;
}

/**
 * Renders retrieved chunks as a numbered block, and the matching citation
 * records. The numbering is the contract the model cites against, so the two
 * are produced together and must not be reordered independently.
 */
export function buildContext(chunks: ScoredChunk[]): { context: string; citations: Citation[] } {
  const citations: Citation[] = [];
  const blocks: string[] = [];

  chunks.forEach((chunk, i) => {
    const n = i + 1;
    citations.push({
      n,
      title: chunk.title,
      url: chunk.url,
      sectionPath: chunk.sectionPath,
      source: chunk.source,
      score: Number(chunk.score.toFixed(6)),
      slug: chunk.slug,
    });
    const heading = [chunk.title, chunk.sectionPath].filter(Boolean).join(' › ');
    blocks.push(`[${n}] ${heading}\n${chunk.content}`);
  });

  return { context: blocks.join('\n\n---\n\n'), citations };
}

/** The user-facing turn: the question plus its grounding block. */
export function buildUserPrompt(question: string, context: string): string {
  if (!context) return question;
  return `Wiki excerpts:\n\n${context}\n\n---\n\nQuestion: ${question}`;
}

const NO_CONTEXT: Record<Lang, string> = {
  es: 'No encontré nada sobre eso en la wiki de Valheim. Probá con el nombre en inglés del objeto o criatura (por ejemplo "Surtling core" en vez de "núcleo de surtling"), o reformulá la pregunta.',
  en: 'I could not find anything about that in the Valheim wiki. Try the exact in-game name, or rephrase the question.',
};

/** Reply used when retrieval comes back empty, so no model call is made. */
export function noContextAnswer(lang: Lang): string {
  return NO_CONTEXT[lang];
}
