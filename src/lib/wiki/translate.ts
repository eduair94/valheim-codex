import { z } from 'zod';
import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, type LanguageModelUsage } from 'ai';
import { refusalOf, statedWaitMs, statusOf } from '@/lib/rag/circuit';
import { AllProvidersFailedError, isBadReply, ResponseTimeoutError, withFallback } from '@/lib/rag/fallback';
import { rewriteCandidates, type Candidate } from '@/lib/rag/provider';
import { describeError, logWarn } from '@/lib/log';
import type { ArticleBlock, ArticleDoc, ArticleImage, ArticleInfobox } from './article-types';

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
 *
 * Each distinct string is sent once per article. A heading shared by several
 * blocks, a header repeated on every table, a "Yes" in forty cells: one entry
 * each. That is cheaper, and it is the only way the same English reads the
 * same in Spanish. Sent once per block, the prompt's "gloss the first mention"
 * rule made the copies of a heading differ ("Magia elemental (Elemental
 * Magic)", then "Magia elemental"), and the reader rendered the heading twice,
 * because a new heading starts wherever the section text changes.
 *
 * And every translated string is remembered, keyed by its English text — the
 * article's translation memory. A batch that failed costs only its own strings
 * on the next attempt, instead of every batch that had already worked; an
 * article changed by a re-index pays only for the strings that changed; and a
 * long article can be translated over several calls, each picking up where the
 * last one stopped.
 *
 * What keeps failing is counted too, string by string (`FailureLog`). A string
 * no model will translate — too long to write before the timeout, or one that
 * makes every batch it is in come back the wrong length — would otherwise be
 * paid for again on every call that tries to finish the article. The caller
 * decides how many attempts a string is worth to whom.
 *
 * Only an answer counts against a string: a reply that could not be used. A
 * provider that never answered — a server error, an unreachable network, a
 * model that does not exist — says nothing about the text, and the same
 * strings translate fine a minute later. Counted, a short outage was enough to
 * shut an article out of public translation for good (`judgeFailure`).
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
  | { kind: 'infobox-value'; group: number; row: number; tab: number | null }
  | { kind: 'image-caption'; index: number };

export type Extraction = {
  /** Every place a translatable string sits, in document order. */
  slots: TranslatableSlot[];
  /** For each slot, the index of its text in `strings`. */
  refs: number[];
  /**
   * Each distinct text once, in order of first appearance: the list a model —
   * or a person, through the export script — actually translates.
   */
  strings: string[];
};

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

