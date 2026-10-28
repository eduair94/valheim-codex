/**
 * The recipe graph: every thing the game lets a player make, what each step
 * of it costs, where it is made, and how its raw materials are had.
 *
 * The assembly builds it once per ingest run from the recipes read off every
 * page, and it is stored as one row. It reaches readers two ways: a slice of
 * it inside each article page, and all of it, compact (`codec.ts`), for the
 * planner. Every crafting number a reader sees is computed from it by one
 * library (`math.ts`), so the article card, the planner, the guide and the
 * chat can never disagree.
 *
 * Types only, importing nothing: this module ships to the browser, so it must
 * never pull in the database or anything else that lives on the server.
 */

/**
 * What identifies an item: the game's internal ID (`SwordIron`,
 * `MeadBasePoisonResist`) wherever the wiki states one, else `page:<slug>`,
 * or `page:<slug>#<anchor>` for a thing described inside another page.
 *
 * Saved lists, progress and share links are keyed by it, so it has to
 * outlive the wiki renaming a page (Odin became Oden) and mean the same in
 * both languages. A title or a slug does neither.
 */
export type ItemId = string;

/**
 * What kind of thing an item is, which decides how it is talked about.
 *
 * - `item`: carried in the inventory: weapons, armor, materials, food.
 * - `piece`: built with the hammer and placed in the world.
 * - `station`: a piece other things are made at, with levels.
 * - `extension`: a piece that raises a station's level by one.
 * - `virtual`: named by recipes but described by no infobox of its own, such
 *   as a trophy the wiki only lists on its Trophies page.
 */
export type ItemKind = 'item' | 'piece' | 'station' | 'extension' | 'virtual';

export type GraphItem = {
  id: ItemId;
  /** The English name, as the wiki writes it. */
  en: string;
  /** The one Spanish name the interface shows, where there is one. */
  es?: string;
  /** Other names readers and translations use for it, in either language: for search and the chat. */
  aliases?: string[];
  /** The article that describes it. */
  slug?: string;
  /** Where on that article: the tab or section of an intermediate or a piece. */
  anchor?: string;
  /** A path under the wiki's image root, as the title index sends icons (`expandIcon`). */
  icon?: string;
  kind: ItemKind;
  /** The highest quality it upgrades to; 1 for a single-level item. */
  maxQuality: number;
  /** A station's highest level, and the extensions that raise it one level each. */
  station?: { maxLevel: number; extensions: ItemId[] };
  /** An extension: the station it raises by one level. */
  extends?: ItemId;
  /** How a material with no recipe is had, where the wiki says. */
  obtain?: Obtain[];
};

/**
 * One way to come by a material with no recipe. `from` names the creatures,
 * deposits, trees, places or trader as the wiki does; `tool` is what the job
 * needs, where the wiki says (Finewood needs a Bronze axe).
 */
export type Obtain =
  | { how: 'drop'; from: string[] }
  | { how: 'mine' | 'chop' | 'gather' | 'fish' | 'loot' | 'farm'; from: string[]; tool?: ItemId }
  | { how: 'buy'; from: string; coins: number };

/**
 * How a recipe is made, which follows from its station: crafted at a bench,
 * built with the hammer, smelted, cooked, baked, brewed in the mead ketill,
 * fermented, refined into eitr, milled, spun, burned in the charcoal kiln, or
 * prepared at the food preparation table.
 */
export type RecipeMethod =
  | 'craft'
  | 'build'
  | 'smelt'
  | 'cook'
  | 'bake'
  | 'brew'
  | 'ferment'
  | 'refine'
  | 'mill'
  | 'spin'
  | 'kiln'
  | 'prepare';

/**
 * One step of making something: what it costs, where, and how many it makes.
 *
 * A step, not a running total, exactly as the wiki's quality tabs state it:
 * quality 3 of the Iron Sword is the cost of going from 2 to 3 (Wood 2,
 * Iron 20, Leather scraps 4), and the cost from new is the sum of the steps.
 */
export type GraphRecipe = {
  product: ItemId;
  /** The quality this step reaches. 1 is making it new. */
  quality: number;
  /** Where it is made; null when it is made by hand, at no station. */
  station: ItemId | null;
  /** The station level the step needs; 1 where the station has no levels. */
  stationLevel: number;
  /** How many one craft makes: 1 unless the wiki states "Crafts N". */
  yield: number;
  /**
   * False where the count is in doubt: the wiki states a yield for this
   * product somewhere else but not on the recipe (a yield suspect in the
   * report), and no override settles it. A recipe that simply states no
   * yield makes one, and is known. The maths stops at a doubtful step
   * instead of assuming 1: a shopping list built on a guessed yield is a
   * wrong number, and a wrong number is worse than none.
   */
  yieldKnown: boolean;
  /** What one craft consumes, in the order the wiki lists it. */
  inputs: [ItemId, number][];
  method: RecipeMethod;
  /**
   * Whether the maths plans with this recipe. Absent or 0: it does, so each
   * product and quality has at most one such recipe. 1 and up: an
   * alternative it never plans with, though it is shown and an inventory
   * can still use it (copper from scrap, beside the 0 from ore).
   *
   * A product whose only recipe is a choice still numbers it 1, with no 0
   * beside it: coal from the charcoal kiln. Coal stays a gathered material,
   * and no breakdown turns it into wood burned in a kiln the reader may not
   * have. Absent or 0 there would make the kiln the way coal is planned.
   */
  alt?: number;
  /** What one craft burns besides its inputs: a smelter takes 2 Coal per bar. */
  fuel?: [ItemId, number];
  /** Where the recipe was read: the page, and the tab or list on it ("Bronze Armor#Chest", "Wood Structures"). */
  from: string;
};

/**
 * The whole graph, as it is stored and as the planner reads it.
 *
 * `v` is the shape. A change an older reader would misread makes it 2, served
 * at `?v=2` while 1 keeps answering for a release. `version` is the content:
 * a hash of the items and recipes, so two builds from the same wiki are the
 * same graph.
 */
export type RecipeGraph = {
  v: 1;
  version: string;
  builtAt: string;
  items: GraphItem[];
  recipes: GraphRecipe[];
};

/**
 * What the assembly found wrong or doubtful, stored beside each graph and
 * printed by the ingest.
 *
 * The wiki contradicts itself (Black forge recipes at levels 6 and 7 against
 * a stated maximum of 5). A contradiction reported is one a person can settle
 * in the overrides; one silently fixed would hide a wrong number.
 */
export type GraphReport = {
  items: number;
  recipes: number;
  products: number;
  /** Materials with no recipe: what every breakdown ends in. */
  raw: number;
  /** Recipe entries that no link, redirect or title resolved, by name and the page that names them. */
  unresolved: { text: string; from: string; count: number }[];
  /** Items whose recipes end up needing themselves. */
  cycles: ItemId[][];
  /** A recipe needing a higher station level than the station states as its maximum. The recipe keeps its level. */
  levelConflicts: { station: ItemId; stated: number; required: number; from: string }[];
  /** A step stated on two pages: the one kept (the item's own page) and the one dropped. */
  duplicates: { product: ItemId; quality: number; kept: string; dropped: string }[];
  /** Recipes whose yield the wiki leaves in doubt. */
  yieldSuspects: { product: ItemId; from: string }[];
  /**
   * The overrides that changed this graph, each with its one-line reason.
   * Optional so that a report written without it still reads.
   */
  applied?: { override: string; reason: string; count: number }[];
};
