import { z } from 'zod';
import { generateObject } from 'ai';
import { withFallback } from '@/lib/rag/fallback';
import { rewriteCandidates } from '@/lib/rag/provider';
import type { ArticleBlock, ArticleDoc, ArticleInfobox } from './article-types';

/**
 * Translates an article by translating its strings, never its structure.
 *
 * The obvious approach — hand the model the document and ask for the document
 * back in Spanish — puts the shape of the page in the model's hands. A dropped
 * table row or a renamed field is then indistinguishable from a translation
 * choice, and the failure is silent: the page still renders, just with less in
 * it than the wiki had.
 *
 * So the document is flattened to a list of strings, the list is translated as
 * a list, and the results are put back where they came from. The model cannot
 * lose a row because it never sees rows, and a reply with the wrong number of
 * entries is rejected outright rather than merged hopefully.
 *
 * What is deliberately never sent: bare numbers, IDs, URLs, image data and
 * facets. A crafting cost that comes back as "veinte" is worse than one left
 * in English, and a stat that comes back subtly different is worse than both.
 */

/** Strings that carry no language and everything to lose: 20, 1.5s, 35%, SwordIron. */
const VERBATIM = /^[\s\d.,:%x/+-]*$|^[A-Za-z]*\d[\w.-]*$/;

export type TranslatableSlot =
  | { kind: 'title' }
  | { kind: 'lead' }
  | { kind: 'block'; index: number; field: 'section' | 'caption' | 'text' }
  | { kind: 'block-item'; index: number; item: number }
  | { kind: 'block-header'; index: number; cell: number }
  | { kind: 'block-cell'; index: number; row: number; cell: number }
  | { kind: 'infobox-group'; group: number; tab: number | null }
  | { kind: 'infobox-label'; group: number; row: number; tab: number | null }
  | { kind: 'infobox-value'; group: number; row: number; tab: number | null };

export type Extraction = { slots: TranslatableSlot[]; strings: string[] };

/**
 * Infobox labels whose value is an identifier rather than prose.
 *
 * Detecting these from the value alone does not work: `SwordIron` is the game's
 * internal name for the iron sword and reads exactly like two English words, so
 * any shape-based rule either translates it or starts refusing real prose. The
 * label says what the row is, which is the information the value lacks.
 */
const IDENTIFIER_LABELS = /^(internal id|id|item id|code|prefab|prefab name|token)$/i;

/** True when a row's value is an identifier and must survive untouched. */
export function isIdentifierRow(label: string): boolean {
  return IDENTIFIER_LABELS.test(label.trim());
}

export function worthTranslating(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return !VERBATIM.test(trimmed);
}

/**
 * Flattens every translatable string in an article, in a stable order.
 *
 * The title is passed alongside the document rather than read from it: it
 * lives on the `articles` row, not in the parsed body, and it still needs
 * translating.
 */
export function extractStrings(doc: ArticleDoc, title: string): Extraction {
  const slots: TranslatableSlot[] = [];
  const strings: string[] = [];

  const push = (slot: TranslatableSlot, value: string): void => {
    if (!worthTranslating(value)) return;
    slots.push(slot);
    strings.push(value);
  };

  push({ kind: 'title' }, title);
  push({ kind: 'lead' }, doc.lead);

  doc.blocks.forEach((block, index) => {
    push({ kind: 'block', index, field: 'section' }, block.section);

    if (block.kind === 'paragraph') {
      push({ kind: 'block', index, field: 'text' }, block.text);
      return;
    }
    if (block.kind === 'list') {
      block.items.forEach((item, i) => push({ kind: 'block-item', index, item: i }, item));
      return;
    }
    push({ kind: 'block', index, field: 'caption' }, block.caption);
    block.headers.forEach((cell, i) => push({ kind: 'block-header', index, cell: i }, cell));
    block.rows.forEach((row, r) =>
      row.forEach((cell, c) => push({ kind: 'block-cell', index, row: r, cell: c }, cell)),
    );
  });

  const infobox = doc.infobox;
  if (infobox) {
    const groups = (list: ArticleInfobox['common'], tab: number | null): void => {
      list.forEach((group, g) => {
        push({ kind: 'infobox-group', group: g, tab }, group.label);
        group.rows.forEach((row, r) => {
          push({ kind: 'infobox-label', group: g, row: r, tab }, row.label);
          // The label is translated; an identifier's value never is.
          if (!isIdentifierRow(row.label)) {
            push({ kind: 'infobox-value', group: g, row: r, tab }, row.value);
          }
        });
      });
    };
    groups(infobox.common, null);
    infobox.tabs.forEach((tab, t) => groups(tab.groups, t));
  }

  return { slots, strings };
}

