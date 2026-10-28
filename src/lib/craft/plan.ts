import { expandRaw, stationsNeeded, stepCost, type CraftStep, type GraphIndex, type Unexpanded } from './math';
import type { PlanItem } from './planner-store';
import type { GraphRecipe, ItemId } from './types';

/**
 * What a planner list needs: the materials its targets' own steps take, what
 * those break down into, the fuel, the steps in between, the stations, and
 * everything the maths could not price, named.
 *
 * Built only from the crafting maths (`./math.ts`), so the planner agrees to
 * the unit with the article card and everything else that computes from the
 * graph. Pure and isomorphic, like the maths.
 */
export type PlanNeeds = {
  /** What the targets' own steps consume. */
  direct: Map<ItemId, number>;
  /** `direct` broken down to raw materials, the intermediates the reader holds left whole. */
  raw: Map<ItemId, number>;
  /** Smelter and kiln fuel, the targets' own steps included. */
  fuel: Map<ItemId, number>;
  /** The intermediate crafts, in the order to make them. */
  crafts: CraftStep[];
  /** What those crafts make beyond the need: a whole craft of 20 nails where 10 are needed leaves 10. */
  leftovers: Map<ItemId, number>;
  /** The highest level each station is needed at, the targets' own steps included. */
  stations: Map<ItemId, number>;
  /** What the breakdown could not go past (a doubtful yield, a cycle), targets included, each with its whole need. */
  unexpanded: Unexpanded[];
  /** Targets whose steps the graph lacks, and which steps. */
  missing: { id: ItemId; steps: number[] }[];
  /** Targets the graph does not know: kept in the list, and named. */
  unknown: ItemId[];
  /**
   * Targets made in batches (a yield above 1): the crafts, what they make,
   * and what is left over once the rest of the list has taken its share.
   */
  made: { id: ItemId; crafts: number; made: number; leftover: number }[];
};

/**
 * The recipe a target's step is planned with: the one the maths plans with
 * (`stepCost`), else the wiki's first alternative for that level, or null
 * where the graph has no recipe for the step at all.
 *
 * Coal's only recipes are the charcoal kiln's, numbered as choices so that
 * no breakdown burns wood in a kiln for the coal a smelter needs: as an
 * ingredient, coal is gathered. A reader who puts Coal itself on the list,
 * from its article or from what their chest can make, has chosen the kiln,
 * and the wiki's first way to feed it is how it is planned, rather than a
 * claim that the wiki has no recipe for it. A list row reads its station
 * from here too, so the row and the totals name the same recipe.
 */
export function targetStep(index: GraphIndex, id: ItemId, quality: number): GraphRecipe | null {
  const planned = stepCost(index, id, quality);
  if (planned) return planned;
  // Every recipe left for this level is an alternative: the lowest number,
  // and of equal numbers the first in the graph's order.
  let first: GraphRecipe | null = null;
  for (const recipe of index.recipes.get(id) ?? []) {
    if (recipe.quality === quality && (first === null || (recipe.alt ?? 0) < (first.alt ?? 0))) first = recipe;
  }
  return first;
}

/**
 * What `items` needs, per target:
 *
 * - An id the graph does not know goes to `unknown`, and adds nothing.
 * - Each step from `from + 1` to `level` is made with `targetStep`, and the
 *   steps the graph has no recipe for go to `missing`. An upgrade step is
 *   made once per item (`qty` times). A first craft (`from` 0) is made
 *   `ceil(qty / yield)` times, the quantities of every entry for the item
 *   added up first, so two entries of 30 nails are three crafts of 20, not
 *   four; with a yield above 1 it goes to `made`. A first craft whose yield
 *   the wiki leaves in doubt goes to `unexpanded` and adds nothing: its
 *   inputs would be a guess.
 * - The steps' inputs are `direct`, their fuel goes to `fuel`, and their
 *   stations count towards `stations`.
 *
 * `raw` is `expandRaw` of `direct`. What the reader holds (`have`) of an
 * item the breakdown would make is taken first, so 4 Bronze held stops the
 * Karve's breakdown at the Bronze. A raw material keeps its whole need,
 * because the shopping list shows the count beside it ("tengo 10 de 30")
 * and must not take it off twice. A target itself is never taken from
 * `have`: the list says what to make.
 *
 * What a target's last batch makes beyond the target goes to the rest of
 * the list before anything more is made. 30 nails wanted are two crafts of
 * 20, and a Karve on the same list takes the 10 over and four crafts more:
 * six in all, as the maths makes 110 nails. `made` keeps as its leftover
 * only what the rest of the list did not take.
 */
