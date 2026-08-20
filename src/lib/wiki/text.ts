/**
 * Normalises text pulled out of MediaWiki HTML.
 *
 * Fandom output is full of non-breaking spaces, edit-section markers and the
 * indentation of its templates; without this every extracted value carries
 * ragged whitespace into the embeddings and into citations.
 */
export function cleanText(input: string): string {
  return stripTags(input)
    .replace(/ /g, ' ')
    .replace(/​/g, '')
    .replace(/\[\s*edit\s*(\|\s*edit source\s*)?\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same as {@link cleanText} but keeps paragraph breaks. */
export function cleanBlockText(input: string): string {
  return stripTags(input)
    .replace(/ /g, ' ')
    .replace(/​/g, '')
    .replace(/\[\s*edit\s*(\|\s*edit source\s*)?\]/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Removes anything shaped like an HTML tag.
 *
 * A safety net, not the primary defence: `<noscript>` content reaches us as
 * *text* rather than markup, so a stray `<img …>` string can survive element
 * removal and land in an article paragraph. The pattern requires a letter
 * after the bracket, so prose like "damage < 50" is untouched.
 */
function stripTags(input: string): string {
  return input.replace(/<\/?[a-z][^>]*>/gi, '');
}

/**
 * Rough token estimate.
 *
 * Real tokenisation would mean shipping a tokeniser for a model whose
 * vocabulary is not public; chunk sizing only needs to be in the right
 * ballpark, and ~4 characters per token holds well enough for English wiki
 * prose. Deliberately an estimate, and named as one.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Stable short hash used to detect unchanged chunks between ingests. */
export function hashContent(text: string): string {
  // FNV-1a, 64-bit, expressed with BigInt: dependency-free and enough for
  // change detection (not a security primitive).
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}
