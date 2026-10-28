import type { ArticleDoc, ArticleFacets, InfoboxGroup } from './article-types';
import { isRecipeLabel } from './recipe';
import { termLabel, type TermKind } from '@/lib/i18n/terms';
import type { Lang } from '@/lib/i18n/strings';

/**
 * Turns the names in an article's text into links to the articles they name.
 *
 * The ingest keeps text, not markup, so every cross-link the wiki had is gone
 * by the time an article is read here: the "Building" section of Dandelion
 * says "Spice rack" and "Maypole" and offers no way to reach either. On the
 * wiki those were links, and a wiki with no links between its pages is a
 * dictionary.
 *
 * Rather than re-parsing a thousand pages to recover the markup, the names
 * are found at render time against the title index the reader already has:
 * every article title (and its Spanish title, once translated) is a term, and
 * a term that appears whole in the text becomes a link. That covers the
 * original links and also the mentions the wiki's editors never linked.
 *
 * A translated article complicates it in two ways that matter. Its lists and
 * cells are Spanish, with the English in brackets only when the translation
 * remembered to add it; the English article is right there, though, and the
 * translation preserves structure, so each item can be paired with the
 * English it came from and resolved through that — the same trick the recipe
 * uses. And a Spanish name is often an ordinary word: "claro" (clear) is the
 * Glade, "hogar" (home) the Hearth, "Drakkar" both a ship of its own and the
 * Longship's Spanish name. So a Spanish name links only where the English
 * sentence it was translated from names the same article.
 */

/** An article a piece of text can point at. */
export type LinkTarget = {
  /** The text that stands for the article, as it can appear on a page. */
  match: string;
  slug: string;
  /** The article's title in the reader's language, for the link's tooltip. */
  title: string;
  /**
   * The article's English title, present when `match` is a translated name
   * rather than the English title itself. It is what a Spanish name is
   * checked against in the English sentence it was translated from.
   */
  english?: string;
  /**
   * The strings this target may link in, as `textKey` values; absent means
   * anywhere. Set by `collectArticleLinks` for Spanish names, whose meaning
   * changes from sentence to sentence: "hogar" is the Hearth in one line of
   * an article and somebody's home in the next, and the page only carries one
   * list of terms. Where no target for a name is allowed, the name still
   * claims its words — so none of them links on its own — and links nowhere.
   */
  in?: string[];
};

export type Segment = { text: string; link?: { slug: string; title: string } };

export type Linker = {
  /** Every term at once, longest first so `Black Forest` beats `Black`. */
  pattern: RegExp | null;
  /** The default target for each normalised match, for exact lookups. */
  byMatch: Map<string, LinkTarget>;
  /**
   * Every target for each normalised match. Usually one; more when two
   * articles answer to the same name, or when a name means different
   * articles in different strings of one page.
   */
  candidates: Map<string, LinkTarget[]>;
  /**
   * The article being read. Its own names stay in the pattern so they claim
   * their text — "Espada de hierro" must not yield a link to Iron from its
   * last word — but they are never rendered as links. When a name is shared,
   * the page's own article is what it means on that page.
   */
  selfSlug?: string;
};

/**
 * Terms shorter than this are not linked.
 *
 * Two-letter titles exist ("Ox") and would match inside ordinary prose in
 * either language far more often than they name the article.
 */
const MIN_TERM_LENGTH = 3;

/** Case, spacing and curly apostrophes never decide whether two names are the same. */
export function normalizeTerm(text: string): string {
  return text.trim().toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ');
}

/**
 * A short, stable key for a displayed string: FNV-1a over its normalised
 * text. The server and the browser both compute it from the string they
 * render, so a restriction written on one side is read on the other without
 * shipping the strings twice.
 */
