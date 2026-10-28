/**
 * Reads a crafting-materials string into the ingredients it names.
 *
 * The wiki states a recipe as a list of entries — `Finewood x10`, `Bronze x3`
 * — which is accurate and useless: a reader who does not already know what
 * Finewood is gets no picture of it and no way to find out. Splitting it into
 * named quantities is what lets each one become an icon and a link.
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

/** One material of a recipe, named as the cell names it: `Leather scraps`, 3. */
export type RecipeEntry = { name: string; qty: number };

/**
 * A recipe cell read in full: the materials, how many one craft makes when
 * the wiki says ("Crafts 20"), and every line that was neither, kept as
 * written.
 *
 * The notes are the point of the shape. A line this cannot read is not
 * dropped and not guessed at: the extractor hands it on, and the recipe
 * graph's report puts it in front of whoever maintains the overrides. A
 * quietly missing material is a shopping list that comes up short at the
 * workbench.
 */
export type RecipeCell = { entries: RecipeEntry[]; yield: number | null; notes: string[] };

/**
 * `Name x10`, `Name (English) x3`, `Mead base: Anti-sting x1`, `Deer hide x 5`.
 *
 * The name is everything before the final `x<number>`, taken lazily so a name
 * containing its own `x` — and a few do — does not split in the middle.
 */
const ENTRY = /^(.*?)\s*[x×]\s*(\d+)$/i;

/**
 * `5 Bronze`, `10Bone fragments`: the quantity first, which is how every
 * armor set writes its pieces' costs.
 *
 * The space is optional because the Troll hide cape's cell runs the number
 * into the link (`10<a>Bone fragments</a>`), and that is still ten bone
 * fragments. The name has to start with a letter, so a bare number or a
 * "3x" is never a material, and not with an "x": "2 x Wood" is two Wood,
 * but "2xWood" may as well be two of something called "xWood".
 */
const QUANTITY_FIRST = /^(\d+)\s*(?:[x×]\s+)?(?![x×])(\p{L}.*)$/iu;

/** `Madera (Wood)` — the reader's word, then the one the wiki uses. */
const GLOSSED = /^(.*?)\s*\(([^()]+)\)$/;

/**
 * `Crafts 20`: how many one craft makes, in a line of its own or in bold
 * before the list (`<b>Crafts 20</b><ul>…`). A translated article says it
 * with its own verb: the stored Spanish Ceramic plate reads "Fabrica 5", and
 * the others are the verbs a translation of "Crafts" comes out as. No
 * material's name begins with one of them and a number.
 *
 * Rows stored before values kept their lines run it into the first entry —
 * `Crafts 5Black marble x5`, `Fabrica 5Mármol negro x5` — so what follows the
 * number on the same line is read again as a line of its own.
 */
const YIELD = /^(?:crafts|fabrica|crea|produce|rinde|elabora)\s*[x×]?\s*(\d+)/i;

/** What the wiki writes in a recipe cell for "none": "n/a", "N/A", "nil", "-". */
const NOTHING = /^(n\/?a|nil|none|-+|—|–)$/i;

/**
 * Entries are one per line (`Finewood x10\nBronze x3`) since infobox values
 * kept their line breaks; rows stored before that, and translations made from
 * them, join entries with "; ". Both are read.
 */
const SEPARATOR = /[;\n]/;

/**
 * Whether a name is one: some letters, not a heading for the lines below it
 * ("Small:", Yuleklapp's three sizes in one cell), and no number in it. No
 * material's name has one; a number in a name is another count run into it.
 * Read lazily, "Pot shard x3, x4" is 4 of something called "Pot shard x3,",
 * and "5 Bronze (or 10 Copper)" is 5 of "Bronze (or 10 Copper)": materials
 * nobody can find, and counts nobody stated.
 */
function isName(name: string): boolean {
  return /\p{L}/u.test(name) && !/^[x×]$/i.test(name) && !/\d/.test(name) && !/[,;:]$/.test(name);
}

/**
 * Whether a quantity is a count of something: a whole number from one up,
 * small enough to be exact. None of a material is no material, and a craft
 * that takes none of it would have the planner divide by zero.
 */
function isCount(qty: number): boolean {
  return Number.isSafeInteger(qty) && qty >= 1;
}

/** A material, when its name is one and its quantity a count. */
function toEntry(name: string | undefined, qty: string | undefined): RecipeEntry | null {
  const text = (name ?? '').trim().replace(/\s+/g, ' ');
  const count = Number(qty);
  return isName(text) && isCount(count) ? { name: text, qty: count } : null;
}

/** One line of a cell as a material, or null when it is not one. */
function readEntry(line: string): RecipeEntry | null {
  const named = ENTRY.exec(line);
  if (named) return toEntry(named[1], named[2]);
  const counted = QUANTITY_FIRST.exec(line);
  return counted ? toEntry(counted[2], counted[1]) : null;
}

