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
const STOP_WORDS = new Set([
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
 * Turns free text into a `websearch_to_tsquery` string.
 *
 * OR rather than AND: a five-word question rarely has all five words in the
 * chunk that answers it, and `ts_rank_cd` already rewards matching more terms.
 * `websearch_to_tsquery` never raises on malformed input, so no escaping
 * beyond stripping operators is required.
 */
export function buildTsQuery(text: string): string {
  const terms = text
    .toLowerCase()
    // Keep letters (including accents), digits and internal hyphens.
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !/^\d{1,2}$/.test(t));

  const unique = [...new Set(terms)];
  // A very long OR query costs recall precision and index time for nothing.
  return unique.slice(0, 12).join(' or ');
}
