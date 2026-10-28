import { fold } from '@/lib/wiki/slug';
import { matchGlossary, type Alternative } from './glossary';

/**
 * Stop words for query building.
 *
 * The `fts` column uses the `simple` text-search configuration so that Valheim
 * proper nouns survive intact (an English stemmer turns "Surtlings" into
 * "surtl" and "Yagluth" into a lexeme that no longer matches the article).
 * `simple` also means Postgres strips no stop words, so a bare OR query would
 * let "the" or "para" match the entire corpus. Filtering here is what pays for
 * that choice.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // English
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'get', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its', 'me', 'much', 'my', 'need', 'of',
  'on', 'or', 'that', 'the', 'this', 'to', 'use', 'was', 'what', 'when', 'where', 'which',
  'who', 'why', 'with', 'you', 'your',
  // Spanish
  'al', 'como', 'cómo', 'con', 'cual', 'cuál', 'cuando', 'cuándo', 'cuanto', 'cuánto',
  'cuantos', 'cuántos', 'de', 'del', 'donde', 'dónde', 'el', 'él',
  'ella', 'ellos', 'en', 'es', 'esta', 'está', 'este', 'éste', 'hace', 'hacer', 'hay',
  'la', 'las', 'lo',
  'los', 'mas', 'más', 'me', 'mi', 'necesito', 'no', 'para', 'por', 'que', 'qué', 'se',
  'si', 'sí', 'sirve',
  'sobre', 'son', 'su', 'sus', 'un', 'una', 'uno', 'y', 'yo',
  // Corpus-specific. Every document in this index is about Valheim, so the
  // word appears almost everywhere and discriminates nothing — asking "¿qué
  // hace la comida en Valheim?" retrieved the *Valheim* article instead of
  // *Food*. A term present in most documents is a stop word for that corpus,
  // whatever it means elsewhere.
  'valheim', 'wiki', 'game', 'juego', 'articulo', 'article', 'page', 'pagina',
]);

/**
 * Question verbs a reader types around the thing they want: "dónde encuentro
 * plata", "cómo consigo hierro". Stop words for the wiki's own search only;
 * the chat keeps them, because there they shape a sentence the model reads.
 */
const SEARCH_ONLY_STOP_WORDS = ['encuentro', 'encuentra', 'consigo', 'consigue', 'puedo', 'tengo', 'hago'];

/** The stop words folded, so "dónde" and "donde" are the same word. */
const FOLDED_STOP_WORDS: ReadonlySet<string> = new Set(
  [...STOP_WORDS, ...SEARCH_ONLY_STOP_WORDS].map(fold),
);

/** Whether a word, in any accenting, is a stop word. */
export function isStopWord(word: string): boolean {
  return FOLDED_STOP_WORDS.has(fold(word));
}

/** A term worth a lexeme: not a stop word, not one letter, not a bare level number. */
function meaningful(word: string): boolean {
  return word.length >= 2 && !isStopWord(word) && !/^\d{1,2}$/.test(word);
}

/**
 * Turns free text into a `websearch_to_tsquery` string.
 *
 * OR rather than AND: a five-word question rarely has all five words in the
 * chunk that answers it, and `ts_rank_cd` already rewards matching more terms.
 * `websearch_to_tsquery` never raises on malformed input, so no escaping
 * beyond stripping operators is required.
 *
 * `accents` (optional; see `accentIndex`) adds, for each term typed without
 * its accents, the accented spellings the index holds: the index keeps
 * accents, so "jormundling" or "mjolnir" otherwise match nothing in the
 * passages that say "Jörmundling" and "Mjölnir".
 */
export function buildTsQuery(text: string, accents?: AccentIndex): string {
  const terms = text
    .toLowerCase()
    // Keep letters (including accents), digits and internal hyphens.
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !/^\d{1,2}$/.test(t));

  // A very long OR query costs recall precision and index time for nothing.
  const unique = [...new Set(terms)].slice(0, 12);
  if (!accents) return unique.join(' or ');
  const spelled = unique.flatMap((term) => [term, ...(accents.get(fold(term)) ?? [])]);
  return [...new Set(spelled)].slice(0, 24).join(' or ');
}

/**
 * One word or phrase of a search, with everything it may match.
 *
 * The unit of OR. "espada de hierro" is two groups — (espada | sword) and
 * (hierro | iron) — and an article matches the query by matching groups,
 * not words: "horno" is (horno | kiln | smelter), and requiring both kiln and
 * smelter would demand that one article be both.
 */
export type QueryGroup = {
  /** The reader's words, folded: the Spanish side of the group. */
  words: string[];
  /** As typed (lowercased, accents kept), where that differs from `words`. */
  typed: string[];
  /** English names from the glossary; each alternative's words all required. */
  english: Alternative[];
  /**
   * The last word of a query, matched as a prefix because it may still be
   * being typed: "eikth" should find Eikthyr. Only for a word the glossary
   * did not translate — `mead:*` would bring in the Meadows — and of three
   * letters or more (`MIN_PREFIX`).
   */
  prefix: boolean;
};

/**
 * More groups than this make a query nobody types and a tsquery nobody needs.
 * Five covers every name in the wiki and the questions readers type around
 * one ("cómo invoco a eikthyr en las praderas" is three). It is also what
 * bounds a search's cost: each group is another index scan and another term
 * for every ranked passage, and the route is public.
 */
export const MAX_GROUPS = 5;

/**
 * The shortest last word matched as a prefix. "eik" is enough to mean
 * Eikthyr, while "ca:*" matches a word in nearly every passage and every
 * translation: the most expensive query there is, and one that tells the
 * reader nothing.
 */
const MIN_PREFIX = 3;

