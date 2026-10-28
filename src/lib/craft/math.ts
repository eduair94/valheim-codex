import type { GraphItem, GraphRecipe, ItemId, RecipeGraph } from './types';

/**
 * The crafting maths: what a step costs, what a range of upgrades costs,
 * what a list breaks down into, which stations it needs, where a material
 * goes, and what an inventory can make.
 *
 * One library for every surface (the article card, the planner, the guide's
 * gear, the chat's excerpts) because they must agree to the unit, and pure
 * and isomorphic because the server renders some of them and the browser the
 * rest. Nothing here fetches, stores or formats.
 *
 * The rule throughout: a number that cannot be computed exactly is not
 * computed. A yield the wiki leaves in doubt (`yieldKnown` false), or a
 * recipe that ends up needing itself, stops the breakdown at that item and
 * is reported for the interface to name, because a shopping list built on a
 * guess is worse than none.
 */

/**
 * A graph ready for the maths. Build it once per graph with `indexGraph` and
 * pass it to every function here; treat it as read-only. Its maps are views
 * over the graph's own items and recipes, not copies.
 */
export type GraphIndex = {
  readonly graph: RecipeGraph;
  /** Every item, by id. */
  readonly items: ReadonlyMap<ItemId, GraphItem>;
  /** Every recipe for a product, alternatives included, in the graph's order. */
  readonly recipes: ReadonlyMap<ItemId, readonly GraphRecipe[]>;
  /** Every recipe each material goes into, in the graph's order. */
  readonly uses: ReadonlyMap<ItemId, readonly GraphRecipe[]>;
};

export function indexGraph(graph: RecipeGraph): GraphIndex {
  const items = new Map(graph.items.map((item) => [item.id, item]));
  const recipes = new Map<ItemId, GraphRecipe[]>();
  const uses = new Map<ItemId, GraphRecipe[]>();
  for (const recipe of graph.recipes) {
    push(recipes, recipe.product, recipe);
    // Once per recipe, however many times it lists the material.
    for (const material of new Set(recipe.inputs.map(([id]) => id))) push(uses, material, recipe);
  }
  return { graph, items, recipes, uses };
}

/**
 * The step to `quality` of an item: the recipe the maths plans with (`alt`
 * 0 or absent), not an alternative. Null where the graph has no such step,
 * which includes a material whose only recipes are alternatives (coal from
 * the charcoal kiln): that material is gathered, and the kiln is a choice.
 */
export function stepCost(index: GraphIndex, id: ItemId, quality: number): GraphRecipe | null {
  for (const recipe of index.recipes.get(id) ?? []) {
    if (recipe.quality === quality && (recipe.alt ?? 0) === 0) return recipe;
  }
  return null;
}

/**
 * What it costs to take an item from quality `from` to quality `to`: the sum
 * of the steps `from + 1` to `to`. From 0 is making it new.
 *
 * A step the graph lacks adds nothing, so a total shown as complete must be
 * checked with `missingSteps` first.
 */
export function totalCost(index: GraphIndex, id: ItemId, from: number, to: number): Map<ItemId, number> {
  const total = new Map<ItemId, number>();
  for (let quality = Math.max(from, 0) + 1; quality <= to; quality += 1) {
    for (const [material, qty] of stepCost(index, id, quality)?.inputs ?? []) add(total, material, qty);
  }
  return total;
}

/**
 * The steps between `from` and `to` that the graph has no recipe for: the
 * wiki left a tab unreadable, or the range goes past the item's maximum.
 * Empty when `totalCost` over the same range is the whole cost.
 */
export function missingSteps(index: GraphIndex, id: ItemId, from: number, to: number): number[] {
  const missing: number[] = [];
  for (let quality = Math.max(from, 0) + 1; quality <= to; quality += 1) {
    if (!stepCost(index, id, quality)) missing.push(quality);
  }
  return missing;
}

/** One recipe made as many times as the list needs it, and how many that makes. */
export type CraftStep = { recipe: GraphRecipe; crafts: number; produced: number };

/**
 * An item the breakdown could not go past. `expandRaw` reports `cycle` (its
 * recipe ends up needing itself) and `unknown-yield` (the wiki states a
 * yield for it elsewhere but not on its recipe, and no override settles
 * how many one craft makes); materials with no recipe are not failures and
 * go to `raw` instead. `raw` is here for an interface that lists all three
 * together.
 *
 * `need` reads like a raw material's: all the list needs of the item from
 * what the reader holds or from elsewhere, before `have`, so every row of a
 * shopping list compares with `have` the same way ("tengo 1 de 2").
 */
