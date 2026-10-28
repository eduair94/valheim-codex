import { BROWSE_COPY } from '@/lib/i18n/browse-copy';
import type { Lang } from '@/lib/i18n/strings';
import { hasTermLabel, termLabel, type TermKind } from '@/lib/i18n/terms';

/**
 * Small pure helpers the browse tiles, the category list and the compare view
 * share. Pure so they can be tested without a page around them.
 */

/** A count in the reader's number format: "1027" in Spanish, "1,027" in English. */
export function formatCount(n: number, lang: Lang): string {
  return new Intl.NumberFormat(lang).format(n);
}

/**
 * "1 artículo", "24 artículos". The page used to glue the number to a plural
 * noun, so a biome with one article read "1 artículos".
 */
export function countLabel(n: number, lang: Lang): string {
  // The browse tiles count inside the search, in the browser: `BROWSE_COPY`, not the table.
  const t = BROWSE_COPY[lang];
  const one = new Intl.PluralRules(lang).select(n) === 'one';
  return (one ? t.wikiCountOne : t.wikiCountMany).replace('{n}', formatCount(n, lang));
}

/** The parts of a browse filter, as the category page reads them. */
export type FilterParts = { category?: string; biome?: string; station?: string; type?: string };

/** Which way in a filter is, for the kicker over its title; null when it is several. */
export function filterAxis(filter: FilterParts): 'category' | 'biome' | 'station' | 'type' | null {
  const axes = (['category', 'biome', 'station', 'type'] as const).filter((axis) => filter[axis]);
  return axes.length === 1 ? (axes[0] ?? null) : null;
}

/**
 * The title of a filtered list, part by part: the display name of each part
 * of the filter, with whether it is still the English value (no Spanish name
 * for it yet), so the page can mark that part `lang="en"`.
 */
export function headingParts(
  filter: FilterParts,
  lang: Lang,
): { text: string; english: string; untranslated: boolean }[] {
  const parts: { text: string; english: string; untranslated: boolean }[] = [];
  for (const axis of ['category', 'biome', 'station', 'type'] as const) {
    const value = filter[axis];
    if (!value) continue;
    const kind: TermKind = axis;
    parts.push({
      text: termLabel(kind, value, lang),
      english: value,
      untranslated: lang !== 'en' && !hasTermLabel(kind, value),
    });
  }
  return parts;
}

/**
 * The facets under a list row whose article has no lead, by their display
 * names: "Espada · Forja" rather than "Sword · Forge".
 */
export function facetLine(facets: Record<string, string>, lang: Lang): string {
  return Object.entries(facets)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) =>
      key === 'biome' || key === 'station' || key === 'type' ? termLabel(key, value, lang) : value,
    )
    .join(' · ');
}
