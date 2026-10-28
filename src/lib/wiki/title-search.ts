import type { TitleIndexEntry } from '@/lib/db/wiki-repo';
import { termNames } from '@/lib/i18n/terms';
import { matchGlossary } from '@/lib/rag/glossary';
import { fold } from './slug';

export { fold };

export type TitleMatch = {
  entry: TitleIndexEntry;
  score: number;
};

/**
 * Title search, run in the browser on every keystroke.
 *
 * An article answers to its English title, its Spanish name (`e`, from the
 * stored translation) and any other Spanish names readers use for it (`a`):
 * Spanish is the default language and the game shows Spanish players Spanish
 * names, so "espada de hierro" has to find Iron Sword without the reader
 * knowing it is called that anywhere else. A second pass reads the query
 * through the glossary ("hierro" → iron), which reaches the articles that
 * have no translation yet.
 *
 * The scoring is ordinal rather than tuned: an exact name beats a prefix, a
 * prefix beats every word starting a word of the name, which beats every
 * word starting a word of one of its names or another (a query half in each
 * language), which beats the English title merely containing the words, and
 * a category match is the last resort. Each tier is a real difference in how
 * sure the match is.
 */

/**
 * Where nearly every article picture lives. The search index sends icons
 * relative to it: the full URL is 111 characters on average and was 59% of
 * the whole payload.
 */
const ICON_ROOT = 'https://static.wikia.nocookie.net/valheim/images/';

/** `b/b6/Black_Metal_Axe.png/revision/latest?cb=…` → `b/b6/Black_Metal_Axe.png?cb=…`. */
const ICON_PATH = /^https:\/\/static\.wikia\.nocookie\.net\/valheim\/images\/([^?#]+?)\/revision\/latest(?:\/scale-to-width-down\/\d+)?(\?cb=\d+)?$/;

/**
 * An icon URL as the search index sends it: a path under the image root,
 * without the resizing segment the page asks for on its own. Null for
 * anything that is not a picture of the thing — a handful of articles' first
 * image is a rendered maths formula.
 */
export function compactIcon(url: string): string | null {
  const match = ICON_PATH.exec(url);
  if (match) return `${match[1]}${match[2] ?? ''}`;
  return url.startsWith(ICON_ROOT) ? url : null;
}

/** The URL for an icon from either index: full URLs pass through, paths are rebuilt. */
export function expandIcon(icon: string): string {
  if (/^https?:\/\//.test(icon)) return icon;
  const [path, query] = icon.split('?');
  return `${ICON_ROOT}${path}/revision/latest${query ? `?${query}` : ''}`;
}

/** One entry, folded and split once per index load instead of once per keystroke. */
type PreparedEntry = {
  entry: TitleIndexEntry;
  /** Every name, folded: the English title first, then the Spanish ones. */
  names: string[];
  /** The words of each name, stemmed, for word-prefix matching. */
  words: string[][];
  /** The words of all the names together, when there is more than one name. */
  anyName: string[] | null;
  /** The English title's words, for the single-term fallback. */
  title: string;
  /** Category and type names in both languages, folded and stemmed. */
  groups: string[][];
};

/** An index ready to search. Build it with `prepareTitleIndex` once per download. */
export type PreparedTitleIndex = { readonly prepared: readonly PreparedEntry[] };

/**
 * Articles and prepositions, dropped from a title query when they sit between
 * real words: "espada de hierro" is the two words that matter. Small on
 * purpose — "valheim" or "game" are words in titles, whatever they are to the
 * chat.
 */
const TITLE_STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'lo', 'de', 'del', 'al', 'a', 'en', 'y', 'o', 'un', 'una', 'unos', 'unas',
  'con', 'por', 'para',
  'the', 'of', 'an', 'and', 'or', 'in', 'on', 'for', 'to', 'with',
]);

/** Words, as both sides split them. */
function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
}