/**
 * Plans a reader's search: glossary phrases first, stop words out, one group
 * per remaining word or phrase.
 *
 * Folded throughout, so accents never decide a match; the as-typed form is
 * kept too, because the index keeps accents and "Jörmundling" is a lexeme.
 */
export function planSearch(text: string): QueryGroup[] {
  const groups: QueryGroup[] = [];
  const seen = new Set<string>();

  for (const match of matchGlossary(text)) {
    const words = match.words.map(fold).filter(meaningful);
    const english = (match.english ?? [])
      .map((alternative) => alternative.filter(meaningful))
      .filter((alternative) => alternative.length > 0);
    if (words.length === 0 && english.length === 0) continue;

    const key = words.join(' ') || english.map((a) => a.join(' ')).join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const typed = match.words.filter((w) => meaningful(fold(w)));
    groups.push({
      words,
      typed: typed.join(' ') === words.join(' ') ? [] : typed,
      english,
      prefix: false,
    });
  }

  const last = groups.at(-1);
  if (last && last.english.length === 0 && last.words.length === 1 && last.words[0]!.length >= MIN_PREFIX) {
    last.prefix = true;
  }
  return groups.slice(0, MAX_GROUPS);
}

/**
 * Accented spellings the index holds, by their folded form.
 *
 * The full-text columns keep accents (the chat's index must, for Valheim's
 * Old Norse names), so a reader who types "jormundling" or "nucleo" matches
 * nothing unless the query also carries "jörmundling" and "núcleo". The
 * corpus holds a few hundred accented words, so listing them once and adding
 * the right ones to each query folds the search without folding the index —
 * and the highlighting still marks the word as the page spells it.
 */
export type AccentIndex = ReadonlyMap<string, readonly string[]>;

export function accentIndex(words: readonly string[]): AccentIndex {
  const map = new Map<string, string[]>();
  for (const word of words) {
    const key = fold(word);
    if (key === word) continue;
    const list = map.get(key);
    if (list) {
      if (!list.includes(word)) list.push(word);
    } else {
      map.set(key, [word]);
    }
  }
  return map;
}

/**
 * Accented completions offered for a prefix: enough for a name, not a
 * dictionary. The index lists the most common words first
 * (`getSearchVocabulary`), so a short prefix gets the likeliest ones.
 */
const MAX_PREFIX_SPELLINGS = 6;

/** A lexeme as `to_tsquery` reads it: quoted, so nothing in it is an operator. */
function lexeme(word: string, prefix = false, weight = ''): string {
  // Words are letters and digits only (see `tokenize`), so a quote cannot occur.
  return `'${word}'${prefix ? `:*${weight}` : weight ? `:${weight}` : ''}`;
}

/** Every spelling of one folded word: itself, as typed, and the accented forms the index holds. */
function spellings(word: string, typed: string | undefined, prefix: boolean, accents: AccentIndex): string[] {
  const out = [lexeme(word, prefix)];
  if (typed && typed !== word) out.push(lexeme(typed, prefix));
  for (const accented of accents.get(word) ?? []) out.push(lexeme(accented));
  if (prefix) {
    let added = 0;
    for (const [key, forms] of accents) {
      if (added >= MAX_PREFIX_SPELLINGS) break;
      if (key === word || !key.startsWith(word)) continue;
      for (const form of forms) {
        out.push(lexeme(form));
        added += 1;
      }
    }
  }
  return [...new Set(out)];
}

/** `(a | b)`, or `a` alone: parentheses only where they change nothing but clarity. */
function either(parts: string[]): string {
  return parts.length === 1 ? parts[0]! : `(${parts.join(' | ')})`;
}

/** `(a & b)`, or `a` alone. */
function all(parts: string[]): string {
  return parts.length === 1 ? parts[0]! : `(${parts.join(' & ')})`;
}

/** A group as one tsquery operand: any of its alternatives. */
function groupOperand(group: QueryGroup, accents: AccentIndex, weight = ''): string {
  const reweigh = (operand: string): string =>
    weight ? operand.replace(/'([^']+)'(:\*)?/g, (_m, word: string, star?: string) => lexeme(word, Boolean(star), weight)) : operand;

  const alternatives: string[] = [];
  if (group.words.length === 1) {
    alternatives.push(...spellings(group.words[0]!, group.typed[0], group.prefix, accents));
  } else if (group.words.length > 1) {
    alternatives.push(
      all(group.words.map((word, i) => either(spellings(word, group.typed[i], group.prefix, accents)))),
    );
  }
  for (const alternative of group.english) alternatives.push(all(alternative.map((word) => lexeme(word))));
  return reweigh(either([...new Set(alternatives)]));
}

export type SearchTsQueries = {
  /** Any group: what a document must match to be a candidate at all. */
  any: string;
  /** Every group: an article that matches them all outranks one that matches some. */
  every: string;
  /** One query per group, restricted to title lexemes (weight A), for counting title hits. */
  titles: string[];
};

/**
 * The `to_tsquery` strings for a planned search, or null when nothing in it
 * can be searched for.
 *
 * OR to find candidates and the group counts to rank them, rather than AND:
 * the `simple` configuration does not stem, so "how to summon eikthyr" under
 * AND required "summon" and excluded the Eikthyr article, which only says
 * "summoned" and "summoning".
 */
export function searchTsQueries(groups: QueryGroup[], accents: AccentIndex = new Map()): SearchTsQueries | null {
  if (groups.length === 0) return null;
  const operands = groups.map((g) => groupOperand(g, accents));
  return {
    any: operands.join(' | '),
    every: operands.join(' & '),
    titles: groups.map((g) => groupOperand(g, accents, 'A')),
  };
}
