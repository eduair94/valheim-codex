import { describe, expect, it } from 'vitest';
import { encodeGraph } from '@/lib/craft/codec';
import { indexGraph } from '@/lib/craft/math';
import { planNeeds } from '@/lib/craft/plan';
import type { GraphItem, GraphRecipe, ItemId, RecipeGraph } from '@/lib/craft/types';
import { cardModes, cardStep, cardTotals, clampCrafts, planItemFor, type CraftCardData } from '@/components/wiki/craft/card-model';

/**
 * The article's craft card, as numbers (`card-model.ts`): what it lists at a
 * level, in each of its three modes, for a number of crafts.
 *
 * On the fixture graph `tests/unit/craft-math.test.ts` checks the maths on
 * (copied, not imported: importing a test file would run its tests here too).
 * The card and the planner must agree to the unit, so the card's totals are
 * also checked against `planNeeds` for the target "Agregar al taller" would
 * add.
 */

/** A recipe step with the usual defaults: one per craft, a known yield, crafted. */
function step(
  product: ItemId,
  quality: number,
  station: ItemId | null,
  stationLevel: number,
  inputs: [ItemId, number][],
  more: Partial<GraphRecipe> = {},
): GraphRecipe {
  return { product, quality, station, stationLevel, yield: 1, yieldKnown: true, inputs, method: 'craft', from: product, ...more };
}

/** A graph holding every item its recipes name, so the cases only state recipes. */
function graphOf(recipes: GraphRecipe[]): RecipeGraph {
  const items = new Map<ItemId, GraphItem>();
  const add = (id: ItemId, kind: GraphItem['kind']) => {
    if (!items.has(id)) items.set(id, { id, en: id, kind, maxQuality: 1 });
  };
  for (const r of recipes) {
    if (r.station) add(r.station, 'station');
    add(r.product, 'item');
    items.get(r.product)!.maxQuality = Math.max(items.get(r.product)!.maxQuality, r.quality);
    for (const [input] of r.inputs) add(input, 'item');
    if (r.fuel) add(r.fuel[0], 'item');
  }
  return { v: 1, version: 'test', builtAt: '2026-10-27T18:00:00.000Z', items: [...items.values()], recipes };
}

const GRAPH = graphOf([
  step('SwordIron', 1, 'forge', 2, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 3]]),
  step('SwordIron', 2, 'forge', 3, [['Wood', 1], ['Iron', 10], ['LeatherScraps', 2]]),
  step('SwordIron', 3, 'forge', 4, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 4]]),
  step('SwordIron', 4, 'forge', 5, [['Wood', 3], ['Iron', 30], ['LeatherScraps', 6]]),
  step('Iron', 1, 'smelter', 1, [['IronScrap', 1]], { method: 'smelt', fuel: ['Coal', 2] }),
  step('Copper', 1, 'smelter', 1, [['CopperOre', 1]], { method: 'smelt', fuel: ['Coal', 2], alt: 0 }),
  step('Copper', 1, 'smelter', 1, [['CopperScrap', 1]], { method: 'smelt', fuel: ['Coal', 2], alt: 1 }),
  step('Tin', 1, 'smelter', 1, [['TinOre', 1]], { method: 'smelt', fuel: ['Coal', 2] }),
  step('Bronze', 1, 'forge', 1, [['Copper', 2], ['Tin', 1]]),
  step('BronzeNails', 1, 'forge', 1, [['Bronze', 1]], { yield: 20 }),
  step('Karve', 1, 'piece_workbench', 1, [['FineWood', 30], ['DeerHide', 10], ['Resin', 20], ['BronzeNails', 80]], { method: 'build' }),
  step('MeadPoisonResist', 1, 'fermenter', 1, [['MeadBasePoisonResist', 1]], { method: 'ferment', yield: 6 }),
  step('MeadBasePoisonResist', 1, 'piece_MeadCauldron', 1, [['Honey', 10], ['Thistle', 5], ['NeckTail', 1], ['Coal', 10]], { method: 'brew' }),
  step('Coal', 1, 'charcoal_kiln', 1, [['Wood', 1]], { method: 'kiln', alt: 1 }),
  step('MysteryStew', 1, 'piece_cauldron', 3, [['Thistle', 2], ['NeckTail', 1]], { method: 'cook', yieldKnown: false }),
  step('StewPlatter', 1, 'piece_workbench', 1, [['MysteryStew', 2], ['Wood', 1]]),
  step('ShieldGapped', 1, 'forge', 1, [['Wood', 4]]),
  step('ShieldGapped', 2, 'forge', 2, [['Wood', 2]]),
  step('ShieldGapped', 4, 'forge', 4, [['Wood', 6]]),
  step('wood_stack', 1, null, 1, [['Wood', 50]], { method: 'build' }),
]);
const ix = indexGraph(GRAPH);

