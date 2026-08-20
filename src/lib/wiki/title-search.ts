import type { TitleIndexEntry } from '@/lib/db/wiki-repo';

export type TitleMatch = {
  entry: TitleIndexEntry;
  score: number;
};

/**
 * Accent- and case-insensitive normalisation.
 *
 * Someone typing on a phone will not reach for accents, so "nucleo" has to
 * find "Núcleo". Folding both sides is cheaper and more predictable than
 * per-character fuzzy matching.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Ranks title-index entries against a query.
 *
 * Runs in the browser over about a thousand entries, on every keystroke, so it
 * stays a single linear pass with cheap string tests — no index building, no
 * edit distance. The scoring is ordinal rather than tuned: an exact title beats
 * a prefix, a prefix beats a word start, a word start beats a substring, and a
 * category match is the last resort.
 */
export function searchTitles(
  index: TitleIndexEntry[],
  query: string,
  limit = 30,
): TitleMatch[] {
  const q = fold(query.trim());
  if (!q) return [];

  const terms = q.split(/\s+/).filter(Boolean);
  const matches: TitleMatch[] = [];

  for (const entry of index) {
    const title = fold(entry.t);

    let score = 0;
    if (title === q) score = 1000;
    else if (title.startsWith(q)) score = 800 - title.length;
    else if (startsWord(title, q)) score = 600 - title.length;
    else if (title.includes(q)) score = 400 - title.length;
    else if (terms.length > 1 && terms.every((t) => title.includes(t))) score = 300 - title.length;
    else {
      // Falling back to categories lets "armas" surface every weapon even
      // though no title contains that word.
      const inCategory = entry.c.some((c) => fold(c).includes(q));
      const inType = entry.y !== undefined && fold(entry.y).includes(q);
      if (inCategory || inType) score = 150 - title.length;
    }

    if (score > 0) matches.push({ entry, score });
  }

  return matches
    .sort((a, b) => b.score - a.score || a.entry.t.localeCompare(b.entry.t))
    .slice(0, limit);
}

/** Whether any word in `text` starts with `prefix`. */
function startsWord(text: string, prefix: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(prefix, from);
    if (at === -1) return false;
    if (at === 0 || /[\s(-]/.test(text[at - 1] ?? '')) return true;
    from = at + 1;
  }
}