export function textKey(text: string): string {
  const normalized = normalizeTerm(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/*
 * Where a name may start and end: not joined to a letter, a digit or an
 * underscore, and not followed by a dot and a letter or digit, which is a file
 * extension or a dotted identifier. A dot that ends a sentence still ends a
 * name.
 */
const NOT_AFTER_WORD = '(?<![\\p{L}\\p{N}_])';
const NOT_BEFORE_WORD = '(?![\\p{L}\\p{N}_]|\\.[\\p{L}\\p{N}])';

/** A term as a regex alternative: literal, but tolerant of spacing and apostrophes. */
function termPattern(term: string): string {
  return term
    .split(' ')
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]"))
    .join('\\s+');
}

/** English titles before translated names, so a shared name means the English article by default. */
function byEnglishFirst(a: LinkTarget, b: LinkTarget): number {
  return Number(a.english !== undefined) - Number(b.english !== undefined);
}

export function buildLinker(targets: LinkTarget[], options: { selfSlug?: string } = {}): Linker {
  const candidates = new Map<string, LinkTarget[]>();

  for (const target of targets) {
    const key = normalizeTerm(target.match);
    if (key.length < MIN_TERM_LENGTH) continue;
    // A number is a value, never a name, whatever the wiki titled a page.
    if (/^[\d.,\s]+$/.test(key)) continue;
    const list = candidates.get(key);
    if (list) list.push(target);
    else candidates.set(key, [target]);
  }

  const byMatch = new Map<string, LinkTarget>();
  for (const [key, list] of candidates) {
    list.sort(byEnglishFirst);
    byMatch.set(key, list.find((t) => !t.in) ?? list[0]!);
  }

  const selfSlug = options.selfSlug;
  if (candidates.size === 0) return { pattern: null, byMatch, candidates, selfSlug };

  const alternatives = [...candidates.keys()].sort((a, b) => b.length - a.length).map(termPattern);

  /*
   * Whole words only, and by Unicode letter rather than `\b`. The ASCII word
   * boundary treats an accented letter as punctuation, so `Jabalí\b` would
   * never match: there is no boundary between `í` and the space that follows
   * it. The lookarounds also keep "Wood" out of "Woodcutter" and "Especie"
   * out of "Especiero", and a name out of a file name or an identifier:
   * `valheim_server.exe`, `valheim.sh`, `piece_chest_blackmetal`.
   */
  const pattern = new RegExp(`${NOT_AFTER_WORD}(?:${alternatives.join('|')})${NOT_BEFORE_WORD}`, 'giu');

  return { pattern, byMatch, candidates, selfSlug };
}

/** What a claimed but unlinked name resolves to: it keeps its words, and goes nowhere. */
const CLAIMED: LinkTarget = { match: '', slug: '', title: '' };

/**
 * The article a name means in one string.
 *
 * The page's own article when it is a candidate; then a target allowed in
 * this string; then one allowed anywhere; and failing all of those, nothing —
 * the name is claimed and left plain.
 */
function resolve(linker: Linker, key: string, text: string, selfSlug = linker.selfSlug): LinkTarget | null {
  const list = linker.candidates.get(key);
  if (!list) return null;
  if (selfSlug) {
    const self = list.find((t) => t.slug === selfSlug);
    if (self) return self;
  }
  if (list.length === 1 && !list[0]!.in) return list[0]!;

  let here: string | undefined;
  for (const target of list) {
    if (!target.in) continue;
    here ??= textKey(text);
    if (target.in.includes(here)) return target;
  }
  return list.find((t) => !t.in) ?? CLAIMED;
}

/** The article a string names outright, or null: `Spice rack`, not `Spice rack and more`. */
export function exactTarget(linker: Linker, text: string): LinkTarget | null {
  const target = resolve(linker, normalizeTerm(text), text);
  return target && target.slug && target.slug !== linker.selfSlug ? target : null;
}

type Hit = { start: number; end: number; key: string; target: LinkTarget };

/** Every mention of a term in the text, in order, before any merging or deduplication. */
function findHits(text: string, linker: Linker, selfSlug = linker.selfSlug): Hit[] {
  if (!linker.pattern || !text) return [];
  const hits: Hit[] = [];
  for (const found of text.matchAll(linker.pattern)) {
    const key = normalizeTerm(found[0]);
    const target = resolve(linker, key, text, selfSlug);
    if (target) hits.push({ start: found.index, end: found.index + found[0].length, key, target });
  }
  return hits;
}

/**
 * Splits text into plain runs and linked runs.
 *
 * Each article is linked once per string, at its first mention, the way a
 * wiki does: a paragraph about wood that turned every "wood" blue would be
 * harder to read, not easier to navigate.
 *
 * `Praderas (Meadows)` — a Spanish name with its English gloss — becomes one
 * link rather than two, when both halves resolve to the same article.
 */
export function linkify(text: string, linker: Linker): Segment[] {
  const hits = mergeGlossed(text, findHits(text, linker));
  if (hits.length === 0) return [{ text }];

  const segments: Segment[] = [];
  const seen = new Set<string>();
  let cursor = 0;

  for (const hit of hits) {
    const { slug } = hit.target;
    if (!slug || slug === linker.selfSlug || seen.has(slug)) continue;
    seen.add(slug);
    if (hit.start > cursor) segments.push({ text: text.slice(cursor, hit.start) });
    segments.push({
      text: text.slice(hit.start, hit.end),
      link: { slug, title: hit.target.title },
    });
    cursor = hit.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });

  return segments.length > 0 ? segments : [{ text }];
}