/** What the page hands the card: the item and a closure (here the whole graph, compact, as the codec sends it). */
function cardOf(id: ItemId): CraftCardData {
  const item = ix.items.get(id)!;
  return {
    item: { id, name: item.en, en: item.en, slug: null, anchor: null, icon: null, kind: item.kind, maxQuality: item.maxQuality },
    closure: encodeGraph(GRAPH),
  };
}

const rows = (list: { id: ItemId; qty: number }[]) => Object.fromEntries(list.map(({ id, qty }) => [id, qty]));
const plain = (map: Map<ItemId, number>) => Object.fromEntries(map);

describe('cardTotals', () => {
  it("lists one level's own step, as the wiki's tab for that level states it", () => {
    const totals = cardTotals(ix, cardOf('SwordIron'), 3, 'step', 1);
    expect(rows(totals.rows)).toEqual({ Wood: 2, Iron: 20, LeatherScraps: 4 });
    expect(totals).toMatchObject({ fuel: [], steps: [], unexpanded: [], missing: [], made: null });
  });

  it('adds up every step from new to the level', () => {
    expect(rows(cardTotals(ix, cardOf('SwordIron'), 3, 'total', 1).rows)).toEqual({ Wood: 5, Iron: 50, LeatherScraps: 9 });
    // The wiki's own Total row for the sword: 8 Wood, 80 Iron, 15 Leather scraps.
    expect(rows(cardTotals(ix, cardOf('SwordIron'), 4, 'total', 1).rows)).toEqual({ Wood: 8, Iron: 80, LeatherScraps: 15 });
  });

  it('multiplies by the crafts', () => {
    expect(rows(cardTotals(ix, cardOf('SwordIron'), 2, 'step', 3).rows)).toEqual({ Wood: 3, Iron: 30, LeatherScraps: 6 });
  });

  it('breaks the whole level down to raw materials, with the fuel and the steps between', () => {
    const totals = cardTotals(ix, cardOf('SwordIron'), 4, 'raw', 1);
    expect(rows(totals.rows)).toEqual({ Wood: 8, IronScrap: 80, LeatherScraps: 15 });
    expect(rows(totals.fuel)).toEqual({ Coal: 160 });
    expect(totals.steps.map((s) => [s.recipe.product, s.crafts, s.produced])).toEqual([['Iron', 80, 80]]);
  });

  it('makes nails twenty a craft, down to the ore of two bronze', () => {
    const totals = cardTotals(ix, cardOf('BronzeNails'), 1, 'raw', 2);
    expect(totals.made).toBe(40);
    expect(rows(totals.rows)).toEqual({ CopperOre: 4, TinOre: 2 });
    // Six bars smelted, two coal each.
    expect(rows(totals.fuel)).toEqual({ Coal: 12 });
    expect(totals.steps.map((s) => [s.recipe.product, s.crafts])).toEqual([
      ['Copper', 4],
      ['Tin', 2],
      ['Bronze', 2],
    ]);
  });

  it("counts a smelter's own coal in this level's step", () => {
    expect(cardTotals(ix, cardOf('Iron'), 1, 'step', 5)).toMatchObject({ rows: [{ id: 'IronScrap', qty: 5 }], fuel: [{ id: 'Coal', qty: 10 }] });
  });

  it('stops at an intermediate whose yield the wiki leaves in doubt, and names it instead of a number', () => {
    const totals = cardTotals(ix, cardOf('StewPlatter'), 1, 'raw', 1);
    expect(rows(totals.rows)).toEqual({ Wood: 1 });
    expect(totals.unexpanded).toEqual([{ id: 'MysteryStew', need: 2, reason: 'unknown-yield' }]);
  });

  it("still states what one craft takes when the item's own yield is in doubt, and makes no count of it", () => {
    const totals = cardTotals(ix, cardOf('MysteryStew'), 1, 'step', 2);
    expect(rows(totals.rows)).toEqual({ Thistle: 4, NeckTail: 2 });
    expect(totals.made).toBeNull();
  });

  it('totals nothing across a step the wiki has no recipe for, and says which', () => {
    expect(cardTotals(ix, cardOf('ShieldGapped'), 4, 'total', 1)).toMatchObject({ rows: [], fuel: [], missing: [3] });
    expect(cardTotals(ix, cardOf('ShieldGapped'), 3, 'step', 1)).toMatchObject({ rows: [], missing: [3] });
    expect(rows(cardTotals(ix, cardOf('ShieldGapped'), 4, 'step', 1).rows)).toEqual({ Wood: 6 });
  });

  it("shows a material made only as a choice by that choice, on the material's own card", () => {
    // Coal's only recipe is the kiln's: on Coal's page that is how it is made.
    expect(cardTotals(ix, cardOf('Coal'), 1, 'step', 3).rows).toEqual([{ id: 'Wood', qty: 3 }]);
  });

  it('agrees to the unit with the planner, for the target the card would add', () => {
    const cases: [ItemId, number, 'step' | 'total' | 'raw', number][] = [
      ['SwordIron', 3, 'step', 2],
      ['SwordIron', 4, 'total', 1],
      ['SwordIron', 4, 'raw', 3],
      ['Karve', 1, 'raw', 1],
      ['BronzeNails', 1, 'raw', 3],
      ['MeadPoisonResist', 1, 'raw', 2],
    ];
    for (const [id, quality, mode, crafts] of cases) {
      const card = cardTotals(ix, cardOf(id), quality, mode, crafts);
      const needs = planNeeds(ix, [planItemFor(ix, cardOf(id), quality, mode, crafts)]);
      const label = `${id} ${quality} ${mode} ×${crafts}`;
      expect(rows(card.rows), label).toEqual(plain(mode === 'raw' ? needs.raw : needs.direct));
      // The planner's fuel is the whole list's, breakdown included, which is the card's in raw mode only:
      // listing this level's materials, it names the fuel of this level's own steps.
      if (mode === 'raw') expect(rows(card.fuel), label).toEqual(plain(needs.fuel));
      // The planner counts what a batch makes only where it is more than one.
      if ((card.yield ?? 1) > 1) expect(card.made, label).toBe(needs.made[0]!.made);
    }
  });

  it('states the yield only where the crafts make the item new and the wiki says how many', () => {
    expect(cardTotals(ix, cardOf('BronzeNails'), 1, 'step', 1)).toMatchObject({ yield: 20, made: 20 });
    expect(cardTotals(ix, cardOf('SwordIron'), 1, 'step', 2)).toMatchObject({ yield: 1, made: 2 });
    expect(cardTotals(ix, cardOf('SwordIron'), 3, 'total', 2)).toMatchObject({ yield: 1, made: 2 });
    // An upgrade makes nothing new.
    expect(cardTotals(ix, cardOf('SwordIron'), 3, 'step', 2)).toMatchObject({ yield: null, made: null, yieldInDoubt: false });
    // A doubt the card names rather than a count it makes up.
    expect(cardTotals(ix, cardOf('MysteryStew'), 1, 'step', 1)).toMatchObject({ yield: null, made: null, yieldInDoubt: true });
  });
});

