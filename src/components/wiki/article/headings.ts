/**
 * Where the article's section headings go, and at which level.
 *
 * Each block carries its section as a path ("Usage > Farming"). Printing only
 * the last segment, and only when the path changed, lost every parent that
 * had no text of its own — Ashlands showed "Hostile" and "Passive" with no
 * "Creatures" above them, and Barley showed two "Farming" headings, one under
 * Availability and one under Usage, with neither parent in sight — and it
 * made every heading an h2, so the outline was flat for everyone (BWR-08).
 *
 * Now each segment that differs from the previous block's path opens a
 * heading at its own depth: h2 for a section, h3 for a subsection, h4 below.
 *
 * Where the breaks fall is read from the English paths when a translation is
 * shown. The translation renders each block's section on its own, so two
 * blocks of one English section can come back as "Lápida (Tombstone)" and
 * then "Lápida"; compared as text they would repeat the heading. The English
 * decides the structure and the translation only supplies the words.
 */

export type SectionHeading = {
  /** 0 for a section, 1 for a subsection… */
  depth: number;
  text: string;
  /**
   * The words are the English segment, because the translated path did not
   * line up with it. Lets the page mark them as English.
   */
  english: boolean;
};

type Sectioned = { section: string };

function segments(path: string): string[] {
  return path
    .split(' > ')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** For each block, the headings to open before it (often none). */
export function sectionHeadings(shown: readonly Sectioned[], source?: readonly Sectioned[]): SectionHeading[][] {
  // A translation that reshaped the article cannot be paired by position;
  // its own paths are the best structure there is then.
  const structure = source && source.length === shown.length ? source : shown;
  let previous: string[] = [];

  return shown.map((block, i) => {
    const path = segments(structure[i]?.section ?? '');
    const words = segments(block.section);
    // The translated segments stand in only when they map one to one.
    const aligned = words.length === path.length;

    let first = 0;
    while (first < path.length && path[first] === previous[first]) first += 1;

    const out: SectionHeading[] = [];
    for (let depth = first; depth < path.length; depth += 1) {
      const translated = aligned ? words[depth] : undefined;
      out.push({
        depth,
        text: translated ?? path[depth] ?? '',
        english: structure !== shown && translated === undefined,
      });
    }
    previous = path;
    return out;
  });
}

/** The heading element for a depth: h2 for a section, never past h6. */
export function headingTag(depth: number): 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
  const level = Math.min(2 + Math.max(0, depth), 6);
  return `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
}