export function planNeeds(index: GraphIndex, items: PlanItem[], have: ReadonlyMap<ItemId, number> = new Map()): PlanNeeds {
  const direct = new Map<ItemId, number>();
  const ownFuel = new Map<ItemId, number>();
  const ownStations: { station: ItemId; level: number }[] = [];
  const doubtful = new Map<ItemId, number>();
  const missing = new Map<ItemId, Set<number>>();
  const unknown: ItemId[] = [];
  const made: PlanNeeds['made'] = [];

  const make = (recipe: GraphRecipe, crafts: number): void => {
    for (const [input, qty] of recipe.inputs) add(direct, input, qty * crafts);
    if (recipe.fuel) add(ownFuel, recipe.fuel[0], recipe.fuel[1] * crafts);
  };
  // A step made by hand needs no station.
  const madeAt = (recipe: GraphRecipe): void => {
    if (recipe.station !== null) ownStations.push({ station: recipe.station, level: recipe.stationLevel });
  };

  // Every new item the list asks for, all its entries together, so each
  // first craft is rounded once.
  const fresh = new Map<ItemId, number>();
  for (const item of items) {
    if (item.from <= 0 && item.level >= 1 && index.items.has(item.id)) add(fresh, item.id, item.qty);
  }
  const firstCrafted = new Set<ItemId>();

  for (const item of items) {
    if (!index.items.has(item.id)) {
      if (!unknown.includes(item.id)) unknown.push(item.id);
      continue;
    }
    for (let quality = Math.max(item.from, 0) + 1; quality <= item.level; quality += 1) {
      const recipe = targetStep(index, item.id, quality);
      if (!recipe) {
        const steps = missing.get(item.id) ?? new Set<number>();
        missing.set(item.id, steps.add(quality));
        continue;
      }
      if (quality > 1) {
        madeAt(recipe);
        make(recipe, item.qty);
        continue;
      }
      if (firstCrafted.has(item.id)) continue;
      firstCrafted.add(item.id);
      // The station is needed whatever the yield: the reader makes it there.
      madeAt(recipe);
      const qty = fresh.get(item.id) ?? 0;
      if (!knownYield(recipe)) {
        add(doubtful, item.id, qty);
        continue;
      }
      const crafts = Math.ceil(qty / recipe.yield);
      make(recipe, crafts);
      if (recipe.yield > 1) made.push({ id: item.id, crafts, made: crafts * recipe.yield, leftover: crafts * recipe.yield - qty });
    }
  }

  // Only what has a recipe is ever taken from `have` (`expandRaw` stops at
  // anything else and keeps its whole need), and this keeps it that way;
  // a count that is not a real one is no count, as the maths reads it.
  const held = new Map([...have].filter(([id, qty]) => index.recipes.has(id) && Number.isFinite(qty) && qty > 0));
  // The targets' leftovers are offered to the breakdown beside what the
  // reader holds, and taken after it, so an item both wanted and needed is
  // made as often as the maths makes it for the two needs together.
  const offered = new Map(held);
  for (const { id, leftover } of made) if (leftover > 0) add(offered, id, leftover);
  const breakdown = expandRaw(index, direct, { have: offered });

  // All the breakdown needed of an item, taken from what it was offered or
  // made. Where it made some, it had taken everything offered first. Where
  // it made none, a second breakdown offered none of the item makes exactly
  // the need: the need is the same in both, because it comes from the
  // item's consumers, which come before it and which no count of the item
  // changes (the walk's order and its cycles depend on no count at all).
  const neededOf = (id: ItemId): number => {
    const step = breakdown.crafts.find((craft) => craft.recipe.product === id);
    if (step) return (offered.get(id) ?? 0) + step.produced - (breakdown.leftovers.get(id) ?? 0);
    // Nothing the targets' steps or the breakdown's take consumes it, and
    // the second breakdown is skipped: the usual case, a target nothing
    // else on the list needs.
    const consumed = direct.has(id) || breakdown.crafts.some((craft) => craft.recipe.inputs.some(([input]) => input === id));
    if (!consumed) return 0;
    const probe = expandRaw(index, direct, { have: new Map([...offered].filter(([other]) => other !== id)) });
    const probed = probe.crafts.find((craft) => craft.recipe.product === id);
    return probed ? probed.produced - (probe.leftovers.get(id) ?? 0) : 0;
  };
  for (const entry of made) {
    if (entry.leftover <= 0) continue;
    // The reader's own count went first; the leftover covered the rest, as far as it went.
    const beyondHeld = neededOf(entry.id) - (held.get(entry.id) ?? 0);
    entry.leftover -= Math.min(entry.leftover, Math.max(0, beyondHeld));
  }

  const fuel = new Map(ownFuel);
  for (const [id, qty] of breakdown.fuel) add(fuel, id, qty);

  // The doubtful targets first, then what the breakdown met, one row per
  // item and reason, so a stew wanted and a stew inside a platter read as
  // one need.
  const unexpanded: Unexpanded[] = [...doubtful].map(([id, need]) => ({ id, need, reason: 'unknown-yield' }));
  for (const entry of breakdown.unexpanded) {
    const same = unexpanded.find((row) => row.id === entry.id && row.reason === entry.reason);
    if (same) same.need += entry.need;
    else unexpanded.push({ ...entry });
  }

  return {
    direct,
    raw: breakdown.raw,
    fuel,
    crafts: breakdown.crafts,
    leftovers: breakdown.leftovers,
    stations: stationsNeeded(breakdown.crafts, ownStations),
    unexpanded,
    missing: [...missing].map(([id, steps]) => ({ id, steps: [...steps].sort((a, b) => a - b) })),
    unknown,
    made,
  };
}

/** Whether one craft's output is known, as the maths decides it: a doubtful or non-positive yield cannot be divided by. */
function knownYield(recipe: GraphRecipe): boolean {
  return recipe.yieldKnown && Number.isFinite(recipe.yield) && recipe.yield > 0;
}

function add(map: Map<ItemId, number>, id: ItemId, qty: number): void {
  map.set(id, (map.get(id) ?? 0) + qty);
}