describe('cardStep', () => {
  it('gives the station and method of the level shown', () => {
    expect(cardStep(ix, cardOf('SwordIron'), 3)).toMatchObject({ station: 'forge', stationLevel: 4, method: 'craft' });
    expect(cardStep(ix, cardOf('wood_stack'), 1)).toMatchObject({ station: null, method: 'build' });
    expect(cardStep(ix, cardOf('Coal'), 1)).toMatchObject({ station: 'charcoal_kiln', method: 'kiln' });
    expect(cardStep(ix, cardOf('ShieldGapped'), 3)).toBeNull();
  });
});

describe('cardModes', () => {
  it('offers the levels from new only past the first, where they are this level', () => {
    expect(cardModes(ix, cardOf('SwordIron'), 1)).toEqual(['step', 'raw']);
    expect(cardModes(ix, cardOf('SwordIron'), 2)).toEqual(['step', 'total', 'raw']);
  });

  it('offers raw materials only where something breaks down', () => {
    expect(cardModes(ix, cardOf('wood_stack'), 1)).toEqual(['step']);
    expect(cardModes(ix, cardOf('Karve'), 1)).toEqual(['step', 'raw']);
    // A doubtful yield stops the breakdown, which still says so.
    expect(cardModes(ix, cardOf('StewPlatter'), 1)).toEqual(['step', 'raw']);
  });
});

describe('planItemFor', () => {
  it('adds the step shown, or everything from new', () => {
    expect(planItemFor(ix, cardOf('SwordIron'), 3, 'step', 1)).toEqual({ id: 'SwordIron', level: 3, from: 2, qty: 1 });
    expect(planItemFor(ix, cardOf('SwordIron'), 3, 'total', 2)).toEqual({ id: 'SwordIron', level: 3, from: 0, qty: 2 });
    expect(planItemFor(ix, cardOf('SwordIron'), 3, 'raw', 1)).toEqual({ id: 'SwordIron', level: 3, from: 0, qty: 1 });
  });

  it('counts items, not crafts: two crafts of nails are forty nails', () => {
    expect(planItemFor(ix, cardOf('BronzeNails'), 1, 'step', 2)).toEqual({ id: 'BronzeNails', level: 1, from: 0, qty: 40 });
    expect(planItemFor(ix, cardOf('MeadPoisonResist'), 1, 'raw', 1)).toMatchObject({ qty: 6 });
  });
});

describe('clampCrafts', () => {
  it('keeps a count between 1 and 99, and reads what a reader may type', () => {
    expect(clampCrafts(0)).toBe(1);
    expect(clampCrafts(150)).toBe(99);
    expect(clampCrafts(Number.NaN)).toBe(1);
    expect(clampCrafts(3.7)).toBe(3);
  });
});