/**
 * The plural a reader may or may not type: "trophy" for Trophies, "espada"
 * for Espadas. Light on purpose — a stemmer that knew more would also merge
 * names that are not the same thing.
 */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ces')) return `${word.slice(0, -3)}z`;
  if (word.length > 4 && /[^aeiou]es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Folds an index once. A thousand entries take a few milliseconds. */
export function prepareTitleIndex(index: TitleIndexEntry[]): PreparedTitleIndex {
  return {
    prepared: index.map((entry) => {
      const names = [...new Set([entry.t, ...(entry.e ? [entry.e] : []), ...(entry.a ?? [])].map(fold))];
      const kinds = [
        ...entry.c.flatMap((c) => [c, ...termNames('category', c)]),
        ...(entry.y ? [entry.y, ...termNames('type', entry.y)] : []),
      ];
      const nameWords = names.map((name) => words(name).map(stem));
      return {
        entry,
        names,
        words: nameWords,
        anyName: nameWords.length > 1 ? nameWords.flat() : null,
        title: fold(entry.t),
        groups: [...new Set(kinds.map(fold))].map((name) => words(name).map(stem)),
      };
    }),
  };
}

/**
 * Whether every term starts a word of the name, allowing for a plural on
 * either side — or, for a glossary reading, is a whole word of it.
 */
function everyTermStartsAWord(nameWords: string[], variant: Variant): boolean {
  const { terms, stems, whole } = variant;
  for (let t = 0; t < terms.length; t += 1) {
    const term = terms[t]!;
    const stemmed = stems[t]!;
    let found = false;
    for (const w of nameWords) {
      if (whole ? w === term || w === stemmed : w.startsWith(term) || w.startsWith(stemmed)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * One reading of the query; `stems` are the terms' singulars, worked out once
 * per search.
 *
 * `whole` marks a reading the glossary produced. The reader typed "murciélago",
 * not "bat", so nothing is still being typed and a prefix means nothing: read
 * as one, "bat" put Battleaxe, Battering Ram and the Spanish "Batido de cieno"
 * right under the Bat, "bee" put Beech above the Beehive, "raft" found
 * Crafting. A glossary reading therefore matches whole words of the English
 * title, and nothing else.
 */
type Variant = { query: string; terms: string[]; stems: string[]; penalty: number; whole: boolean };

function variant(terms: string[], penalty: number, whole = false): Variant {
  return { query: terms.join(' '), terms, stems: terms.map(stem), penalty, whole };
}

/**
 * The query's terms: words, minus articles and prepositions between them.
 *
 * Never the last word, which may still be being typed ("de" is how "Deer"
 * starts), and never every word — "de la" alone is still a search.
 */
function contentTerms(all: string[]): string[] {
  const kept = all.filter((word, i) => i === all.length - 1 || !TITLE_STOP_WORDS.has(word));
  return kept.length > 0 ? kept : all;
}

/**
 * The query as typed, and as the glossary reads it.
 *
 * The translated reading is scored a little lower, so an article whose own
 * name matches what was typed comes before one that only matches the
 * translation. Words with two readings ("horno" is a kiln or a smelter) give
 * a reading for each.
 */
function variants(query: string): Variant[] {
  const typed = contentTerms(words(fold(query)));
  if (typed.length === 0) return [];
  const out: Variant[] = [variant(typed, 0)];

  const matches = matchGlossary(query);
  if (!matches.some((m) => m.english)) return out;

  const readings = Math.max(...matches.map((m) => m.english?.length ?? 1));
  for (let k = 0; k < Math.min(readings, 2); k += 1) {
    const translated = contentTerms(
      matches.flatMap((m) => (m.english ? [...(m.english[k] ?? m.english[0]!)] : m.words.map(fold))),
    );
    if (translated.length > 0 && !out.some((v) => v.query === translated.join(' '))) {
      out.push(variant(translated, 50, true));
    }
  }
  return out;
}

/** The best tier one name reaches for one reading of the query; 0 when it reaches none. */
function scoreName(name: string, nameWords: string[], reading: Variant): number {
  if (name === reading.query) return 1000;
  if (!reading.whole && name.startsWith(reading.query)) return 800 - name.length;
  if (everyTermStartsAWord(nameWords, reading)) return (reading.terms.length === 1 ? 600 : 500) - name.length;
  return 0;
}

/**
 * Indexes already prepared for a raw array, so a caller that passes the same
 * array on every keystroke pays for the folding once.
 */
const preparedFor = new WeakMap<TitleIndexEntry[], PreparedTitleIndex>();

/**
 * Ranks title-index entries against a query.
 *
 * Takes the raw index too; the prepared form is kept for that array, so
 * searching it again costs only the search.
 */
export function searchTitles(
  index: TitleIndexEntry[] | PreparedTitleIndex,
  query: string,
  limit = 30,
): TitleMatch[] {
  if (!query.trim()) return [];
  let source: PreparedTitleIndex;
  if (Array.isArray(index)) {
    source = preparedFor.get(index) ?? prepareTitleIndex(index);
    preparedFor.set(index, source);
  } else {
    source = index;
  }
  const readings = variants(query);
  if (readings.length === 0) return [];

  const matches: (TitleMatch & { key: string })[] = [];
  for (const item of source.prepared) {
    let best = 0;
    for (const reading of readings) {
      // A glossary reading is English, so only the English title (the first
      // name) can answer it.
      const names = reading.whole ? 1 : item.names.length;
      let score = 0;
      for (let n = 0; n < names; n += 1) {
        score = Math.max(score, scoreName(item.names[n]!, item.words[n]!, reading));
      }

      // Every word typed starts a word of some name, though no one name has
      // them all: "ojo de greydwarf" is half the Spanish name ("Ojo de trasgo
      // gris") and half the English one ("Greydwarf eye"), as readers mix
      // them — the Greydwarf itself has no Spanish name. Below a single name
      // holding every word, above a title merely containing them, and well
      // above the fallback that offered the Greydwarf first, on Enter too.
      if (score === 0 && !reading.whole && reading.terms.length > 1 && item.anyName && everyTermStartsAWord(item.anyName, reading)) {
        score = 450 - item.title.length;
      }

      // The English title merely containing the words: "dwarf" is in every
      // Greydwarf, "mass" in Bonemass. Below every word-start match, so
      // "arco" puts Arcos first and Charcoal last rather than not at all.
      // Never for a glossary reading: "house" is inside Lighthouse.
      if (score === 0 && !reading.whole && reading.terms.every((term) => item.title.includes(term))) {
        score = (reading.terms.length === 1 ? 400 : 300) - item.title.length;
      }

      // A category or type, in either language: "armas" lists the weapons.
      if (score === 0 && item.groups.some((group) => everyTermStartsAWord(group, reading))) {
        score = 150 - item.title.length;
      }

      if (score > 0) best = Math.max(best, score - reading.penalty);
    }

    // A longer query whose words include a whole name: "carne de jabalí"
    // still offers the boar itself, below the boar meat.
    if (best === 0 && readings.some((v) => v.terms.length > 1 && v.terms.some((term) => item.names.includes(term)))) {
      best = 200 - item.title.length;
    }

    if (best > 0) matches.push({ entry: item.entry, score: best, key: item.title });
  }

  // Ties broken on the folded title: alphabetical for these names, and a
  // plain comparison, which matters when a one-letter query matches all of them.
  matches.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return matches.slice(0, limit).map(({ entry, score }) => ({ entry, score }));
}
