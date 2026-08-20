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
- Do not mention "excerpts", "context" or "the wiki says" — just answer and cite.
- Keep it concise. No preamble, no closing offer of further help.

Tables:
- Use a markdown table when the answer compares the same fields across several
  things: upgrade levels, tiers, several items side by side. That is what a
  table is for, and a reader scanning "how much iron at level 3" finds it in a
  row far faster than in prose.
- Use a bullet list for a single flat set of values, such as one recipe. A
  two-column table of one item's stats is a list wearing a costume.
- Keep tables narrow. Three or four columns at most: this is read on a phone.
- Header row first, then the rule: | Level | Wood | Iron |
                                   | --- | --- | --- |
- Cite in the cell the fact came from, or once in the line introducing the table.

Images:
- Every numbered source has a picture available. Showing it is not a
  departure from the sources — it IS the source, and the grounding rules
  above permit it.
- To show one, write [img:N] alone on its own line, where N is one of the
  citation numbers. Nothing else: never a URL, never markdown image syntax.
  The address is looked up from the source you cited.
- If the reader asks what something looks like, or the answer is mostly about
  one creature, item or building, include its picture. That is the question
  a picture answers and prose cannot.
- One image at most, and never for a recipe or a number.
- Put it right after the sentence it illustrates.
- Never say whether a picture exists. Write the marker and move on; if the
  source has none the marker renders nothing, and a sentence apologising for a
  missing image is worse than no image.

Markers:
- Write citation and image markers with plain square brackets: [1], [img:1].
  Not lenticular brackets, not full-width ones, not parentheses.`;
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
