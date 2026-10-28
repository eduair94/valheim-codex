import type { CraftView } from '@/lib/craft/data';
import { expandRaw, stepCost, type CraftStep, type GraphIndex, type Unexpanded } from '@/lib/craft/math';
import { targetStep } from '@/lib/craft/plan';
import type { PlanItem } from '@/lib/craft/planner-store';
import type { GraphRecipe, ItemId } from '@/lib/craft/types';

/**
 * The article's craft card, as numbers: what it lists for a level, a mode
 * and a number of crafts. Pure, so that it is tested without a browser, and
 * built only on the crafting maths (`src/lib/craft/math.ts`) and the
 * planner's choice of recipe (`targetStep`), so that the card and the
 * planner agree to the unit: what the card lists is what the planner lists
 * for the target "Agregar al taller" adds (`planItemFor`).
 */

/**
 * What the card's client island is handed: the item, and the slice of the
 * graph every number on the card comes from (`CraftView.closure`, read with
 * `decodeGraph`). The rest of the view stays on the server.
 */
export type CraftCardData = Pick<CraftView, 'item' | 'closure'>;

/**
 * What the card lists: this level's own step (`step`), every step from new
 * to this level (`total`), or all of that broken down to raw materials
 * (`raw`).
 */
export type CardMode = 'step' | 'total' | 'raw';

/** The most crafts the stepper counts: a stack of ninety-nine. */
export const MAX_CRAFTS = 99;

export type CardAmount = { id: ItemId; qty: number };

export type CardTotals = {
  /** The materials, in the order the recipes name them; in `raw`, the raw materials. */
  rows: CardAmount[];
  /** What the steps burn besides (a smelter's coal), kept apart from the materials. */
  fuel: CardAmount[];
  /** In `raw`, the intermediate crafts, in the order to make them. */
  steps: CraftStep[];
  /** In `raw`, what the breakdown could not go past: a doubtful yield, a cycle. */
  unexpanded: Unexpanded[];
  /** The levels in the range the graph has no recipe for. Then nothing is totalled: a total missing a step is a wrong number. */
  missing: number[];
  /** How many one craft makes, where the crafts make the item new and the wiki says; null for an upgrade or a doubtful yield. */
  yield: number | null;
  /** How many the crafts make in all, under the same conditions. */
  made: number | null;
  /** The crafts make the item new and the wiki leaves its yield in doubt: the card says so instead of a count. */
  yieldInDoubt: boolean;
};

/** The steps the card adds up: this level's alone, or every one from new. */
function rangeOf(quality: number, mode: CardMode): { from: number; to: number } {
  return { from: mode === 'step' ? quality - 1 : 0, to: quality };
}

/**
 * The recipe a level of the item is made with, for the card's heading and
 * its station: the one the planner makes it with (`targetStep`), which on a
 * material whose only recipes are choices (coal, from the charcoal kiln) is
 * the wiki's first choice. Null where the graph has no recipe for the level.
 */
export function cardStep(index: GraphIndex, data: CraftCardData, quality: number): GraphRecipe | null {
  return targetStep(index, data.item.id, quality);
}

function knownYield(recipe: GraphRecipe): boolean {
  return recipe.yieldKnown && Number.isFinite(recipe.yield) && recipe.yield > 0;
}

export function cardTotals(index: GraphIndex, data: CraftCardData, quality: number, mode: CardMode, crafts: number): CardTotals {
  const { from, to } = rangeOf(quality, mode);
  const direct = new Map<ItemId, number>();
  const ownFuel = new Map<ItemId, number>();
  const missing: number[] = [];
  for (let level = from + 1; level <= to; level += 1) {
    const recipe = targetStep(index, data.item.id, level);
    if (!recipe) {
      missing.push(level);
      continue;
    }
    // Every step is made once per item: a craft makes it new, an upgrade
    // raises one item a level.
    for (const [input, qty] of recipe.inputs) add(direct, input, qty * crafts);
    if (recipe.fuel) add(ownFuel, recipe.fuel[0], recipe.fuel[1] * crafts);
  }

  // What one craft takes is known even where how many it makes is not; the
  // count made is what stays unsaid.
  const first = from === 0 ? targetStep(index, data.item.id, 1) : null;
  const perCraft = first && knownYield(first) ? first.yield : null;
  const counted = {
    yield: perCraft,
    made: perCraft === null ? null : perCraft * crafts,
    yieldInDoubt: first !== null && perCraft === null,
  };

  if (missing.length > 0) return { rows: [], fuel: [], steps: [], unexpanded: [], missing, ...counted };
  if (mode !== 'raw') return { rows: listed(direct), fuel: listed(ownFuel), steps: [], unexpanded: [], missing, ...counted };

  const breakdown = expandRaw(index, direct);
  const fuel = new Map(ownFuel);
  for (const [id, qty] of breakdown.fuel) add(fuel, id, qty);
  return {
    rows: listed(breakdown.raw),
    fuel: listed(fuel),
    steps: breakdown.crafts,
    unexpanded: breakdown.unexpanded,
    missing,
    ...counted,
  };
}

/**
 * The modes worth offering at a level. "Del 1 al N" only past the first
 * level, where it is this level's step; "Materias primas" only where some
 * material of the steps up to the level is itself made from others (a
 * recipe the breakdown would follow, or one it would stop at and name), so
 * that no mode shows the same list as another.
 */
export function cardModes(index: GraphIndex, data: CraftCardData, quality: number): CardMode[] {
  const modes: CardMode[] = ['step'];
  if (quality > 1) modes.push('total');
  for (let level = 1; level <= quality; level += 1) {
    const recipe = targetStep(index, data.item.id, level);
    if (recipe?.inputs.some(([input]) => stepCost(index, input, 1) !== null)) {
      modes.push('raw');
      break;
    }
  }
  return modes;
}

/**
 * The planner's target for what the card shows: this level's step, or
 * everything from new, in items, as the planner counts them: two crafts of
 * nails are forty nails. A doubtful yield counts one a craft, and the
 * planner names it as doubtful rather than pricing it.
 */
export function planItemFor(index: GraphIndex, data: CraftCardData, quality: number, mode: CardMode, crafts: number): PlanItem {
  const { from, to } = rangeOf(quality, mode);
  const first = from === 0 ? targetStep(index, data.item.id, 1) : null;
  const perCraft = first && knownYield(first) ? first.yield : 1;
  return { id: data.item.id, level: to, from, qty: crafts * perCraft };
}

/** A typed or stepped count of crafts, as the stepper keeps it: a whole number from 1 to 99. */
export function clampCrafts(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_CRAFTS);
}

function listed(map: Map<ItemId, number>): CardAmount[] {
  return [...map].map(([id, qty]) => ({ id, qty }));
}

function add(map: Map<ItemId, number>, id: ItemId, qty: number): void {
  map.set(id, (map.get(id) ?? 0) + qty);
}