/** Whether the hit is directly followed by a bracketed hit: `Name (Gloss)`. */
function glossOf(text: string, hit: Hit, next: Hit | undefined): Hit | null {
  return next && /^\s*\(\s*$/.test(text.slice(hit.end, next.start)) && text[next.end] === ')' ? next : null;
}

/** Joins `Name (Gloss)` into one hit when both halves point at the same article. */
function mergeGlossed(text: string, hits: Hit[]): Hit[] {
  const out: Hit[] = [];
  for (const hit of hits) {
    const previous = out[out.length - 1];
    if (previous && previous.target.slug && previous.target.slug === hit.target.slug && glossOf(text, previous, hit)) {
      previous.end = hit.end + 1;
      continue;
    }
    out.push({ ...hit });
  }
  return out;
}

/**
 * `Especiero (Spice rack)` → the name and its gloss; null when there is no
 * gloss. Parentheses may nest: `Yuleklapp (mediano) (Yuleklapp (medium))`.
 */
export function splitGloss(text: string): { name: string; gloss: string } | null {
  const trimmed = text.trim();
  if (!trimmed.endsWith(')')) return null;

  let depth = 0;
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const char = trimmed[i];
    if (char === ')') depth += 1;
    else if (char === '(') {
      depth -= 1;
      if (depth === 0) {
        const name = trimmed.slice(0, i).trim();
        const gloss = trimmed.slice(i + 1, -1).trim();
        return name && gloss ? { name, gloss } : null;
      }
    }
  }
  return null;
}

/**
 * A translated title without its English gloss: the name a Spanish reader
 * sees, in lists, search results and links.
 *
 * `Espada de hierro (Iron Sword)` → `Espada de hierro`, but only when the
 * bracket really is the English title: `Yuleklapp (medium)` is a name with
 * brackets in it, and stripping them would point "Yuleklapp" at one size.
 *
 * Disambiguated titles carry the gloss one bracket in, before the translated
 * qualifier — `Pesca (Fishing) (habilidad)` for "Fishing (skill)" — and come
 * out as `Pesca (habilidad)`.
 */
export function spanishName(translated: string, english: string): string {
  const split = splitGloss(translated);
  if (!split) return translated.trim();
  if (normalizeTerm(split.gloss) === normalizeTerm(english)) return split.name;

  const englishBase = splitGloss(english)?.name;
  const inner = splitGloss(split.name);
  if (englishBase && inner && normalizeTerm(inner.gloss) === normalizeTerm(englishBase)) {
    return `${inner.name} (${split.gloss})`;
  }
  return translated.trim();
}

/**
 * Every displayed string of a document, in a stable order.
 *
 * Recipe rows are left out: the recipe component resolves its own
 * ingredients, with pictures, and linking the same names a second way would
 * only disagree with it. A translation and its English are walked together,
 * and a row is a recipe when either side's label says so: one translation
 * calls the row "Materiales de artesanía", and a recipe row counted on one
 * side and not the other would shift every later string onto its
 * neighbour's English.
 */
