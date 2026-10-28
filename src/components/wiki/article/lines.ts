import type { Segment } from '@/lib/wiki/links';

/**
 * Strings that hold one entry per line, split for display.
 *
 * Kept apart from the components so the splitting — which has to agree with
 * how the server linked the whole string — is tested on its own.
 */

/** A line break in a string: at offset `at`, dropping `drop` characters (the `\n`, or a "; "). */
export type LineCut = { at: number; drop: number };

/**
 * Where a string breaks into lines.
 *
 * Its own `\n`s, always. Rows stored before the ingest kept line breaks
 * (parser v0, still most of the corpus until it is re-parsed) lost them, and
 * two shapes of that loss are unmistakable enough to undo for display:
 *
 * - `cell`: a table cell of quantities run together, "10 Wood15 Flint20
 *   Leather scraps" — a number straight after a letter or a bracket, where
 *   every piece is a number and a name. Anything else is left as it is:
 *   "Tier2", "x1.5", "1x + 1x + 2x".
 * - `value`: an infobox value whose entries were joined with "; " — "21 (0
 *   skill); 31.5 (100 skill)" — when every entry is short. A sentence with a
 *   semicolon in it stays a sentence.
 * - either: labelled amounts run together, "Pierce: 47/56Poison: 5/20" — a
 *   capital straight after a digit, where every piece is "Name: amount".
 */
export function lineCuts(text: string, repair?: 'cell' | 'value'): LineCut[] {
  const breaks = [...text.matchAll(/\n/g)].map((match) => ({ at: match.index, drop: 1 }));
  if (breaks.length > 0 || !repair) return breaks;

  const labelled = labelledAmounts(text);
  if (labelled.length > 0) return labelled;

  if (repair === 'cell') {
    if (!/^\d/.test(text.trim())) return [];
    const cuts = [...text.matchAll(/(?<![x×])(?<=[\p{Ll})])(?=\d)/gu)].map((match) => ({ at: match.index, drop: 0 }));
    if (cuts.length === 0) return [];
    const pieces = piecesOf(text, cuts);
    return pieces.every((piece) => /^\d+(?:[.,]\d+)?\s*\p{L}/u.test(piece)) ? cuts : [];
  }

  const cuts = [...text.matchAll(/;\s/g)].map((match) => ({ at: match.index, drop: match[0].length }));
  if (cuts.length === 0) return [];
  return piecesOf(text, cuts).every((piece) => piece.length > 0 && piece.length <= 40) ? cuts : [];
}

/** "Pierce: 47/56Poison: 5/20" → a cut before "Poison", when every piece is "Name: amount". */
function labelledAmounts(text: string): LineCut[] {
  const cuts = [...text.matchAll(/(?<=\d)(?=\p{Lu})/gu)].map((match) => ({ at: match.index, drop: 0 }));
  if (cuts.length === 0) return [];
  const label = /^\p{Lu}[^:\d]*:\s*[\d(+-]/u;
  return piecesOf(text, cuts).every((piece) => label.test(piece)) ? cuts : [];
}

export function piecesOf(text: string, cuts: readonly LineCut[]): string[] {
  const out: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    out.push(text.slice(from, cut.at).trim());
    from = cut.at + cut.drop;
  }
  out.push(text.slice(from).trim());
  return out;
}

/**
 * Splits linked text into lines at the given cuts. The text is linked whole
 * first and split after, so a name is matched against the string it lives
 * in — which is what the server's link restrictions are keyed by — and a link
 * that happens to span a break is cut into two links to the same article.
 */
export function splitSegments(segments: readonly Segment[], cuts: readonly LineCut[]): Segment[][] {
  const out: Segment[][] = [[]];
  let offset = 0;
  let next = 0;

  for (const segment of segments) {
    let start = 0;
    const end = segment.text.length;
    while (next < cuts.length && cuts[next]!.at < offset + end) {
      const cut = cuts[next]!;
      const local = cut.at - offset;
      if (local > start) push(out, segment, segment.text.slice(start, local));
      out.push([]);
      start = Math.min(end, local + cut.drop);
      next += 1;
    }
    if (start < end) push(out, segment, segment.text.slice(start));
    offset += end;
  }

  return out.map((line) => trimLine(line)).filter((line) => line.length > 0);
}

function push(lines: Segment[][], segment: Segment, text: string): void {
  if (text) lines[lines.length - 1]!.push(segment.link ? { text, link: segment.link } : { text });
}

/** Splits linked text at its own line breaks ("10 Wood\n15 Flint"). */
export function segmentLines(segments: readonly Segment[]): Segment[][] {
  return splitSegments(segments, lineCuts(segments.map((segment) => segment.text).join('')));
}

/** Drops the spaces a line break leaves at either end of a line. */
function trimLine(line: Segment[]): Segment[] {
  const out = line.map((segment) => ({ ...segment }));
  const first = out[0];
  if (first && !first.link) first.text = first.text.replace(/^\s+/, '');
  const last = out[out.length - 1];
  if (last && !last.link) last.text = last.text.replace(/\s+$/, '');
  return out.filter((segment) => segment.text.length > 0);
}

/**
 * Whether a linked run is a mention of its article at all. A mention is the
 * name, perhaps with its gloss: "Madera (Wood)". A list item an older ingest
 * ran together — "Construcción: Bosque negro Fragua … Poste de farol dvergr
 * (Dvergr lantern pole)" — can end in a gloss and be claimed whole for that
 * one article; underlined from end to end it reads as one link to the last
 * thing in the list. Far longer than the name it stands for, it stays text.
 */
export function isMention(segment: Segment): boolean {
  return !segment.link || segment.text.length <= segment.link.title.length * 2 + 12;
}
