/**
 * Accent- and case-insensitive normalisation.
 *
 * Someone typing on a phone will not reach for accents, so "nucleo" has to
 * find "Núcleo" and "jormundling" has to find "Jörmundling". Folding both
 * sides is cheaper and more predictable than per-character fuzzy matching.
 *
 * NFD splits a letter from its accent so the accent can be dropped; `ñ`
 * folds to `n` the same way, which is what a keyboard without it produces.
 * Letters that are not a base plus a mark (`ø`, `æ`, `ß`) stay as they are.
 *
 * One definition for the slug, the title search, the glossary and the content
 * search, so the four can never disagree about what two spellings have in
 * common.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    // Strip combining marks: "Ásmund" -> "Asmund".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * URL slug for an article title.
 *
 * Accents are folded rather than escaped so the address bar shows
 * `/wiki/nucleos-de-surtling` instead of percent-encoded noise, and so a slug
 * typed by hand still resolves.
 */
export function slugify(title: string): string {
  const slug = fold(title)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');

  // A title of only punctuation would otherwise produce an empty path segment.
  return slug || 'article';
}

/**
 * Whether a string has the shape `slugify` gives every slug: lowercase
 * letters and digits in hyphen-separated runs, at most 80 characters.
 *
 * Anything else names no article, so a page can answer "not found" without
 * asking the database or leaving an entry in the data cache.
 */
export function isSlug(text: string): boolean {
  return text.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text);
}