function docStrings(doc: ArticleDoc, counterpart?: ArticleDoc): string[] {
  const out: string[] = [doc.lead];
  for (const block of doc.blocks) {
    if (block.kind === 'paragraph') out.push(block.text);
    else if (block.kind === 'list') out.push(...block.items);
    else out.push(...block.rows.flat());
  }
  const other = counterpart ? infoboxGroups(counterpart) : [];
  infoboxGroups(doc).forEach((group, g) => {
    group.rows.forEach((row, r) => {
      const paired = other[g]?.rows[r];
      if (!isRecipeLabel(row.label) && !(paired && isRecipeLabel(paired.label))) out.push(row.value);
    });
  });
  return out;
}

function infoboxGroups(doc: ArticleDoc): InfoboxGroup[] {
  const box = doc.infobox;
  return box ? [...box.common, ...box.tabs.flatMap((tab) => tab.groups)] : [];
}

/**
 * Whether an English sentence names an article, as whole words, singular or
 * plural. A disambiguated title counts by its name: a sentence about fishing
 * says "Fishing", never "Fishing (skill)".
 */
function mentions(sentence: string, title: string, cache: Map<string, RegExp>): boolean {
  let pattern = cache.get(title);
  if (!pattern) {
    const name = splitGloss(title)?.name ?? title;
    const stem = name.length > 3 ? name.replace(/(?:es|s)$/i, '') : name;
    pattern = new RegExp(`${NOT_AFTER_WORD}${termPattern(normalizeTerm(stem))}(?:e?s)?${NOT_BEFORE_WORD}`, 'iu');
    cache.set(title, pattern);
  }
  return pattern.test(sentence);
}

const FACET_KINDS: Partial<Record<keyof ArticleFacets, TermKind>> = {
  biome: 'biome',
  station: 'station',
  type: 'type',
};

/**
 * The link targets one article needs, and nothing more.
 *
 * The full index is a couple of thousand terms; the page only needs the ones
 * that occur in this article, which is a few dozen. Those are what the client
 * component receives, and the same `linkify` then runs in the browser with the
 * subset, so the server pays for the wide search once and the page carries
 * only what it uses.
 *
 * Two kinds of target come out:
 *
 *   - terms from the index that appear in the displayed text, whichever
 *     language they are in — the article's own names included, so that the
 *     browser's pass claims them the same way and never links their tail;
 *   - whole strings — a list item, a table cell, an infobox value — whose
 *     English original names an article outright. On a translated page the
 *     displayed string is Spanish and may carry no gloss; pairing it with the
 *     English by position is what still gets it a link.
 *
 * On a translated page a Spanish name is restricted to the strings whose
 * English original names its article (or that gloss it in brackets), and a
 * name two articles share goes to the one the English names; see
 * `LinkTarget.in`.
 *
 * `linker` is the index already compiled, which callers that render many
 * pages hold on to: the regex over every title is the expensive part, and it
 * is the same for every page in a language. `lang` adds the facets' display
 * names ("Forja" for Forge), so a facet shown in Spanish still links.
 */
