/**
 * Reads a crafting-materials string into the ingredients it names.
 *
 * The wiki states a recipe as one line — `Finewood x10; Bronze x3` — which is
 * accurate and useless: a reader who does not already know what Finewood is
 * gets no picture of it and no way to find out. Splitting the line into named
 * quantities is what lets each one become an icon and a link.
 *
 * Translated articles carry the English alongside — `Madera (Wood) x10` — and
 * that parenthetical is what makes lookup work at all. The index is English,
 * so the Spanish name would find nothing; the English in brackets is both the
 * reader's cross-reference and the key this needs.
 */

export type Ingredient = {
  /** What the reader sees: the name in the language the article is in. */
  readonly display: string;
  /** What the index is searched by: always the English name. */
  readonly lookup: string;
  readonly quantity: number;
};

/**
 * `Name x10`, `Name (English) x3`, `Mead base: Anti-sting x1`.
 *
 * The name is everything before the final `x<number>`, taken lazily so a name
 * containing its own `x` — and a few do — does not split in the middle.
 */
const ENTRY = /^(.*?)\s*[x×]\s*(\d+)$/i;

/** `Madera (Wood)` — the reader's word, then the one the wiki uses. */
const GLOSSED = /^(.*?)\s*\(([^()]+)\)$/;

/**
 * `Crafts 5Black marble` — the yield, run into the first ingredient.
 *
 * One article on this wiki states how many the recipe produces and loses the
 * separator doing it. Stripping the prefix is the difference between an
 * ingredient that resolves to an article and one that reads as a typo.
 */
const YIELD_PREFIX = /^Crafts\s*\d+(?=[A-Z])/;

export function parseRecipe(value: string): Ingredient[] {
  const out: Ingredient[] = [];

  for (const part of value.replace(YIELD_PREFIX, '').split(';')) {
    const entry = ENTRY.exec(part.trim());
    if (!entry) continue;

    const name = (entry[1] ?? '').trim();
    const quantity = Number(entry[2]);
    if (!name || !Number.isFinite(quantity)) continue;

    const glossed = GLOSSED.exec(name);
    out.push(
      glossed
        ? { display: (glossed[1] ?? '').trim(), lookup: (glossed[2] ?? '').trim(), quantity }
        : { display: name, lookup: name, quantity },
    );
  }

  return out;
}

/**
 * The key an ingredient is matched by.
 *
 * Case and trailing plurals both vary between how a recipe names a material
 * and how its article is titled — `Leather scraps` against `Leather Scraps`,
 * `Iron nails` against `Iron Nails`. Neither difference means anything to a
 * reader, so neither should decide whether they get a link.
 */
export function ingredientKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Whether an infobox row is a recipe rather than a stat.
 *
 * Matched on the label in both languages, because a translated article says
 * "Materiales de fabricación" and the row is the same row. Anything else in
 * the infobox stays a labelled value: a recipe is the only row whose parts are
 * separately findable things.
 */
const RECIPE_LABEL = /^(crafting materials|materiales de fabricaci[óo]n|materials)$/i;

export function isRecipeLabel(label: string): boolean {
  return RECIPE_LABEL.test(label.trim());
}

/** Every ingredient named across an article's infobox, for one batched lookup. */
export function recipeLookups(groups: { rows: { label: string; value: string }[] }[]): string[] {
  const names: string[] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      if (!isRecipeLabel(row.label)) continue;
      for (const ingredient of parseRecipe(row.value)) names.push(ingredient.lookup);
    }
  }
  return names;
}