/**
 * Reads a recipe cell, `Crafts 20\nBronze x1` or `5 Bronze\n2 Deer hide`.
 *
 * Each line is a yield, a material in either order, one of the wiki's ways
 * of writing "none", or a note. Nothing is invented to fill a gap: a line
 * that says something else stays a note, and a cell of notes has no entries.
 */
export function parseRecipeCell(value: string): RecipeCell {
  const cell: RecipeCell = { entries: [], yield: null, notes: [] };

  for (const raw of value.split(SEPARATOR)) {
    const line = raw.trim();
    if (!line || NOTHING.test(line)) continue;

    let rest = line;
    const stated = YIELD.exec(line);
    if (stated) {
      const amount = Number(stated[1]);
      // Two different yields in one cell cannot both be true. The first
      // stands, as it did when only one was ever read, and the other is
      // left where the report will show it.
      if (cell.yield !== null && cell.yield !== amount) {
        cell.notes.push(line);
        continue;
      }
      cell.yield = amount;
      rest = line.slice(stated[0].length).trim();
      if (!rest) continue;
    }

    const entry = readEntry(rest);
    if (entry) cell.entries.push(entry);
    else cell.notes.push(rest);
  }

  return cell;
}

/** `(Requires Stonecutter)`: a remark about the recipe, in brackets, not a part of it. */
const REMARK = /^\(.*\)$/;

/**
 * Whether a cell's entries are its whole recipe: whatever else it says is a
 * remark in brackets.
 *
 * Any other line is a material nobody could read ("Pot shard x3, x4, x5",
 * one count per size of pot) or a heading over a group of them ("Small:"
 * on the Yuleklapp, one of three sizes), and the entries without it are
 * part of a recipe: one Charcoal resin for a pot, with no shards. Part of a
 * recipe is a shopping list that comes up short, so it counts as none.
 */
export function isWholeRecipe(cell: Pick<RecipeCell, 'notes'>): boolean {
  return cell.notes.every((note) => REMARK.test(note));
}

/**
 * The materials of a recipe cell for the article page: the cell's entries,
 * with a translated name split into the reader's word and the English the
 * index is searched by. The yield, read in either language, is no material
 * and has no tile.
 *
 * None when they are not the whole recipe (`isWholeRecipe`): the page then
 * shows the cell as the wiki wrote it, all three pot sizes, rather than a
 * tile of resin, and a line it cannot read ("Bronze 3") rather than tiles
 * of the other materials alone.
 */
export function parseRecipe(value: string): Ingredient[] {
  const cell = parseRecipeCell(value);
  if (!isWholeRecipe(cell)) return [];
  return cell.entries.map(({ name, qty }) => {
    const glossed = GLOSSED.exec(name);
    return glossed
      ? { display: (glossed[1] ?? '').trim(), lookup: (glossed[2] ?? '').trim(), quantity: qty }
      : { display: name, lookup: name, quantity: qty };
  });
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
const RECIPE_LABEL =
  /^(crafting materials|materials|materiales( de (fabricaci[óo]n|artesan[ií]a|elaboraci[óo]n|creaci[óo]n|crafteo))?)$/i;

export function isRecipeLabel(label: string): boolean {
  return RECIPE_LABEL.test(label.trim());
}

type RowLike = { label: string; value: string };
type GroupLike = { rows: RowLike[] };

/** Every ingredient named across an article's infobox, for one batched lookup. */
export function recipeLookups(groups: GroupLike[]): string[] {
  const names: string[] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      if (!isRecipeLabel(row.label)) continue;
      for (const ingredient of parseRecipe(row.value)) names.push(ingredient.lookup);
    }
  }
  return names;
}

/**
 * Pairs each recipe row with the English it was translated from.
 *
 * A translated recipe usually carries the English alongside — `Madera (Wood)
 * x5` — and that gloss is what finds the article. Usually, not always: one
 * ingredient in the barber station came back as `Kit de peluquería x1` with
 * the gloss dropped, and with it went the icon and the link.
 *
 * The English article is right there, and translation preserves structure, so
 * the two can be walked together and the English used as the key regardless of
 * what the translation kept. Resolution then depends on the ingest, which is
 * consistent, instead of on a model remembering a convention.
 *
 * Keyed by the translated string because that is what the row renders, and it
 * is what the component has in hand.
 */
export function pairRecipeSources(
  translated: GroupLike[],
  english: GroupLike[],
): Record<string, string> {
  const out: Record<string, string> = {};

  translated.forEach((group, g) => {
    group.rows.forEach((row, r) => {
      if (!isRecipeLabel(row.label)) return;
      const source = english[g]?.rows[r];
      // Only when the row genuinely lines up; a shifted infobox would pair a
      // recipe with somebody else's stat.
      if (source && isRecipeLabel(source.label)) out[row.value] = source.value;
    });
  });

  return out;
}