/** The prose of a block that keeps it in `text`, whatever its kind. */
function blockText(block: ArticleBlock): string | undefined {
  const text = (block as { text?: unknown }).text;
  return typeof text === 'string' ? text : undefined;
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
  const refs: number[] = [];
  const strings: string[] = [];
  const seen = new Map<string, number>();

  const push = (slot: TranslatableSlot, value: unknown): void => {
    if (typeof value !== 'string' || !worthTranslating(value)) return;
    let ref = seen.get(value);
    if (ref === undefined) {
      ref = strings.length;
      strings.push(value);
      seen.set(value, ref);
    }
    slots.push(slot);
    refs.push(ref);
  };

  push({ kind: 'title' }, title);
  push({ kind: 'lead' }, doc.lead);

  doc.blocks.forEach((block, index) => {
    push({ kind: 'block', index, field: 'section' }, block.section);

    if (block.kind === 'list') {
      block.items.forEach((item, i) => push({ kind: 'block-item', index, item: i }, item));
      return;
    }
    if (block.kind === 'table') {
      push({ kind: 'block', index, field: 'caption' }, block.caption);
      block.headers.forEach((cell, i) => push({ kind: 'block-header', index, cell: i }, cell));
      block.rows.forEach((row, r) =>
        row.forEach((cell, c) => push({ kind: 'block-cell', index, row: r, cell: c }, cell)),
      );
      return;
    }
    /*
     * A paragraph, or any kind of block added later that carries its prose in
     * `text` (a notice, a quote): translated rather than left in English, and
     * never read as a table, which a block without rows would crash.
     */
    push({ kind: 'block', index, field: 'text' }, blockText(block));
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

  /*
   * Captions last. Since parser version 1 a figure's caption travels with its
   * image instead of being repeated as a paragraph, so it is translated here
   * or not at all. It often repeats a name the text already used, which makes
   * it a later mention: same translation, no second gloss.
   */
  (doc.images ?? []).forEach((image, index) => push({ kind: 'image-caption', index }, image.caption));

  return { slots, refs, strings };
}

const sameText = (a: string, b: string): boolean =>
  a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * `Madera (Wood)` → `Madera`, when the bracket holds the very English the
 * string was translated from; anything else comes back as it is. Brackets may
 * nest: `Yuleklapp (mediano) (Yuleklapp (medium))`.
 */
function withoutGloss(translated: string, english: string): string {
  const text = translated.trim();
  if (!text.endsWith(')')) return translated;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const char = text[i];
    if (char === ')') depth += 1;
    else if (char === '(') {
      depth -= 1;
      if (depth === 0) {
        const name = text.slice(0, i).trim();
        return name && sameText(text.slice(i + 1, -1), english) ? name : translated;
      }
    }
  }
  return translated;
}

/**
 * Puts translated strings back where they came from, leaving the shape alone.
 *
 * `translated` runs parallel to `extraction.strings`. A missing or blank entry
 * leaves that text in English everywhere it appears.
 *
 * A string that occurs more than once was translated once, so its English
 * gloss — `Madera (Wood)`, which the prompt asks for on a name's first
 * mention — is kept on the first occurrence only, and later copies read
 * `Madera`, as the prompt intends. Headings keep it everywhere: every block
 * under one heading has to carry the very same text, or the reader starts the
 * heading again.
 */
export function applyStrings(
  doc: ArticleDoc,
  title: string,
  extraction: Extraction,
  translated: readonly (string | null | undefined)[],
): { doc: ArticleDoc; title: string } {
  // Cloned rather than mutated: a half-applied translation on the cached
  // English document would poison every later reader of that object.
  const out: ArticleDoc = structuredClone(doc);
  let outTitle = title;
  const placed = new Set<number>();

  extraction.slots.forEach((slot, i) => {
    const ref = extraction.refs[i];
    const full = ref === undefined ? undefined : translated[ref];
    if (ref === undefined || typeof full !== 'string' || full.trim() === '') return;

    const heading = slot.kind === 'block' && slot.field === 'section';
    const value = placed.has(ref) && !heading ? withoutGloss(full, extraction.strings[ref] ?? '') : full;
    placed.add(ref);

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
        else if (slot.field === 'text' && blockText(block) !== undefined) (block as { text: string }).text = value;
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
      case 'image-caption': {
        const image = out.images?.[slot.index];
        if (image) image.caption = value;
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

/** The text at `slot` in a document, or undefined where its shape has no such place. */
function readSlot(doc: ArticleDoc, title: string, slot: TranslatableSlot): string | undefined {
  switch (slot.kind) {
    case 'title':
      return title;
    case 'lead':
      return doc.lead;
    case 'block': {
      const block = doc.blocks[slot.index];
      if (!block) return undefined;
      if (slot.field === 'section') return block.section;
      if (slot.field === 'text') return blockText(block);
      return block.kind === 'table' ? block.caption : undefined;
    }
    case 'block-item': {
      const block = doc.blocks[slot.index];
      return block?.kind === 'list' ? block.items[slot.item] : undefined;
    }
    case 'block-header': {
      const block = doc.blocks[slot.index];
      return block?.kind === 'table' ? block.headers[slot.cell] : undefined;
    }
    case 'block-cell': {
      const block = doc.blocks[slot.index];
      return block?.kind === 'table' ? block.rows[slot.row]?.[slot.cell] : undefined;
    }
    case 'image-caption':
      return doc.images?.[slot.index]?.caption;
    default: {
      const groups = slot.tab === null ? doc.infobox?.common : doc.infobox?.tabs[slot.tab]?.groups;
      const group = groups?.[slot.group];
      if (!group) return undefined;
      if (slot.kind === 'infobox-group') return group.label;
      const row = group.rows[slot.row];
      if (!row) return undefined;
      return slot.kind === 'infobox-label' ? row.label : row.value;
    }
  }
}

/** What each English string of one article is translated to. */
export type TranslationMemory = Map<string, string>;

/**
 * How many times each English string of one article came back unusable: a
 * wrong-length reply it was part of, even after halving, a reply that was not
 * the list asked for, or an empty translation. Never a request no provider
 * answered (`judgeFailure`). Only strings still untranslated are kept.
 */
export type FailureLog = Map<string, number>;

/**
 * English function words. Two of them make a text an English sentence rather
 * than a name, a value or a word the two languages share.
 */
const ENGLISH_PROSE =
  /\b(?:the|and|of|is|are|was|to|with|from|for|when|this|that|it|its|be|can|will|on|in|at|by|an|or|you|your|if|not|has|have|which|into|after|before)\b/gi;

function readsAsEnglishProse(text: string): boolean {
  return (text.match(ENGLISH_PROSE) ?? []).length >= 2;
}

/**
 * Recovers the memory of a translation stored before memories were kept, by
 * reading each English string's counterpart from the same place in the
 * translated document.
 *
 * Only sound while the English article is still the one that was translated
 * (the translation is not stale): the pairing is by position, and a re-index
 * that moved a row would pair it with its neighbour's translation. Where a
 * text occurs more than once the first occurrence wins, which is also what
 * merges a heading that was translated two different ways.
 *
 * A stored text identical to its English is not taken as its translation when
 * it is an English sentence — the leftover of a batch that failed, which would
 * otherwise count as done and never be sent again — or a caption: stored
 * translations predate captions, so the reader shows those in English. Any
 * other identical text is kept as it is. Measured on a copy of the corpus in
 * October 2026: of the 26,153 strings in its 851 translations, 1,187 were
 * stored unchanged — "No", "Material", "Total", names such as Hildir, values
 * such as "1.84 s" — and not one was an English sentence. Counting them all as
 * untranslated would have marked 583 of those 851 articles partial.
 */
export function deriveMemory(
  source: { doc: ArticleDoc; title: string },
  translated: { doc: ArticleDoc; title: string },
): TranslationMemory {
  const extraction = extractStrings(source.doc, source.title);
  const memory: TranslationMemory = new Map();
  extraction.slots.forEach((slot, i) => {
    const english = extraction.strings[extraction.refs[i] ?? -1];
    if (english === undefined || memory.has(english)) return;
    const value = readSlot(translated.doc, translated.title, slot);
    if (typeof value !== 'string' || value.trim() === '') return;
    if (value === english && (slot.kind === 'image-caption' || readsAsEnglishProse(english))) return;
    memory.set(english, value);
  });
  return memory;
}

/**
 * The order a long article is filled in: what a reader scans before reading.
 * The title and lead; then every heading, label and table header — the
 * skeleton that makes a half-translated page navigable, all of it in Spanish
 * from the first call; then the infobox's values; then the text.
 */
function slotRank(slot: TranslatableSlot): number {
  switch (slot.kind) {
    case 'title':
    case 'lead':
      return 0;
    case 'block':
      return slot.field === 'text' ? 3 : 1;
    case 'block-header':
    case 'infobox-group':
    case 'infobox-label':
      return 1;
    case 'infobox-value':
      return 2;
    default:
      return 3;
  }
}

export type ArticlePlan = {
  extraction: Extraction;
  /**
   * The strings to send, as indexes into `extraction.strings`: the skeleton
   * first, then the text in document order, and strings that failed before
   * after everything that has not.
   */
  todo: number[];
  /** Strings still in English that have failed `maxFailures` times: left to whoever may still try them. */
  stuck: number[];
};

/** What an article's memory does not cover yet, and in what order to ask for it. No model involved. */
export function planArticle(
  doc: ArticleDoc,
  title: string,
  memory: TranslationMemory | null | undefined,
  failures?: FailureLog | null,
  maxFailures = Number.POSITIVE_INFINITY,
): ArticlePlan {
  const extraction = extractStrings(doc, title);
  const rank = extraction.strings.map(() => Number.POSITIVE_INFINITY);
  extraction.slots.forEach((slot, i) => {
    const ref = extraction.refs[i]!;
    rank[ref] = Math.min(rank[ref]!, slotRank(slot));
  });

  const failed = (i: number): number => failures?.get(extraction.strings[i]!) ?? 0;
  const todo: number[] = [];
  const stuck: number[] = [];
  extraction.strings.forEach((s, i) => {
    if (memory?.has(s)) return;
    (failed(i) >= maxFailures ? stuck : todo).push(i);
  });
  todo.sort((a, b) => Number(failed(a) > 0) - Number(failed(b) > 0) || rank[a]! - rank[b]! || a - b);
  return { extraction, todo, stuck };
}

/** The failure log kept to what still matters: strings the article has and its memory lacks. */
export function pruneFailures(
  failures: FailureLog | null | undefined,
  extraction: Extraction,
  memory: TranslationMemory,
): FailureLog {
  const present = new Set(extraction.strings);
  const kept: FailureLog = new Map();
  for (const [english, count] of failures ?? []) {
    if (count > 0 && present.has(english) && !memory.has(english)) kept.set(english, count);
  }
  return kept;
}

/**
 * The translated captions of a translated document, keyed by image URL: what
 * a stored translation keeps of its images. Null when it has none.
 *
 * Given the English `source`, a caption still identical to the English one is
 * left out: stored, it would outlive a re-index that rewrote the English
 * caption, and the page would show the old English over the new.
 */
export function captionsOf(translated: ArticleDoc, source?: ArticleDoc): Record<string, string> | null {
  const captions: [string, string][] = [];
  (translated.images ?? []).forEach((image, i) => {
    if (typeof image.caption !== 'string' || image.caption.trim() === '') return;
    const english = source?.images?.[i];
    if (english?.url === image.url && english.caption === image.caption) return;
    captions.push([image.url, image.caption]);
  });
  return captions.length > 0 ? Object.fromEntries(captions) : null;
}

/**
 * The article's images with their captions in the reader's language — for a
 * page that shows the English article's images under a translated text.
 * Images without a stored caption keep the English one.
 */
export function overlayCaptions(
  images: readonly ArticleImage[],
  captions: Readonly<Record<string, string>> | null | undefined,
): ArticleImage[] {
  return images.map((image) => {
    const caption = captions?.[image.url];
    return caption && image.caption ? { ...image, caption } : image;
  });
}

export type AppliedMemory = {
  doc: ArticleDoc;
  title: string;
  /** The memory pruned to the strings the article has now. */
  memory: TranslationMemory;
  /** Distinct translatable strings in the article. */
  total: number;
  /** Distinct strings with no translation yet, still in English. */
  pending: number;
};

/** The article with everything its memory knows applied. No model involved. */
export function applyMemory(doc: ArticleDoc, title: string, memory: TranslationMemory): AppliedMemory {
  const extraction = extractStrings(doc, title);
  const kept: TranslationMemory = new Map();
  const values = extraction.strings.map((s) => {
    const translated = memory.get(s);
    if (translated === undefined) return null;
    kept.set(s, translated);
    return translated;
  });
  const pending = values.filter((v) => v === null).length;
  return {
    ...applyStrings(doc, title, extraction, values),
    memory: kept,
    total: extraction.strings.length,
    pending,
  };
}

export type ImportedTranslations =
  | { ok: true; applied: AppliedMemory; failures: FailureLog; added: number; obsolete: number }
  | { ok: false; reason: 'no_translations' }
  | { ok: false; reason: 'count_mismatch'; translations: number; strings: number };

/**
 * Merges translations made outside the provider chain — by a person or an
 * agent, through the export script — into an article's memory.
 *
 * Each translation is paired with the English string it was made from, the
 * entry's own `strings`, and stored under that text. The pairing is checked
 * against the article as it stands now rather than trusted from the file: a
 * string the article no longer has is dropped (`obsolete`), so an article
 * edited since the export keeps the translations that still apply instead of
 * shifting every one of them onto the next field.
 *
 * Lists of different lengths are refused whole. The translator merged or
 * dropped a line somewhere, and there is no telling where. A file without
 * `strings` (written by hand) is paired with the article's current list by
 * position, and so needs the exact count.
 *
 * A string the models kept failing on is cleared from the failure log once a
 * person has translated it: that is what exporting it was for.
 */
export function mergeTranslations(
  article: { doc: ArticleDoc; title: string; memory: TranslationMemory | null; failures?: FailureLog | null },
  entry: { strings?: unknown; translations?: unknown },
): ImportedTranslations {
  const { translations } = entry;
  if (!Array.isArray(translations) || !translations.every((t) => typeof t === 'string')) {
    return { ok: false, reason: 'no_translations' };
  }

  const extraction = extractStrings(article.doc, article.title);
  const current = extraction.strings;
  const english =
    Array.isArray(entry.strings) && entry.strings.every((s) => typeof s === 'string')
      ? (entry.strings as string[])
      : current;
  if (english.length !== translations.length) {
    return { ok: false, reason: 'count_mismatch', translations: translations.length, strings: english.length };
  }

  const present = new Set(current);
  const memory: TranslationMemory = new Map(article.memory ?? []);
  let added = 0;
  let obsolete = 0;
  english.forEach((source, i) => {
    const translated = translations[i] as string;
    if (!present.has(source)) {
      obsolete += 1;
      return;
    }
    if (translated.trim() === '') return;
    memory.set(source, translated);
    added += 1;
  });

  const applied = applyMemory(article.doc, article.title, memory);
  return {
    ok: true,
    applied,
    failures: pruneFailures(article.failures, extraction, applied.memory),
    added,
    obsolete,
  };
}

/**
 * Whether a translation is complete enough to show.
 *
 * At least half of its strings must be in the target language. The page labels
 * a stored translation as machine translation, and that label over an article
 * that is still mostly English is worse than the honest English article. Above
 * the line, most of an article in Spanish beats none of it: the strings that
 * failed stay in English, never wrong, and are completed by a later call.
 *
 * One rule for the reader's endpoint and the bulk script alike. They used to
 * disagree (all-or-nothing against half), so whether a page could be stored
 * depended on who asked for it.
 */
export function isPublishable(total: number, pending: number): boolean {
  return pending * 2 <= total;
}

const INSTRUCTIONS = [
  'You translate Valheim wiki text from English into the target language.',
  '',
  'You are given a numbered list of strings from one article, each written as a',
  'JSON string, so a line break inside a string shows as \\n. Return the same',
  'number of translations, in the same order.',
  '',
  'Rules:',
  '- Translate every string. Never merge, split, reorder or drop one.',
  '- Keep each line break where it is.',
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

/**
 * Characters of English per request, whatever the count. Forty table cells
 * are a short reply; forty entries of a changelog are one too long to write
 * before the provider's deadline, and a reply cut off by the deadline is lost
 * whole.
 */
const BATCH_CHARS = 6_000;

/**
 * Strings per request for strings that failed before. Whatever keeps a batch
 * failing takes as few of its neighbours down with it as possible: at five,
 * one stubborn string costs at most two others their turn after one halving.
 */
const RETRY_BATCH = 5;

/**
 * How many times a batch that came back unusable is halved and retried.
 *
 * A model that merged two lines of forty usually gets twenty right, so one
 * halving recovers most of a bad batch for at most two more requests. Deeper
 * splitting would multiply the requests for a string that fails on its own.
 *
 * A batch too large for a provider's minute is another matter: it is halved
 * until it fits, without using this up. The provider says so at once and the
 * refusal costs no tokens, and stopping at the first halving left the halves
 * that were still too large to meet the same refusal on every later run.
 */
const MAX_SPLITS = 1;

/**
 * Requests in a row that no provider answered — server errors, the network,
 * timeouts, rate limits that outlasted every wait (`judgeFailure`) — before a
 * run stops. Two rather than one, so a single batch some provider chokes on
 * does not end the run before the next batch is tried; past that it is an
 * outage, and every further request only waits to fail the same way.
 *
 * A run that can wait (`noAnswerWaitMs`) counts the second only when it was
 * made after a real wait. Two requests that met one busy minute together —
 * sent at once by two workers, or a batch's half sent seconds after the batch
 * — are that minute's limit met twice, and stopping on them would end a run
 * while the provider was a minute from answering.
 *
 * In a row means across calls too, for a run that hands each of them the
 * same `Silence`: the bulk script asks for an article a round at a time.
 */
const MAX_UNANSWERED = 2;

/**
 * What a run that waits knows of the requests no provider answered: how many
 * in a row (`MAX_UNANSWERED`), whether the last of them was refused for the
 * minute, and the wait it set (`noAnswerWaitMs`).
 *
 * Shared like a pacer, and for the same reason. The bulk script asks for an
 * article a round of requests at a time, a call each, then moves on to the
 * next article, and its stop rule is about requests in a row, not about
 * calls. Counted afresh by every call, the request after a round that ended
 * on one nobody answered went out without the wait, and nothing told that
 * round from an outage: the script dropped the rest of the article for the
 * run.
 *
 * The translator's own bookkeeping: a caller makes one (`createSilence`) and
 * hands it to every call of the run.
 */
export type Silence = {
  /** Requests in a row no provider answered. */
  unanswered: number;
  /** The last of them was refused for the minute, by a provider that is up. */
  rateLimited: boolean;
  /** No request goes out before this instant, on the run's clock (`now`). */
  resumeAt: number;
};

export function createSilence(): Silence {
  return { unanswered: 0, rateLimited: false, resumeAt: Number.NEGATIVE_INFINITY };
}

/**
 * The longest wait the run sits out, after a request no provider answered,
 * whatever a rate limit states: a limit further off than this is an outage
 * for this run's purposes.
 */
const MAX_NO_ANSWER_WAIT_MS = 5 * 60 * 1000;

/**
 * The longest stated rate-limit wait a batch sits out on the same provider
 * (fallback.ts), where the chat sits out twenty seconds at most: a run with
 * no reader waiting on it can afford a provider's whole per-minute window.
 * The provider's deadline, `requestTimeoutMs`, bounds it further.
 */
const RATE_LIMIT_WAIT_MS = 60_000;

/*
 * A batch's output ceiling (`maxReplyTokens`).
 *
 * Measured on the corpus's translation memories in October 2026, 185 batches
 * cut the way `splitBatches` cuts them: the reply asked for, the JSON list of
 * translations, never ran past one and a half characters per character of
 * English plus forty per string. The longest was "flax", forty strings and
 * 1,712 characters of English, with a reply of 2,178. Spanish runs about a
 * sixth longer than English, and the English kept in brackets after a name
 * adds the rest. Three characters a token is fewer than these models' own
 * tokenizers need for Spanish, so the bound errs long.
 *
 * Reasoning comes out of the same budget, before the reply's first word, and
 * no response reports it. Going by time instead: Groq took up to six or seven
 * seconds over a batch of forty in the production run of 2026-10-28, which at
 * the four to five hundred tokens a second it writes is some two thousand
 * tokens of gpt-oss reasoning ahead of a reply of seven hundred. The allowance
 * is half as much again.
 *
 * And never more than 8,192 tokens, however long the batch: an eighth of the
 * 65,536 a request with no ceiling is priced at, and half of what OpenRouter
 * could afford when it refused them. A reply cut off by the ceiling comes
 * back unusable, and its batch is halved like any other.
 */
const REPLY_CHARS_PER_CHAR = 1.5;
const REPLY_CHARS_PER_STRING = 40;
const REPLY_CHARS_PER_TOKEN = 3;
const REASONING_TOKENS = 3_072;
const MAX_REPLY_TOKENS = 8_192;

/** The output ceiling for one batch: room for its reply, and for the reasoning before it. */
export function maxReplyTokens(batch: readonly string[]): number {
  const chars = batch.reduce((n, text) => n + text.length, 0);
  const reply = REPLY_CHARS_PER_CHAR * chars + REPLY_CHARS_PER_STRING * batch.length;
  return Math.min(MAX_REPLY_TOKENS, REASONING_TOKENS + Math.ceil(reply / REPLY_CHARS_PER_TOKEN));
}

/**
 * Characters of prompt per token, about the way Groq counts a request
 * against its minute: 1,963 tokens "requested" by mountain's first batch in
 * the production run of 2026-10-28, for 3,750 characters of instructions and
 * strings, the schema besides. Half what English text usually takes, since
 * the schema and the model's chat format count too.
 */
const PROMPT_CHARS_PER_TOKEN = 2;

/** What a model is asked for one batch, after the instructions. */
function promptFor(batch: readonly string[], lang: string): string {
  // One line per string whatever it contains: a table cell with a line
  // break in it would otherwise read as two entries and shift the count.
  const numbered = batch.map((s, n) => `${n + 1}. ${JSON.stringify(s)}`).join('\n');
  return `Target language: ${lang}\n\nTranslate these ${batch.length} strings:\n\n${numbered}`;
}

/**
 * What one batch can cost in tokens before it is sent: its prompt, counted
 * the way Groq counts it, and its reply at the ceiling it is given. An upper
 * bound — reasoning and reply together stay well under the ceiling — for a
 * dry run's sums, and for a reply a provider turned down itself (Groq's
 * "Failed to validate JSON"), which was written and counted but reports no
 * usage.
 */
export function estimateTokens(batch: readonly string[], lang: string): number {
  const prompt = INSTRUCTIONS.length + promptFor(batch, lang).length;
  return Math.ceil(prompt / PROMPT_CHARS_PER_TOKEN) + maxReplyTokens(batch);
}

/** The tokens one call says it used, prompt and output; undefined when it says nothing. */
function usedTokens(usage: LanguageModelUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const total = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return total > 0 ? total : undefined;
}

/**
 * Characters of English a slow model can take longer to write than a provider
 * is given. Below this a timeout is the provider's, never the text's: no
 * model needs twenty-five seconds for a few table cells.
 */
const SLOW_TEXT_CHARS = 2_000;

/**
 * Spacing between the starts of requests, possibly shared by several runs.
 *
 * Shared is the point: the reader endpoint may be translating two articles at
 * once, and what the providers count is requests per minute from this
 * process, not per article.
 *
 * It can pace by tokens as well, which is what Groq's free tier counts:
 * 8,000 a minute, shared with the site's chat. Batches differ in size by ten
 * times and more, a few table cells against forty paragraphs, so no number of
 * requests a minute keeps a run under such a limit without slowing it to the
 * pace of its largest batch. Fifteen a minute, the bulk script's old pace,
 * asked for ten times what Groq admits, and held its minute full for as long
 * as the run lasted.
 */
export type Pacer = {
  /**
   * Waits for the next request's turn. Resolves false at once, claiming no
   * turn, when that turn would come at or after `notAfter`. `tokens` is what
   * the request may cost (`estimateTokens`): a pacer with a budget holds
   * other turns back by it until the request says what it used.
   */
  take: (notAfter?: number, tokens?: number) => Promise<boolean>;
  /**
   * The tokens a request used, prompt, reasoning and reply, in place of the
   * `claim` it took its turn with; none for a turn given back unused. A
   * pacer with a budget of tokens a minute holds the next turn back until it
   * has earned them again; one without ignores them.
   */
  spend?: (tokens: number, claim?: number) => void;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Turns at least `minIntervalMs` apart, claimed in order, and, with a budget
 * of `tokensPerMinute`, no sooner than the tokens spent so far allow at that
 * rate. Tokens are paid off from when the request that spent them ended,
 * which errs slow by the time each request takes: the budget is a ceiling.
 *
 * A turn given while other requests are under way waits for what they may
 * cost too, as though they had ended that moment. Charged only once they
 * ended, two workers were given the same turn and sent a minute's tokens
 * together. What a request may cost is a ceiling as well, two or three times
 * what a batch uses, so on a budget a second worker mostly waits for the
 * first to finish: the budget, not the workers, sets the pace.
 */
export function createPacer(
  minIntervalMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  tokensPerMinute = 0,
): Pacer {
  let next = 0;
  /** When every token spent so far is paid off. */
  let paidAt = 0;
  /** What the requests under way may cost: claimed with their turns, settled when they end. */
  let claimed = 0;
  const payOff = (tokens: number): number => (tokens * 60_000) / tokensPerMinute;
  return {
    async take(notAfter, tokens = 0) {
      const owed = claimed > 0 ? Math.max(paidAt, now()) + payOff(claimed) : paidAt;
      const at = Math.max(now(), next, owed);
      if (notAfter !== undefined && at >= notAfter) return false;
      if (minIntervalMs > 0) next = at + minIntervalMs;
      if (tokensPerMinute > 0 && tokens > 0) claimed += tokens;
      const wait = at - now();
      if (wait > 0) await sleep(wait);
      return true;
    },
    spend(tokens, claim = 0) {
      if (tokensPerMinute <= 0) return;
      if (claim > 0) claimed = Math.max(0, claimed - claim);
      if (tokens > 0) paidAt = Math.max(paidAt, now()) + payOff(tokens);
    },
  };
}

/** Waits `ms` with `sleep`, or until `signal` aborts. True when the wait ran its course. */
async function waitOut(ms: number, sleep: (ms: number) => Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
  if (!signal) {
    await sleep(ms);
    return true;
  }
  if (signal.aborted) return false;
  let onAbort = (): void => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return !signal.aborted;
}

export type TranslateOptions = {
  /** Strings per request. */
  batchSize?: number;
  /** Characters of English per request; a longer string goes alone. */
  maxBatchChars?: number;
  /** Requests in flight at once. */
  concurrency?: number;
  /**
   * Least time between the starts of two requests, so a long run stays under
   * a provider's per-minute limit instead of tripping it and falling through
   * the whole chain. Ignored when `pacer` is given.
   */
  minIntervalMs?: number;
  /**
   * Turns shared with other runs, and with the tokens each request used
   * charged to them; one of `minIntervalMs` for this run alone otherwise.
   */
  pacer?: Pacer;
  /**
   * No request starts at or after this instant (ms since the epoch) — the
   * second half of a halved batch included. The strings it would have carried
   * stay untranslated, for the next call.
   */
  deadline?: number;
  /**
   * Abandons every request in flight, fallbacks included, and starts no more.
   * `deadline` stops new work; this ends the work already started, which is
   * what bounds how long a run can take whatever the providers do. The strings
   * it cuts off count as skipped, never as failed or refused.
   */
  signal?: AbortSignal;
  /**
   * How long one provider may take to answer one request before it is
   * abandoned and the next provider in the chain is asked. A hung connection
   * would otherwise hold the request, and every reader waiting on it, forever.
   * A rate limit it states is waited out within this time, when it leaves
   * the provider time to answer.
   */
  requestTimeoutMs?: number;
  /**
   * After a request no provider answered — a server error, a timeout, a rate
   * limit that outlasted what the chain waits for — how long to wait before
   * the next request: the same strings asked again, or the halves of a batch
   * that ran out of time. A rate limit that states a longer wait is waited
   * out instead; a shorter one is not enough, since the chain has sat it out
   * already, up to three times.
   *
   * Zero, the default, is for a run a reader is waiting on (the endpoint):
   * the next batch is tried at once, and a rate limit ends the run on the
   * spot, since the request after it would be refused just the same. Either
   * way a second request in a row with no answer ends the run — made after
   * the wait, in a run that waits (`MAX_UNANSWERED`).
   */
  noAnswerWaitMs?: number;
  /**
   * Requests no provider answered, counted across calls (`Silence`): a run
   * that makes several hands each the same one, as it does its pacer. A call
   * given none counts its own.
   */
  silence?: Silence;
  /** The model chain; the operator's rewrite chain unless a test supplies one. */
  candidates?: () => Candidate[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type TranslationRun = {
  /** One entry per input string: its translation, or null where it stayed untranslated. */
  translations: (string | null)[];
  /** The provider that answered last, or null when none answered usably. */
  model: string | null;
  /** Strings whose request was answered with nothing usable. */
  failed: number;
  /** Their indexes, ascending: the strings to hold against. */
  failedIndexes: number[];
  /**
   * Strings never answered: the deadline passed, the run was abandoned, every
   * provider refused first, or no provider could answer at all.
   */
  skipped: number;
  /**
   * Every provider refused a request for the day — out of credit, or out of
   * a daily quota: their budget is spent until it renews.
   */
  exhausted: boolean;
  /**
   * This call's last request went unanswered, for reasons that are not about
   * the text — server errors, the network, timeouts, rate limits that
   * outlasted every wait — and nothing answered after it. Its strings are
   * left as they were, held against nothing.
   */
  unavailable: boolean;
  /**
   * That last request was refused for the minute: a provider is up, and said
   * to wait longer than the run would. Something else is spending the same
   * minute — the site's chat runs on the same key — which a quieter hour
   * cures, where an outage (`unavailable` alone) does not.
   */
  rateLimited: boolean;
  /**
   * The call stopped for want of an answer: `MAX_UNANSWERED` requests in a
   * row no provider answered, the last of them sent after the wait in a run
   * that waits — an outage, or rate limits that outlast every wait — or, in a
   * run that cannot wait, the first request every provider refused. Implies
   * `unavailable`; not the other way round, since a run that waits can end
   * on one request nobody answered, which the next call sharing its
   * `silence` follows up after the wait.
   */
  outage: boolean;
  /**
   * Requests made of the provider chain: one per batch, per half of a halved
   * batch, and per time a batch was asked again after a wait.
   */
  requests: number;
  /**
   * Calls to providers: every time the chain asked one, whatever it said. A
   * request that fell through a refusing provider before another answered
   * is two, and so is one asked of the same provider twice — after a reply
   * that did not fit, or a rate limit it waited out. Groq's daily limit
   * counts requests in these.
   */
  calls: number;
  /**
   * Tokens the providers said they used, prompt, reasoning and reply: what
   * Groq's limits of 8,000 a minute and 200,000 a day count. A reply a
   * provider turned down itself reports none, and counts as what it could
   * have cost (`estimateTokens`).
   */
  tokens: number;
  /**
   * Requests a provider answered, usably or not — or replied to before its
   * last word, a wait, which leaves the request unanswered for the stop rule
   * but paid for: zero when nothing was produced.
   */
  answered: number;
};

/** Thrown inside a run when every provider has refused for the day, to stop it. */
class BudgetExhausted extends Error {
  constructor(readonly reason: unknown) {
    super('Every model provider refused.');
    this.name = 'BudgetExhausted';
  }
}

/**
 * A provider answered, and the answer was not what was asked for: text that
 * is not the JSON list, or does not match it — whether the SDK or the
 * provider found it out (`isBadReply`) — or a reply that stopped before it
 * ended (its length limit, a content filter).
 */
function isUnusableReply(error: unknown): boolean {
  return NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error) || isBadReply(error);
}

/** Whether some provider of a failed chain answered at all, however uselessly. */
function replied(error: unknown): boolean {
  return error instanceof AllProvidersFailedError && error.failures.some((failure) => isUnusableReply(failure.error));
}

/** What a request every provider failed means for the run, and for its strings. */
type Failure =
  /** Every provider refused for the day: out of credit, or out of a daily quota. Stop. */
  | 'exhausted'
  /** Every provider refused, some only for now (a rate limit): nothing about the text. */
  | 'refused'
  /** A provider answered with something unusable: halve, and hold it against the strings. */
  | 'unusable'
  /**
   * Too large for a provider's per-minute budget, which it said at once
   * (413): halve until it fits, hold nothing — unless it is one string.
   * Neither an answer nor an outage: the provider is up, and wrote nothing.
   */
  | 'too-large'
  /**
   * No provider wrote it before its deadline, on text long enough to explain
   * that: halve, hold nothing — unless it is one string. Still a request
   * nobody answered, so a run that waits sends the halves after its wait.
   */
  | 'slow'
  /** Nothing answered, for reasons that are not about the text: hold nothing. */
  | 'unavailable';

/** Whether a failure is a request no provider answered: what an outage is made of (`MAX_UNANSWERED`). */
function isUnanswered(failure: Failure): boolean {
  return failure === 'refused' || failure === 'unavailable' || failure === 'slow';
}

/**
 * Reads a failed request, cause by cause, for evidence against its text.
 *
 * Only an answer is evidence: a reply that could not be used, or — the one
 * exception — a single long string every provider ran out of time writing,
 * which is what a string too long to translate looks like. Everything else is
 * the providers': 5xx and "overloaded", a network that cannot connect, a model
 * that does not exist, a timeout on text too short to explain it, and any mix
 * of those with refusals. Those used to be counted like a bad reply, so two
 * page views during an outage left an article's strings stuck for public
 * readers for good, though the very same request worked a minute later.
 *
 * Nor is a timeout evidence when the provider spent part of its deadline
 * waiting out a rate limit (fallback.ts): asked again with a third of its time
 * left, it missed a deadline it was never given in full. And no timeout is a
 * refusal, whatever its wording: one read as a rate limit ended a run a
 * reader was waiting on, as if every provider had refused.
 *
 * Refusals end the run only when every one of them is for the day — out of
 * credit, or a daily quota spent (circuit.ts). A per-minute limit among them
 * means a provider that will answer shortly: it ended the production run of
 * 2026-10-28 after four articles, on a Groq refusal that said "try again in
 * 510ms". What counts is each provider's last word: one that replied badly
 * and then said to wait is asked again after the wait, not halved for the
 * bad reply. Its reply was paid for (`replied`), but the request is still
 * one no provider answered.
 *
 * Anything other than the chain's own failure report is a provider list that
 * could not even be built (no key configured), which is as final as every
 * provider refusing.
 */
function judgeFailure(error: unknown, batch: readonly string[]): Failure {
  if (!(error instanceof AllProvidersFailedError)) return 'exhausted';
  // Each provider's last word: a later failure of the same provider replaces its earlier one.
  const causes = [...new Map(error.failures.map((failure) => [failure.name, failure.error])).values()];
  const refusals = causes.map((cause) => (cause instanceof ResponseTimeoutError ? null : refusalOf(cause)));
  if (refusals.every((refusal) => refusal === 'permanent' || refusal === 'daily')) return 'exhausted';
  if (refusals.every((refusal) => refusal !== null)) return 'refused';
  if (replied(error)) return 'unusable';
  // Too large for a provider's per-minute budget, prompt and ceiling together
  // (Groq's 413 "Request too large"): half of it is not.
  if (causes.some((cause) => statusOf(cause) === 413)) return batch.length === 1 ? 'unusable' : 'too-large';
  if (causes.some((cause) => cause instanceof ResponseTimeoutError && !cause.afterWait)) {
    const chars = batch.reduce((n, text) => n + text.length, 0);
    if (chars < SLOW_TEXT_CHARS) return 'unavailable';
    return batch.length === 1 ? 'unusable' : 'slow';
  }
  return 'unavailable';
}

/**
 * The soonest any rate-limited provider of a failed chain said it will
 * answer, or undefined when none said.
 */
function soonestStatedWait(error: unknown, now: number): number | undefined {
  if (!(error instanceof AllProvidersFailedError)) return undefined;
  const waits = error.failures
    .filter((failure) => refusalOf(failure.error) === 'rate-limit')
    .map((failure) => statedWaitMs(failure.error, now))
    .filter((wait): wait is number => wait !== undefined);
  return waits.length > 0 ? Math.min(...waits) : undefined;
}

/**
 * The requests a list of strings is sent in: consecutive runs of at most
 * `batchSize` strings and `maxBatchChars` characters, a longer string alone.
 * Exported so a dry run counts requests the way a real run makes them.
 */
export function splitBatches(
  strings: readonly string[],
  batchSize = BATCH,
  maxBatchChars = BATCH_CHARS,
): { start: number; batch: string[] }[] {
  const batches: { start: number; batch: string[] }[] = [];
  let chars = 0;
  strings.forEach((text, i) => {
    const last = batches.at(-1);
    if (last && last.batch.length < batchSize && chars + text.length <= maxBatchChars) {
      last.batch.push(text);
      chars += text.length;
    } else {
      batches.push({ start: i, batch: [text] });
      chars = text.length;
    }
  });
  return batches;
}

/**
 * Translates a list of strings, in batches, through the provider chain.
 *
 * Batched because an article can hold hundreds of strings, and one request for
 * all of them is both slow and easy to truncate. Forty is small enough that a
 * refused batch costs little, and large enough that the instructions are not
 * re-sent for every line; a batch of long strings is cut shorter, by
 * characters, so its reply can be written before the provider's deadline.
 *
 * A batch whose reply has the wrong length is never merged: padding or
 * trimming to fit would shift every later string onto the wrong slot, which
 * reads as a translation quietly saying the wrong thing about the wrong field —
 * the one failure worse than not translating. It is halved and retried once
 * instead, and whatever still fails comes back as null and stays in English.
 *
 * A failed batch never costs the others. The result says which strings were
 * translated and which failed, so the caller keeps every batch that worked and
 * knows what to hold against which string.
 *
 * A batch no provider answered at all is another matter (`judgeFailure`): an
 * outage, not the text. It is not held against its strings, and not halved
 * unless it timed out on enough text to explain the wait; two such requests in
 * a row end the run (`MAX_UNANSWERED`), and the strings wait for a later call.
 * A run that can wait (`noAnswerWaitMs`) waits before the next request, which
 * asks again for the same strings, and stops only when a request made after
 * that wait goes unanswered too — the next call's first request, when the
 * calls share a `silence`. A batch too large for a provider's minute is no
 * outage: the provider said so at once, and gets the batch in halves, as
 * small as it takes.
 *
 * Paced by the pacer, which hears what each request may cost when it takes
 * its turn and how many tokens it used when it ends: a run given a budget of
 * tokens a minute leaves the rest of the minute to the chat.
 *
 * Refusals are read for how long they last. A rate limit that states a short
 * wait is sat out on the provider that stated it (fallback.ts); one that
 * outlasts it is a batch nobody answered; and only when every provider has
 * refused for the day — out of credit, or out of a daily quota — does the run
 * stop on the spot (`exhausted`).
 *
 * Bounded in time three ways: no request starts after `deadline`, each
 * provider gets `requestTimeoutMs`, rate-limit waits included, and `signal`
 * abandons whatever is still running. A provider chain is several providers
 * long, so the per-provider timeout alone bounds nothing: three that hang take
 * three timeouts.
 */
export async function translateStrings(
  strings: readonly string[],
  lang: string,
  options: TranslateOptions = {},
): Promise<TranslationRun> {
  const {
    batchSize = BATCH,
    maxBatchChars = BATCH_CHARS,
    concurrency = 1,
    minIntervalMs = 0,
    deadline,
    signal,
    requestTimeoutMs = 60_000,
    noAnswerWaitMs = 0,
    candidates = rewriteCandidates,
    now = Date.now,
    sleep = defaultSleep,
  } = options;
  const pacer = options.pacer ?? createPacer(minIntervalMs, now, sleep);
  const silence = options.silence ?? createSilence();

  const translations: (string | null)[] = strings.map(() => null);
  const failedIndexes: number[] = [];
  let model: string | null = null;
  let requests = 0;
  let calls = 0;
  let tokens = 0;
  let answered = 0;
  /** This call's last request went unanswered, and nothing answered after it (`TranslationRun`). */
  let unavailable = false;
  /** And it was refused for the minute. */
  let rateLimited = false;
  let exhausted = false;
  let outage = false;
  let stop = false;

  const outOfTime = (): boolean => (deadline !== undefined && now() >= deadline) || signal?.aborted === true;

  const gotAnswer = (): void => {
    answered += 1;
    silence.unanswered = 0;
    unavailable = false;
    rateLimited = false;
  };
  /**
   * A request no provider answered. `afterWait` says it went out after the
   * wait that followed the last one: in a run that waits, only such a request
   * can be the second of an outage (`MAX_UNANSWERED`), so two workers whose
   * batches met one busy minute together are both asked again first.
   */
  const gotNoAnswer = (failure: Failure, afterWait: boolean): void => {
    silence.unanswered += 1;
    silence.rateLimited = failure === 'refused';
    unavailable = true;
    rateLimited = failure === 'refused';
    if (silence.unanswered >= MAX_UNANSWERED && (noAnswerWaitMs <= 0 || afterWait)) {
      stop = true;
      outage = true;
    }
  };
  /**
   * In a run that waits, holds every request back after one no provider
   * answered: for `noAnswerWaitMs`, or for as long as the soonest
   * rate-limited provider said, when that is longer. Never for less: a
   * provider still refusing after the chain sat out three of its "510ms"
   * waits would only meet the same busy minute half a second later.
   */
  const holdOff = (error: unknown): void => {
    if (noAnswerWaitMs <= 0) return;
    const stated = soonestStatedWait(error, now()) ?? 0;
    const until = now() + Math.min(Math.max(stated, noAnswerWaitMs), MAX_NO_ANSWER_WAIT_MS);
    silence.resumeAt = Math.max(silence.resumeAt, until);
  };
  /** Sits out the wait `holdOff` set, if there is one. False when the run is to stop instead. */
  const waitToAskAgain = async (size: number): Promise<boolean> => {
    const wait = silence.resumeAt - now();
    if (wait <= 0) return true;
    if (deadline !== undefined && silence.resumeAt >= deadline) return false;
    const why = silence.rateLimited ? 'the providers asked to wait' : 'no provider answered the last request';
    logWarn('translate', `${why}; asking for ${size} strings in ${Math.round(wait / 1000)} s`);
    return (await waitOut(wait, sleep, signal)) && !stop;
  };
  /**
   * Waits for a request's turn: the wait after one no provider answered,
   * then the pacer's turn — and the wait again, when a request nobody
   * answered set one while this one waited for its turn. Sent then, it met
   * the same busy minute as that request, and passed for the second of an
   * outage. `claim` is what the request may cost. False when the run is to
   * stop instead.
   */
  const turn = async (size: number, claim: number): Promise<boolean> => {
    for (;;) {
      if (stop || outOfTime() || !(await waitToAskAgain(size))) return false;
      const sat = silence.resumeAt;
      if (!(await pacer.take(deadline, claim))) return false;
      const heldOff = silence.resumeAt !== sat && now() < silence.resumeAt;
      if (!stop && !outOfTime() && !heldOff) return true;
      // Given back unused; the next pass takes another.
      pacer.spend?.(0, claim);
    }
  };

  type Failed = { failure: Exclude<Failure, 'exhausted'> };

  /**
   * One request: the translations, or why there are none — 'unusable' when
   * the reply cannot be used, 'too-large' when it must be sent in halves,
   * 'refused', 'slow' or 'unavailable' when no provider answered
   * (`judgeFailure`); 'skipped' when it was never made, or made and
   * abandoned, because the run is out of time or has stopped.
   *
   * Every call it makes is counted. Its turn claims what it may cost, and the
   * claim is settled at the tokens its calls say they used, for the next
   * turn to wait on.
   */
  const request = async (batch: string[]): Promise<string[] | Failed | 'skipped'> => {
    /**
     * What a call that was paid for and says nothing of it is taken to have
     * cost, and what this request's turn claims until it ends.
     */
    const unreported = estimateTokens(batch, lang);
    // Before every request, the halves of a halved batch included.
    if (!(await turn(batch.length, unreported))) return 'skipped';
    // Sent after every wait set so far (`turn`): with a request still
    // unanswered, this one is the second of an outage if it goes unanswered too.
    const afterWait = noAnswerWaitMs > 0 && silence.unanswered > 0;
    let spent = 0;
    try {
      const chain = candidates();
      requests += 1;
      const { value, candidate } = await withFallback(
        chain,
        (c, attempt) => {
          calls += 1;
          return generateText({
            model: c.model,
            maxRetries: attempt.maxRetries,
            // This provider's deadline and the run's end, together.
            abortSignal: attempt.abortSignal,
            output: Output.object({ schema }),
            instructions: INSTRUCTIONS,
            prompt: promptFor(batch, lang),
            temperature: 0,
            maxOutputTokens: maxReplyTokens(batch),
          }).then(
            (result) => {
              spent += usedTokens(result.usage) ?? unreported;
              return result.output;
            },
            (error: unknown) => {
              // A reply written and then turned down was counted all the same.
              if (isUnusableReply(error)) {
                spent += usedTokens(NoObjectGeneratedError.isInstance(error) ? error.usage : undefined) ?? unreported;
              }
              throw error;
            },
          );
        },
        // A short rate limit is waited out on the provider that states it,
        // on this run's clock (the default timer when none was given).
        { timeoutMs: requestTimeoutMs, signal, maxWaitMs: RATE_LIMIT_WAIT_MS, now, sleep: options.sleep },
      );
      gotAnswer();
      if (value.translations.length !== batch.length) {
        logWarn('translate', `asked for ${batch.length} strings, got ${value.translations.length}`, {
          model: candidate.name,
        });
        return { failure: 'unusable' };
      }
      model = candidate.name;
      return value.translations;
    } catch (error) {
      // Abandoned with the rest of the run: neither the text's fault nor a refusal.
      if (signal?.aborted) return 'skipped';
      const failure = judgeFailure(error, batch);
      if (failure === 'exhausted') throw new BudgetExhausted(error);
      if (isUnanswered(failure)) {
        // A reply before the provider's last word was paid for all the same.
        // But the request was not answered: its provider said to wait, and
        // its batch is asked again after that wait. Taken for an answer, it
        // reset the count, and a run of busy minutes passed for answers that
        // are no use.
        if (replied(error)) answered += 1;
        gotNoAnswer(failure, afterWait);
        holdOff(error);
      } else if (replied(error)) {
        gotAnswer();
      }
      logWarn('translate', `batch of ${batch.length} failed (${failure}): ${describeError(error).message}`);
      return { failure };
    } finally {
      tokens += spent;
      pacer.spend?.(spent, unreported);
    }
  };

  /**
   * One batch, and what its failure calls for. `splits` counts the halvings
   * an unusable or slow reply has had (`MAX_SPLITS`); halving a batch too
   * large for the minute does not use them up.
   */
  const translateBatch = async (start: number, batch: string[], splits: number): Promise<void> => {
    let out = await request(batch);
    /*
     * No provider answered. A run that can wait asks again for the same
     * strings, after the wait that request set (`holdOff`, sat out in
     * `request`); unanswered again, it has stopped the run (`gotNoAnswer`),
     * and this request is never made.
     */
    const noAnswer = typeof out === 'object' && !Array.isArray(out) && (out.failure === 'refused' || out.failure === 'unavailable');
    if (noAnswerWaitMs > 0 && noAnswer) out = await request(batch);
    if (out === 'skipped') {
      stop = true;
      return;
    }
    if (Array.isArray(out)) {
      out.forEach((text, k) => {
        if (text.trim() === '') failedIndexes.push(start + k);
        else translations[start + k] = text;
      });
      return;
    }
    // Every provider refused, some only for the minute, and this run has no
    // time to wait for them: the next request would be refused just the same.
    if (out.failure === 'refused') {
      if (noAnswerWaitMs <= 0) {
        stop = true;
        outage = true;
      }
      return;
    }
    // Nobody answered: nothing to learn about these strings, and halving
    // cannot bring a provider back.
    if (out.failure === 'unavailable') return;
    // Too large for the minute: halved until it fits, since saying so costs nothing.
    if (out.failure === 'too-large' && batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      await translateBatch(start, batch.slice(0, half), splits);
      await translateBatch(start + half, batch.slice(half), splits);
      return;
    }
    // 'unusable' or 'slow': half the text may well get through.
    if (batch.length > 1 && splits < MAX_SPLITS) {
      const half = Math.ceil(batch.length / 2);
      await translateBatch(start, batch.slice(0, half), splits + 1);
      await translateBatch(start + half, batch.slice(half), splits + 1);
      return;
    }
    // Only an unusable answer is held against its strings.
    if (out.failure === 'unusable') for (let k = 0; k < batch.length; k++) failedIndexes.push(start + k);
  };

  const batches = splitBatches(strings, batchSize, maxBatchChars);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (!stop && next < batches.length) {
      if (outOfTime()) {
        stop = true;
        return;
      }
      const { start, batch } = batches[next++]!;
      try {
        await translateBatch(start, batch, 0);
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) throw error;
        if (!exhausted) {
          logWarn('translate', `every provider refused for the day; stopping: ${describeError(error.reason).message}`);
        }
        exhausted = true;
        stop = true;
      }
    }
  };
  const workers = Math.max(1, Math.min(concurrency, batches.length));
  await Promise.all(Array.from({ length: workers }, worker));

  failedIndexes.sort((a, b) => a - b);
  const untranslated = translations.filter((t) => t === null).length;
  return {
    translations,
    model,
    failed: failedIndexes.length,
    failedIndexes,
    skipped: untranslated - failedIndexes.length,
    exhausted,
    unavailable,
    rateLimited,
    outage,
    requests,
    calls,
    tokens,
    answered,
  };
}

export type ArticleTranslation = AppliedMemory & {
  /** The English strings this call sent, translated or not. */
  attempted: string[];
  /** Strings this call translated; the rest came from memory or stayed in English. */
  translated: number;
  /** Strings this call sent that came back unusable. */
  failed: number;
  /** The failure log after this call: the previous one, plus this call's failures, less what it translated. */
  failures: FailureLog;
  /** The provider that answered last in this call, or null when none answered. */
  model: string | null;
  /** Every provider refused for the day: their budget is spent until it renews. */
  exhausted: boolean;
  /**
   * The call ended on requests no provider answered — server errors, the
   * network, timeouts, rate limits that outlasted every wait — rather than on
   * anything about the text.
   */
  unavailable: boolean;
  /** And the last of those was refused for the minute, by a provider that is up (`TranslationRun`). */
  rateLimited: boolean;
  /** Requests no provider answered stopped the call (`TranslationRun`): ask again later, not now. */
  outage: boolean;
  /** Requests made of the provider chain: batches, halves, and batches asked again after a wait. */
  requests: number;
  /** Calls to providers, every one the chain made: fallbacks and same-provider retries included. */
  calls: number;
  /** Tokens the providers said they used (`TranslationRun`). */
  tokens: number;
  /** Requests a provider answered or replied to (`TranslationRun`): zero when this call produced nothing to pay for. */
  answered: number;
};

/**
 * Translates what an article's memory does not cover yet, and applies the
 * whole memory to it.
 *
 * `maxStrings` bounds the work of one call, taken in `planArticle`'s order:
 * a long article gets its skeleton — title, lead, headings, labels — on the
 * first call and its text from the top after that, each call continuing from
 * where the last one stopped.
 *
 * Strings that failed before go last and in small batches. Strings that
 * failed `maxFailures` times are not sent at all: they are the caller's to
 * give up on, for this reader.
 */
export async function translateArticle(
  input: {
    doc: ArticleDoc;
    title: string;
    lang: string;
    memory?: TranslationMemory | null;
    failures?: FailureLog | null;
    /** Leave out strings that failed this many times. */
    maxFailures?: number;
    /** Send at most this many strings; the rest wait for the next call. */
    maxStrings?: number;
    /** Strings not to send this time: ones that already failed earlier in the same run. */
    skip?: ReadonlySet<string>;
  } & TranslateOptions,
): Promise<ArticleTranslation> {
  const { doc, title, lang, memory, failures, maxFailures, maxStrings = Number.POSITIVE_INFINITY, skip, ...options } =
    input;
  const { extraction, todo } = planArticle(doc, title, memory, failures, maxFailures);
  const sent = todo.filter((i) => !skip?.has(extraction.strings[i]!)).slice(0, maxStrings);
  const failedBefore = (i: number): boolean => (failures?.get(extraction.strings[i]!) ?? 0) > 0;

  const merged: TranslationMemory = new Map(memory ?? []);
  const log: FailureLog = new Map(failures ?? []);
  let translated = 0;
  let failed = 0;
  let requests = 0;
  let calls = 0;
  let tokens = 0;
  let answered = 0;
  let model: string | null = null;
  let exhausted = false;
  let unavailable = false;
  let rateLimited = false;
  let outage = false;
  // One pace for both runs below: each used to start its own, and the first
  // retry of an old failure went out on the heels of the last fresh request.
  const pacer = options.pacer ?? createPacer(options.minIntervalMs ?? 0, options.now, options.sleep);
  // And one count of requests nobody answered, for the same reason (`Silence`).
  const silence = options.silence ?? createSilence();
  const waits = (options.noAnswerWaitMs ?? 0) > 0;

  const run = async (indexes: number[], batchSize?: number): Promise<void> => {
    // Providers that refused for the day, or stopped answering, a moment ago
    // will not take the retries either. A run that waits gives up only on an
    // outage: after one request nobody answered, the retries go out after
    // the wait, and the first of them unanswered is the outage.
    if (indexes.length === 0 || exhausted || outage || (unavailable && !waits)) return;
    const shared = { ...options, pacer, silence };
    const result = await translateStrings(
      indexes.map((i) => extraction.strings[i]!),
      lang,
      batchSize === undefined ? shared : { ...shared, batchSize },
    );
    requests += result.requests;
    calls += result.calls;
    tokens += result.tokens;
    answered += result.answered;
    exhausted ||= result.exhausted;
    outage ||= result.outage;
    unavailable = result.unavailable;
    rateLimited = result.rateLimited;
    model = result.model ?? model;
    result.translations.forEach((text, k) => {
      if (text === null) return;
      const english = extraction.strings[indexes[k]!]!;
      merged.set(english, text);
      log.delete(english);
      translated += 1;
    });
    for (const k of result.failedIndexes) {
      const english = extraction.strings[indexes[k]!]!;
      log.set(english, (log.get(english) ?? 0) + 1);
      failed += 1;
    }
  };

  await run(sent.filter((i) => !failedBefore(i)));
  await run(sent.filter(failedBefore), Math.min(options.batchSize ?? BATCH, RETRY_BATCH));

  const applied = applyMemory(doc, title, merged);
  return {
    ...applied,
    attempted: sent.map((i) => extraction.strings[i]!),
    translated,
    failed,
    failures: pruneFailures(log, extraction, applied.memory),
    model,
    exhausted,
    unavailable,
    rateLimited,
    outage,
    requests,
    calls,
    tokens,
    answered,
  };
}