export type Unexpanded = { id: ItemId; need: number; reason: 'raw' | 'cycle' | 'unknown-yield' };

/**
 * Breaks a list down to raw materials.
 *
 * The whole list's demand is added up before anything is rounded, then each
 * item is made in turn, every consumer before what it consumes, so an
 * intermediate's crafts are rounded once for everything that needs it: 50
 * and 30 nails are 4 crafts of 20, not 3 and 2. An item is made with its
 * preferred quality-1 recipe, `ceil(need / yield)` times; what the yield
 * makes beyond the need is a leftover.
 *
 * The demand is of things to make new or to gather. Upgrading something the
 * reader owns is `totalCost`'s to price, and its materials go in here.
 *
 * - `have`: what the reader already holds. An item the breakdown makes is
 *   taken from it first and only the rest is made, so having the Bronze
 *   stops the breakdown at the Bronze. An item the breakdown stops at keeps
 *   its whole need, for the interface to compare with `have`: a raw
 *   material, so a shopping list row reads "tengo 10 de 30" instead of
 *   shrinking as the reader ticks it, and an unexpanded item the same way.
 *   For an item a cycle needs again, the whole need includes what the
 *   item's own step took from `have`, because the reader's own went there
 *   first.
 * - `stopAt`: items to treat as raw materials although they have a recipe.
 *
 * Returns the raw materials; the fuel the steps burn, kept apart from the
 * materials (smelting 12 bars burns 24 Coal); the steps, in an order they
 * can be made in; the leftovers; and the items it could not go past. Items
 * are listed in the order the breakdown meets them reading the list's
 * recipes from the top, which is how a reader reads them: a Karve's Finewood,
 * Deer hide and Resin before the ores inside its nails.
 */
export function expandRaw(
  index: GraphIndex,
  demand: Map<ItemId, number>,
  options: { have?: Map<ItemId, number>; stopAt?: ReadonlySet<ItemId> } = {},
): {
  raw: Map<ItemId, number>;
  fuel: Map<ItemId, number>;
  crafts: CraftStep[];
  leftovers: Map<ItemId, number>;
  unexpanded: Unexpanded[];
} {
  const stopAt = options.stopAt ?? new Set<ItemId>();
  // The recipe an item is broken down by, or null where the breakdown stops.
  const recipeOf = (id: ItemId): GraphRecipe | null => (stopAt.has(id) ? null : stepCost(index, id, 1));
  const expandable = (id: ItemId): GraphRecipe | null => {
    const recipe = recipeOf(id);
    return recipe && knownYield(recipe) ? recipe : null;
  };

  // The order: depth first from every demanded item, along the recipes the
  // breakdown follows; reversed post-order puts every consumer before what it
  // consumes. An input still on the path being explored closes a cycle, and
  // that one edge is cut: the input is reported, never expanded again.
  const met = new Map<ItemId, number>();
  const finished = new Set<ItemId>();
  const cut = new Set<string>();
  const order: ItemId[] = [];
  const visit = (id: ItemId): void => {
    met.set(id, met.size);
    for (const [input] of expandable(id)?.inputs ?? []) {
      if (!met.has(input)) visit(input);
      else if (!finished.has(input)) cut.add(edge(id, input));
    }
    finished.add(id);
    order.push(id);
  };
  for (const [id, qty] of demand) {
    if (positive(qty) && !met.has(id)) visit(id);
  }
  order.reverse();

  const need = new Map<ItemId, number>();
  for (const [id, qty] of demand) if (positive(qty)) add(need, id, qty);

  // What the reader holds, and how much of it each item the breakdown makes
  // took. The walk reaches every item once, so nothing is taken twice.
  const holding = (id: ItemId): number => {
    const qty = options.have?.get(id) ?? 0;
    return positive(qty) ? qty : 0;
  };
  const taken = new Map<ItemId, number>();

  const raw = new Map<ItemId, number>();
  const fuel = new Map<ItemId, number>();
  const crafts: CraftStep[] = [];
  const leftovers = new Map<ItemId, number>();
  const unexpanded = new Map<string, Unexpanded>();
  const report = (id: ItemId, qty: number, reason: Unexpanded['reason']): void => {
    const key = `${reason}\u0000${id}`;
    const entry = unexpanded.get(key);
    if (entry) entry.need += qty;
    else unexpanded.set(key, { id, need: qty, reason });
  };

  for (const id of order) {
    const total = need.get(id) ?? 0;
    if (total <= 0) continue;
    const recipe = recipeOf(id);
    if (!recipe) {
      add(raw, id, total);
      continue;
    }
    // A doubtful yield stops the breakdown just as a raw material does, so
    // it keeps its whole need too.
    if (!knownYield(recipe)) {
      report(id, total, 'unknown-yield');
      continue;
    }
    const held = Math.min(holding(id), total);
    if (held > 0) taken.set(id, held);
    const missing = total - held;
    if (missing <= 0) continue;

    const times = Math.ceil(missing / recipe.yield);
    const produced = times * recipe.yield;
    crafts.push({ recipe, crafts: times, produced });
    if (produced > missing) add(leftovers, id, produced - missing);
    if (recipe.fuel) add(fuel, recipe.fuel[0], recipe.fuel[1] * times);
    for (const [input, qty] of recipe.inputs) {
      if (cut.has(edge(id, input))) report(input, qty * times, 'cycle');
      else add(need, input, qty * times);
    }
  }
  // The item a cycle needs again is one the walk was still exploring, so
  // its own step came first and may have taken from `have`: what it took
  // is part of all the list needs of it.
  for (const entry of unexpanded.values()) {
    if (entry.reason === 'cycle') entry.need += taken.get(entry.id) ?? 0;
  }

  // The steps were worked out consumers first and are listed the other way
  // round, inputs first, the order a player makes them in. Materials follow
  // the order the recipes name them; fuel the walk never met keeps its own
  // order, after them.
  crafts.reverse();
  const reading = (id: ItemId): number => met.get(id) ?? Infinity;
  const inReadingOrder = (map: Map<ItemId, number>) =>
    new Map([...map].sort(([a], [b]) => reading(a) - reading(b)));
  return {
    raw: inReadingOrder(raw),
    fuel: inReadingOrder(fuel),
    crafts,
    leftovers: inReadingOrder(leftovers),
    unexpanded: [...unexpanded.values()].sort((a, b) => reading(a.id) - reading(b.id)),
  };
}