/** Puts translated strings back where they came from, leaving the shape alone. */
export function applyStrings(
  doc: ArticleDoc,
  title: string,
  extraction: Extraction,
  translated: string[],
): { doc: ArticleDoc; title: string } {
  // Cloned rather than mutated: a half-applied translation on the cached
  // English document would poison every later reader of that object.
  const out: ArticleDoc = structuredClone(doc);
  let outTitle = title;

  extraction.slots.forEach((slot, i) => {
    const value = translated[i];
    if (value === undefined || value.trim() === '') return;

    switch (slot.kind) {
      case 'title':
        outTitle = value;
        return;
      case 'lead':
        out.lead = value;
        return;
      case 'block': {
        const block = out.blocks[slot.index] as ArticleBlock | undefined;
        if (!block) return;
        if (slot.field === 'section') block.section = value;
        else if (slot.field === 'text' && block.kind === 'paragraph') block.text = value;
        else if (slot.field === 'caption' && block.kind === 'table') block.caption = value;
        return;
      }
      case 'block-item': {
        const block = out.blocks[slot.index];
        if (block?.kind === 'list') block.items[slot.item] = value;
        return;
      }
      case 'block-header': {
        const block = out.blocks[slot.index];
        if (block?.kind === 'table') block.headers[slot.cell] = value;
        return;
      }
      case 'block-cell': {
        const block = out.blocks[slot.index];
        const row = block?.kind === 'table' ? block.rows[slot.row] : undefined;
        if (row) row[slot.cell] = value;
        return;
      }
      default: {
        if (!out.infobox) return;
        const groups = slot.tab === null ? out.infobox.common : out.infobox.tabs[slot.tab]?.groups;
        const group = groups?.[slot.group];
        if (!group) return;
        if (slot.kind === 'infobox-group') {
          group.label = value;
          return;
        }
        const row = group.rows[slot.row];
        if (!row) return;
        if (slot.kind === 'infobox-label') row.label = value;
        else row.value = value;
      }
    }
  });

  return { doc: out, title: outTitle };
}

const SYSTEM = [
  'You translate Valheim wiki text from English into the target language.',
  '',
  'You are given a numbered list of strings from one article. Return the same',
  'number of translations, in the same order.',
  '',
  'Rules:',
  '- Translate every string. Never merge, split, reorder or drop one.',
  '- Translate the names of items, creatures, biomes, bosses, resources and',
  '  stations, and put the English in parentheses the FIRST time each one',
  '  appears in this article; use the Spanish alone after that. A reader needs',
  '  the Spanish to read the sentence and the English to find the thing on the',
  '  original wiki or in a game running in English.',
  '    "Iron Sword" -> "Espada de hierro (Iron Sword)", then "Espada de hierro"',
  '    "Black Forest" -> "Bosque negro (Black Forest)"',
  '- Field labels are not names: translate them plainly, with no English.',
  '    "Crafting Materials" -> "Materiales de fabricación"',
  '- Never change a number, a unit, a percentage or an ID. A string that is',
  '  only a value comes back exactly as given.',
  '- Keep the register plain and instructional, the way a wiki reads. Do not',
  '  add, explain or embellish.',
  '- A string already in the target language comes back unchanged.',
].join('\n');

const schema = z.object({
  translations: z.array(z.string()).describe('One translation per input string, in the same order.'),
});

/** Strings per request. */
const BATCH = 40;

export type TranslationResult = { strings: string[]; model: string; failed: number };

/**
 * Translates a list of strings, in batches, through the provider chain.
 *
 * Batched because an article can hold hundreds of strings, and one request for
 * all of them is both slow and easy to truncate. Forty is small enough that a
 * refused batch costs little, and large enough that the instructions are not
 * re-sent for every line.
 *
 * A batch whose reply has the wrong length is rejected and its inputs stay in
 * English. Padding or trimming to fit would shift every later string onto the
 * wrong slot, which reads as a translation quietly saying the wrong thing
 * about the wrong field — the one failure worse than not translating.
 */
export async function translateStrings(strings: string[], lang: string): Promise<TranslationResult> {
  const out: string[] = [];
  let model = '';
  let failed = 0;

  for (let i = 0; i < strings.length; i += BATCH) {
    const batch = strings.slice(i, i + BATCH);
    const numbered = batch.map((s, n) => `${n + 1}. ${s}`).join('\n');

    try {
      const { value, candidate } = await withFallback(rewriteCandidates(), (c, attempt) =>
        generateObject({
          model: c.model,
          maxRetries: attempt.maxRetries,
          schema,
          system: SYSTEM,
          prompt: `Target language: ${lang}\n\nTranslate these ${batch.length} strings:\n\n${numbered}`,
          temperature: 0,
        }).then((r) => r.object),
      );
      model = candidate.name;

      if (value.translations.length === batch.length) {
        out.push(...value.translations);
      } else {
        failed += batch.length;
        console.warn(
          `[translate] asked for ${batch.length} strings, got ${value.translations.length}; keeping English`,
        );
        out.push(...batch);
      }
    } catch (error) {
      failed += batch.length;
      console.warn('[translate] batch failed, keeping English:', error);
      out.push(...batch);
    }
  }

  return { strings: out, model: model || 'none', failed };
}

/** Translates one article end to end. */
export async function translateArticle(
  doc: ArticleDoc,
  title: string,
  lang: string,
): Promise<{ doc: ArticleDoc; title: string; model: string; failed: number }> {
  const extraction = extractStrings(doc, title);
  if (extraction.strings.length === 0) return { doc, title, model: 'none', failed: 0 };

  const { strings, model, failed } = await translateStrings(extraction.strings, lang);
  return { ...applyStrings(doc, title, extraction, strings), model, failed };
}
