import type { ArticleDoc, InfoboxGroup } from './article-types';
import { isRecipeLabel } from './recipe';

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
 * A translated article complicates it in one way that matters: its lists and
 * cells are Spanish, with the English in brackets only when the translation
 * remembered to add it. The English article is right there, though, and the
 * translation preserves structure, so each item can be paired with the English
 * it came from and resolved through that — the same trick the recipe uses.
 */

/** An article a piece of text can point at. */
export type LinkTarget = {
  /** The text that stands for the article, as it can appear on a page. */
  match: string;
  slug: string;
  /** The article's title in the reader's language, for the link's tooltip. */
  title: string;
};

export type Segment = { text: string; link?: { slug: string; title: string } };

export type Linker = {
  /** Every term at once, longest first so `Black Forest` beats `Black`. */
  pattern: RegExp | null;
  /** Targets keyed by their normalised match, for both regex hits and exact lookups. */
  byMatch: Map<string, LinkTarget>;
  /**
   * The article being read. Its own names stay in the pattern so they claim
   * their text — "Espada de hierro" must not yield a link to Iron from its
   * last word — but they are never rendered as links.
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

/** A term as a regex alternative: literal, but tolerant of spacing and apostrophes. */
function termPattern(term: string): string {
  return term
    .split(' ')
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]"))
    .join('\\s+');
}

export function buildLinker(targets: LinkTarget[], options: { selfSlug?: string } = {}): Linker {
  const byMatch = new Map<string, LinkTarget>();

  for (const target of targets) {
    const key = normalizeTerm(target.match);
    if (key.length < MIN_TERM_LENGTH) continue;
    // A number is a value, never a name, whatever the wiki titled a page.
    if (/^[\d.,\s]+$/.test(key)) continue;
    if (!byMatch.has(key)) byMatch.set(key, target);
  }

  const selfSlug = options.selfSlug;
  if (byMatch.size === 0) return { pattern: null, byMatch, selfSlug };

  const alternatives = [...byMatch.keys()].sort((a, b) => b.length - a.length).map(termPattern);

  /*
   * Whole words only, and by Unicode letter rather than `\b`. The ASCII word
   * boundary treats an accented letter as punctuation, so `Jabalí\b` would
   * never match: there is no boundary between `í` and the space that follows
   * it. The lookarounds also keep "Wood" out of "Woodcutter" and "Especie"
   * out of "Especiero".
   */
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`,
    'giu',
  );

  return { pattern, byMatch, selfSlug };
}

/** The article a string names outright, or null: `Spice rack`, not `Spice rack and more`. */
export function exactTarget(linker: Linker, text: string): LinkTarget | null {
  const target = linker.byMatch.get(normalizeTerm(text));
  return target && target.slug !== linker.selfSlug ? target : null;
}

type Hit = { start: number; end: number; target: LinkTarget };

/** Every mention of a term in the text, in order, before any merging or deduplication. */
function findHits(text: string, linker: Linker): Hit[] {
  if (!linker.pattern || !text) return [];
  const hits: Hit[] = [];
  for (const found of text.matchAll(linker.pattern)) {
    const target = linker.byMatch.get(normalizeTerm(found[0]));
    if (target) hits.push({ start: found.index, end: found.index + found[0].length, target });
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
    if (hit.target.slug === linker.selfSlug || seen.has(hit.target.slug)) continue;
    seen.add(hit.target.slug);
    if (hit.start > cursor) segments.push({ text: text.slice(cursor, hit.start) });
    segments.push({
      text: text.slice(hit.start, hit.end),
      link: { slug: hit.target.slug, title: hit.target.title },
    });
    cursor = hit.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });

  return segments;
}

/**
 * Reconciles a name with the gloss that follows it.
 *
 * `Praderas (Meadows)`: both halves name the same article, so they become one
 * link rather than two.
 *
 * `Espectro gris bruto (Greydwarf brute)`: the gloss says what the phrase is,
 * and it is not a Wraith — but "Espectro" alone is the Wraith's Spanish name,
 * because two translations of the same creature did not agree. A hit that is
 * only the start of a phrase whose gloss names a different article is the
 * translator's wording, not a mention, and is dropped. The gloss keeps its
 * link.
 */
function mergeGlossed(text: string, hits: Hit[]): Hit[] {
  const out: Hit[] = [];
  for (const hit of hits) {
    const previous = out[out.length - 1];
    const glossed = previous && text[hit.start - 1] === '(' && text[hit.end] === ')';
    if (glossed) {
      const between = text.slice(previous.end, hit.start);
      if (previous.target.slug === hit.target.slug && /^\s*\(\s*$/.test(between)) {
        previous.end = hit.end + 1;
        continue;
      }
      // Words, but no punctuation, between the hit and the bracket: the hit
      // opens the phrase the gloss describes.
      if (/^[^\p{P}]*\p{L}[^\p{P}]*\(\s*$/u.test(between)) out.pop();
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
 * Every displayed string of a document, in a stable order.
 *
 * Recipe rows are left out: the recipe component resolves its own
 * ingredients, with pictures, and linking the same names a second way would
 * only disagree with it.
 */
function docStrings(doc: ArticleDoc): string[] {
  const out: string[] = [doc.lead];
  for (const block of doc.blocks) {
    if (block.kind === 'paragraph') out.push(block.text);
    else if (block.kind === 'list') out.push(...block.items);
    else out.push(...block.rows.flat());
  }
  for (const group of infoboxGroups(doc)) {
    for (const row of group.rows) if (!isRecipeLabel(row.label)) out.push(row.value);
  }
  return out;
}

function infoboxGroups(doc: ArticleDoc): InfoboxGroup[] {
  const box = doc.infobox;
  return box ? [...box.common, ...box.tabs.flatMap((tab) => tab.groups)] : [];
}

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
 */
export function collectArticleLinks({
  doc,
  source,
  index,
  selfSlug,
}: {
  /** The document as displayed: the translation when there is one. */
  doc: ArticleDoc;
  /** The English document it was made from. The same object when not translated. */
  source: ArticleDoc;
  index: LinkTarget[];
  selfSlug: string;
}): LinkTarget[] {
  const linker = buildLinker(index, { selfSlug });
  if (!linker.pattern) return [];

  const found = new Map<string, LinkTarget>();
  const add = (target: LinkTarget): void => {
    found.set(normalizeTerm(target.match), target);
  };

  const shown = docStrings(doc);
  const original = doc === source ? shown : docStrings(source);
  // A translation that no longer lines up with its source cannot be paired
  // by position: it would hand one item another item's link.
  const aligned = original.length === shown.length;

  shown.forEach((text, i) => {
    for (const hit of findHits(text, linker)) add(hit.target);

    // Already a term, so the regex finds it whole.
    if (exactTarget(linker, text)) return;

    const english = aligned ? original[i] : undefined;
    const gloss = splitGloss(text);
    const whole =
      (english ? exactTarget(linker, english) : null) ??
      (gloss ? exactTarget(linker, gloss.gloss) : null);
    if (whole) add({ match: text.trim(), slug: whole.slug, title: whole.title });
  });

  // Facets are English whatever the page's language; they are shown under the title.
  for (const value of Object.values(doc.facets)) {
    for (const hit of findHits(value, linker)) add(hit.target);
  }

  return [...found.values()];
}