/** A recipe edge, from a product to one of its inputs, as one key. */
function edge(product: ItemId, input: ItemId): string {
  return `${product}\u0000${input}`;
}

/**
 * The station levels a set of steps needs: for each station, the highest
 * level any step asks for. `also` adds requirements made outside the
 * breakdown, such as the upgrade steps of the list's own items (an Iron
 * Sword at quality 4 needs a level 5 Forge although its Iron does not).
 *
 * A station's level is 1 plus the number of its extensions built, in any
 * order. A step that states no level still needs the station: level 1.
 */
export function stationsNeeded(crafts: CraftStep[], also: { station: ItemId; level: number }[] = []): Map<ItemId, number> {
  const levels = new Map<ItemId, number>();
  const atLeast = (station: ItemId, level: number): void => {
    levels.set(station, Math.max(levels.get(station) ?? 1, level));
  };
  for (const { recipe } of crafts) if (recipe.station !== null) atLeast(recipe.station, recipe.stationLevel);
  for (const { station, level } of also) atLeast(station, level);
  return levels;
}

/**
 * Everything a material goes into: one row per recipe step, upgrades and
 * alternatives included, with that step's quantity and station. Fuel is not
 * a use: coal burned in a smelter is no ingredient of the bar.
 */
export function usedIn(
  index: GraphIndex,
  id: ItemId,
): { product: ItemId; quality: number; qty: number; station: ItemId | null; stationLevel: number }[] {
  return (index.uses.get(id) ?? []).map((recipe) => ({
    product: recipe.product,
    quality: recipe.quality,
    qty: recipe.inputs.reduce((sum, [material, qty]) => (material === id ? sum + qty : sum), 0),
    station: recipe.station,
    stationLevel: recipe.stationLevel,
  }));
}

