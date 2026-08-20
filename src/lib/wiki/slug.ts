/**
 * URL slug for an article title.
 *
 * Accents are folded rather than escaped so the address bar shows
 * `/wiki/nucleos-de-surtling` instead of percent-encoded noise, and so a slug
 * typed by hand still resolves.
 */
export function slugify(title: string): string {
  const folded = title
    .normalize('NFD')
    // Strip combining marks: "Ásmund" -> "Asmund".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');

  // A title of only punctuation would otherwise produce an empty path segment.
  return slug || 'article';
}