export function collectArticleLinks({
  doc,
  source,
  index,
  selfSlug,
  linker: compiled,
  lang = 'en',
}: {
  /** The document as displayed: the translation when there is one. */
  doc: ArticleDoc;
  /** The English document it was made from. The same object when not translated. */
  source: ArticleDoc;
  index: LinkTarget[];
  selfSlug: string;
  /** `buildLinker(index)`, when the caller already has it. */
  linker?: Linker;
  lang?: Lang;
}): LinkTarget[] {
  const linker = compiled ?? buildLinker(index);
  if (!linker.pattern) return [];

  const found = new Map<string, LinkTarget>();
  /** One target per name and article; `where` narrows it to a string, `null` claims it without allowing it anywhere new. */
  const add = (target: LinkTarget, where?: string | null): void => {
    if (!target.slug) return;
    const id = `${normalizeTerm(target.match)}\u0000${target.slug}`;
    const held = found.get(id);
    if (where === undefined) {
      // Unrestricted wins over restricted: allowed anywhere already covers this string.
      found.set(id, held ? { ...held, in: undefined } : { ...target, in: undefined });
      return;
    }
    if (held && !held.in) return;
    const allowed = new Set(held?.in ?? []);
    if (where) allowed.add(where);
    found.set(id, { ...(held ?? target), in: [...allowed] });
  };

  const translated = doc !== source;
  const shown = translated ? docStrings(doc, source) : docStrings(doc);
  const original = translated ? docStrings(source, doc) : shown;
  // A translation that no longer lines up with its source cannot be paired
  // by position: it would hand one item another item's link.
  const aligned = original.length === shown.length;
  const titlePatterns = new Map<string, RegExp>();

  shown.forEach((text, i) => {
    const english = translated && aligned ? original[i] : undefined;
    const hits = findHits(text, linker, selfSlug);
    const here = textKey(text);

    hits.forEach((hit, h) => {
      const list = linker.candidates.get(hit.key) ?? [];
      const self = list.find((t) => t.slug === selfSlug);
      if (self) return add(self);
      // Only a Spanish name needs its English original's word for it.
      if (english === undefined || !list.some((t) => t.english !== undefined)) return add(hit.target);

      const gloss = glossOf(text, hit, hits[h + 1]);
      const chosen =
        (gloss ? list.find((t) => t.slug === gloss.target.slug) : undefined) ??
        unique(list.filter((t) => mentions(english, t.english ?? t.match, titlePatterns)));
      if (chosen) add(chosen, here);
      // Claimed everywhere it is not allowed: the words stay plain.
      for (const target of list) if (target !== chosen) add(target, null);
    });

    const exact = linker.candidates.get(normalizeTerm(text));
    const pairedWhole = english ? exactTarget(linker, english) : null;
    if (exact) {
      // Already a term, so the regex found it whole — unless the English
      // original names another article: "Hoguera" is the Campfire's name, but
      // where the English says "Bonfire" the bonfire is what it means.
      if (pairedWhole && exact.some((t) => t.english !== undefined) && !exact.some((t) => t.slug === pairedWhole.slug)) {
        add({ match: text.trim(), slug: pairedWhole.slug, title: pairedWhole.title }, here);
      }
      return;
    }

    const gloss = splitGloss(text);
    const glossed = gloss && isGlossedName(gloss) ? exactTarget(linker, gloss.gloss) : null;
    const whole = pairedWhole ?? glossed;
    if (whole) add({ match: text.trim(), slug: whole.slug, title: whole.title });
  });

  // Facets are stored in English; they are shown under the title, in the
  // reader's language once translated for display.
  for (const [facet, value] of Object.entries(doc.facets) as [keyof ArticleFacets, string | undefined][]) {
    if (!value) continue;
    for (const hit of findHits(value, linker, selfSlug)) add(hit.target);
    const kind = FACET_KINDS[facet];
    const label = kind ? termLabel(kind, value, lang) : value;
    const target = label !== value ? exactTarget({ ...linker, selfSlug }, value) : null;
    if (target) add({ match: label, slug: target.slug, title: target.title });
  }

  return [...found.values()];
}

/**
 * Longer than any article's name in either language (the longest Spanish one
 * is 44 characters), with room to spare: past it, what comes before a gloss
 * is more than a name.
 */
const MAX_GLOSSED_NAME = 48;

/**
 * Whether a string that ends in a gloss is a name and its gloss —
 * `Especiero (Spice rack)` — and so may be claimed whole for the article the
 * gloss names.
 *
 * A list item an older ingest ran together ends in a gloss too: Copper's
 * "Construcción: Bosque negro Fragua … Generador de escudo (Shield
 * generator)" was claimed, all 750 characters of it, for the Shield
 * generator, and the twenty or so names in it linked nowhere. So the part
 * before the gloss must read as one name: one line, no longer than a name,
 * and no colon the gloss does not have — "Construcción:" heads a list, while
 * "Base de aguamiel: Curación media (Mead base: Medium healing)" keeps the
 * colon of its English name.
 *
 * The page keeps its own guard against a link far longer than its article's
 * name (`isMention`, src/components/wiki/article/lines.ts), for links
 * collected before this check.
 */
function isGlossedName({ name, gloss }: { name: string; gloss: string }): boolean {
  const colons = (text: string): number => text.split(':').length - 1;
  return name.length <= MAX_GLOSSED_NAME && !name.includes('\n') && colons(name) <= colons(gloss);
}

/** The one article a set of targets agrees on, or undefined when it is none or several. */
function unique(targets: LinkTarget[]): LinkTarget | undefined {
  const slugs = new Set(targets.map((t) => t.slug));
  return slugs.size === 1 ? targets[0] : undefined;
}