/**
 * What an inventory can make: `now`, with how many crafts it allows, and
 * `almost`, with what is missing for one craft.
 *
 * A craft takes its fuel as well as its ingredients: ore and no coal smelts
 * nothing. Only first crafts count: an upgrade needs the item itself, which
 * a list of materials does not say. Alternatives count, and a product takes
 * its best recipe.
 *
 * Close means one of two things, listed in this order:
 *
 * - every ingredient is within `almostRatio` of its quantity (8 of the
 *   Cauldron's 10 Tin);
 * - every ingredient but one is there, for a recipe of two or more, and
 *   that one is within reach: the reader holds some of it, or can make it
 *   now (a Karve with all but its nails, and Bronze for them).
 *
 * An ingredient out of reach is never close, however few it takes: a first
 * day's inventory is one Hard antler from an Antler pickaxe, and only
 * Eikthyr drops it. A recipe the inventory holds nothing of is never close
 * either. Within each kind, the smallest share of one craft's quantities
 * still missing comes first.
 *
 * Stations are not checked: an inventory does not say which the reader has
 * built. Reach is read from `now` itself, so the two lists agree with each
 * other, and a caller that knows the reader's stations filters both alike.
 */
export function craftable(
  index: GraphIndex,
  inventory: Map<ItemId, number>,
  almostRatio = 0.2,
): { now: { product: ItemId; crafts: number }[]; almost: { product: ItemId; missing: Map<ItemId, number> }[] } {
  const holding = (id: ItemId): number => {
    const qty = inventory.get(id) ?? 0;
    return positive(qty) ? qty : 0;
  };

  // First all the inventory makes now, which says afterwards whether a
  // missing ingredient is within reach.
  const now = new Map<ItemId, number>();
  const short: { product: ItemId; perCraft: Map<ItemId, number> }[] = [];
  for (const recipe of index.graph.recipes) {
    if (recipe.quality !== 1) continue;
    // One craft's ingredients and fuel, an ingredient listed twice counted twice.
    const perCraft = new Map<ItemId, number>();
    for (const [material, qty] of recipe.inputs) if (positive(qty)) add(perCraft, material, qty);
    if (recipe.fuel && positive(recipe.fuel[1])) add(perCraft, recipe.fuel[0], recipe.fuel[1]);
    if (perCraft.size === 0) continue;

    let times = Infinity;
    for (const [material, qty] of perCraft) times = Math.min(times, Math.floor(holding(material) / qty));
    if (times >= 1) now.set(recipe.product, Math.max(now.get(recipe.product) ?? 0, times));
    else short.push({ product: recipe.product, perCraft });
  }

  // Then, of what it cannot make yet, what is close: `kind` 0 for every
  // quantity close, 1 for one ingredient short.
  const withinReach = (id: ItemId): boolean => holding(id) > 0 || now.has(id);
  const almost = new Map<ItemId, { missing: Map<ItemId, number>; kind: number; share: number }>();
  for (const { product, perCraft } of short) {
    if (now.has(product)) continue;
    const missing = new Map<ItemId, number>();
    let allClose = true;
    for (const [material, qty] of perCraft) {
      const held = holding(material);
      if (held >= qty) continue;
      missing.set(material, qty - held);
      if (qty - held > almostRatio * qty) allClose = false;
    }
    let kind: number;
    if (allClose) kind = 0;
    else if (perCraft.size >= 2 && missing.size === 1 && [...missing.keys()].every(withinReach)) kind = 1;
    else continue;

    const share = sum(missing.values()) / sum(perCraft.values());
    const best = almost.get(product);
    if (!best || kind < best.kind || (kind === best.kind && share < best.share)) almost.set(product, { missing, kind, share });
  }

  return {
    now: [...now].map(([product, crafts]) => ({ product, crafts })),
    // A stable sort: equally close recipes keep the graph's order.
    almost: [...almost]
      .sort(([, a], [, b]) => a.kind - b.kind || a.share - b.share)
      .map(([product, { missing }]) => ({ product, missing })),
  };
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * Whether one craft's output is known: a yield in doubt (`yieldKnown`
 * false), or one that is not a positive number, cannot be divided by.
 */
function knownYield(recipe: GraphRecipe): boolean {
  return recipe.yieldKnown && positive(recipe.yield);
}

function positive(qty: number): boolean {
  return Number.isFinite(qty) && qty > 0;
}

function add(map: Map<ItemId, number>, id: ItemId, qty: number): void {
  map.set(id, (map.get(id) ?? 0) + qty);
}

function push<V>(map: Map<ItemId, V[]>, key: ItemId, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
