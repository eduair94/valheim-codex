import { describe, expect, it } from 'vitest';
import { expandRaw, indexGraph, totalCost } from '@/lib/craft/math';
import { planNeeds, targetStep } from '@/lib/craft/plan';
import type { PlanItem } from '@/lib/craft/planner-store';
import type { GraphItem, GraphRecipe, ItemId, RecipeGraph } from '@/lib/craft/types';

/**
 * What a planner list needs, on the fixture graph `tests/unit/craft-math.test.ts`
 * checks the maths on (copied, not imported: importing a test file would run
 * its tests here too). The planner and the article card must agree with that
 * maths to the unit, so the numbers below are the same ones: a Karve's 80
 * nails are 4 Bronze, an Iron Sword from 2 to 4 is 5 Wood, 50 Iron and 10
 * Leather scraps a sword.
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
  step('ArmorBronzeChest', 1, 'forge', 1, [['Bronze', 5], ['DeerHide', 2]], { from: 'Bronze Armor#Chest' }),
  step('ArmorBronzeChest', 2, 'forge', 2, [['Bronze', 3]], { from: 'Bronze Armor#Chest' }),
  step('ArmorBronzeChest', 3, 'forge', 3, [['Bronze', 6]], { from: 'Bronze Armor#Chest' }),
  step('ArmorBronzeChest', 4, 'forge', 4, [['Bronze', 9]], { from: 'Bronze Armor#Chest' }),
  step('piece_cauldron', 1, 'forge', 1, [['Tin', 10]], { method: 'build' }),
  step('piece_MeadCauldron', 1, 'forge', 1, [['Tin', 4], ['Copper', 6], ['LeatherScraps', 2]], { method: 'build' }),
  step('MeadPoisonResist', 1, 'fermenter', 1, [['MeadBasePoisonResist', 1]], { method: 'ferment', yield: 6 }),
  step('MeadBasePoisonResist', 1, 'piece_MeadCauldron', 1, [['Honey', 10], ['Thistle', 5], ['NeckTail', 1], ['Coal', 10]], { method: 'brew' }),
  step('Coal', 1, 'charcoal_kiln', 1, [['Wood', 1]], { method: 'kiln', alt: 1 }),
  step('ItemA', 1, 'piece_workbench', 1, [['BronzeNails', 50]]),
  step('ItemB', 1, 'piece_workbench', 1, [['BronzeNails', 40]]),
  step('ItemC', 1, 'piece_workbench', 1, [['BronzeNails', 30]]),
  step('Crate', 1, 'piece_workbench', 1, [['BronzeNails', 30]]),
  step('ItemE', 1, 'piece_workbench', 1, [['Crate', 1]]),
  step('ItemF', 1, 'piece_workbench', 1, [['Resin', 10]], { alt: 0 }),
  step('ItemF', 1, 'piece_workbench', 1, [['Resin', 8], ['Wood', 100], ['Feathers', 2]], { alt: 1 }),
  step('MysteryStew', 1, 'piece_cauldron', 3, [['Thistle', 2], ['NeckTail', 1]], { method: 'cook', yieldKnown: false }),
  step('StewPlatter', 1, 'piece_workbench', 1, [['MysteryStew', 2], ['Wood', 1]]),
  step('ShieldGapped', 1, 'forge', 1, [['Wood', 4]]),
  step('ShieldGapped', 2, 'forge', 2, [['Wood', 2]]),
  step('ShieldGapped', 4, 'forge', 4, [['Wood', 6]]),
  step('PickaxeAntler', 1, 'piece_workbench', 1, [['Wood', 10], ['HardAntler', 1]]),
  step('ArrowFire', 1, 'piece_workbench', 2, [['Wood', 8], ['Resin', 8], ['Feathers', 2]], { yield: 20 }),
]);
const ix = indexGraph(GRAPH);

const plain = (map: Map<ItemId, number>) => Object.fromEntries(map);
const target = (id: ItemId, qty = 1, level = 1, from = 0): PlanItem => ({ id, level, from, qty });

describe('planNeeds', () => {
  it('needs a Karve’s materials and expands its nails', () => {
    const n = planNeeds(ix, [target('Karve')]);
    expect(plain(n.direct)).toEqual({ FineWood: 30, DeerHide: 10, Resin: 20, BronzeNails: 80 });
    expect(n.direct.get('BronzeNails')).toBe(80);
    expect(n.raw.get('CopperOre')).toBe(8);
    expect(n.raw.get('TinOre')).toBe(4);
    expect(plain(n.raw)).toEqual({ FineWood: 30, DeerHide: 10, Resin: 20, CopperOre: 8, TinOre: 4 });
    // Smelting 8 copper and 4 tin bars burns 2 Coal a bar.
    expect(plain(n.fuel)).toEqual({ Coal: 24 });
    // The steps in between, inputs first; the Karve itself is the target, not a step.
    const order = n.crafts.map((s) => s.recipe.product);
    expect(order).not.toContain('Karve');
    expect(order.indexOf('Bronze')).toBeLessThan(order.indexOf('BronzeNails'));
    expect(n.crafts.find((s) => s.recipe.product === 'BronzeNails')).toMatchObject({ crafts: 4, produced: 80 });
    // The workbench the Karve itself is built at counts too.
    expect(plain(n.stations)).toEqual({ smelter: 1, forge: 1, piece_workbench: 1 });
    expect([n.unexpanded, n.missing, n.unknown, n.made]).toEqual([[], [], [], []]);
  });

  it('rounds a target’s crafts up and reports the leftover', () => {
    const n = planNeeds(ix, [target('BronzeNails', 30)]);
    expect(n.made).toEqual([{ id: 'BronzeNails', crafts: 2, made: 40, leftover: 10 }]);
    expect(plain(n.direct)).toEqual({ Bronze: 2 });
  });

  it('makes a mead batch of six for one mead', () => {
    const n = planNeeds(ix, [target('MeadPoisonResist')]);
    expect(n.made).toEqual([{ id: 'MeadPoisonResist', crafts: 1, made: 6, leftover: 5 }]);
    expect(plain(n.raw)).toEqual({ Honey: 10, Thistle: 5, NeckTail: 1, Coal: 10 });
  });

  it('rounds once for every entry of one item, as the maths rounds an intermediate', () => {
    // 30 nails twice is 60, three crafts of 20, not two and two.
    const n = planNeeds(ix, [target('BronzeNails', 30), { ...target('BronzeNails', 30), level: 1 }]);
    expect(n.made).toEqual([{ id: 'BronzeNails', crafts: 3, made: 60, leftover: 0 }]);
    expect(plain(n.direct)).toEqual({ Bronze: 3 });
  });

  it('upgrades three swords from level 2 to 4', () => {
    const n = planNeeds(ix, [target('SwordIron', 3, 4, 2)]);
    expect(Object.fromEntries(n.direct)).toEqual({ Wood: 15, Iron: 150, LeatherScraps: 30 });
    expect(n.stations.get('forge')).toBe(5);
    expect(n.made).toEqual([]);
  });

  it('agrees with the maths on a new item’s whole range of levels', () => {
    // Bronze plate cuirass 0 → 4: 23 Bronze and 2 Deer hide, 46 Copper ore and 23 Tin ore.
    const n = planNeeds(ix, [target('ArmorBronzeChest', 1, 4)]);
    expect(plain(n.direct)).toEqual(plain(totalCost(ix, 'ArmorBronzeChest', 0, 4)));
    expect(plain(n.raw)).toEqual(plain(expandRaw(ix, totalCost(ix, 'ArmorBronzeChest', 0, 4)).raw));
    expect(plain(n.raw)).toEqual({ CopperOre: 46, TinOre: 23, DeerHide: 2 });
    expect(n.stations.get('forge')).toBe(4);
  });

  it('counts the fuel of a target’s own step', () => {
    const n = planNeeds(ix, [target('Copper', 5)]);
    expect(plain(n.direct)).toEqual({ CopperOre: 5 });
    expect(plain(n.fuel)).toEqual({ Coal: 10 });
    expect(plain(n.stations)).toEqual({ smelter: 1 });
  });

  it('does not break down what the reader holds', () => {
    expect(planNeeds(ix, [target('Karve')], new Map([['Bronze', 4]])).raw.get('CopperOre') ?? 0).toBe(0);
    // Holding the nails stops the breakdown at the nails.
    const nails = planNeeds(ix, [target('Karve')], new Map([['BronzeNails', 80]]));
    expect(nails.raw.has('CopperOre')).toBe(false);
    expect(nails.crafts).toEqual([]);
  });

  it('keeps a raw material at its whole need, for the list to compare with what is held', () => {
    // "Tengo 10 de 30": the count is shown beside the need, never taken off it.
    const n = planNeeds(ix, [target('Karve')], new Map([['FineWood', 10]]));
    expect(n.raw.get('FineWood')).toBe(30);
    expect(n.direct.get('FineWood')).toBe(30);
  });

  it('names a target whose yield the wiki leaves in doubt, and adds nothing for it', () => {
    const n = planNeeds(ix, [target('MysteryStew', 3)]);
    expect(n.unexpanded).toEqual([{ id: 'MysteryStew', need: 3, reason: 'unknown-yield' }]);
    expect([n.direct.size, n.raw.size, n.fuel.size, n.made.length]).toEqual([0, 0, 0, 0]);
    // As a target and inside another, one row with the whole need.
    const both = planNeeds(ix, [target('MysteryStew', 3), target('StewPlatter')]);
    expect(both.unexpanded).toEqual([{ id: 'MysteryStew', need: 5, reason: 'unknown-yield' }]);
    expect(plain(both.raw)).toEqual({ Wood: 1 });
  });

  it('names unknown targets and missing steps', () => {
    const n = planNeeds(ix, [
      target('Nope', 2),
      target('ShieldGapped', 1, 4),
      target('PickaxeAntler', 1, 3, 1),
      target('Nope'),
      target('SwordIron', 1, 5),
    ]);
    expect(n.unknown).toEqual(['Nope']);
    expect(n.missing).toEqual([
      { id: 'ShieldGapped', steps: [3] },
      { id: 'PickaxeAntler', steps: [2, 3] },
      { id: 'SwordIron', steps: [5] },
    ]);
    // What the graph has is still counted: the shield's steps 1, 2 and 4 and the sword's 1 to 4.
    expect(n.direct.get('Wood')).toBe(4 + 2 + 6 + 8);
  });

  it('plans a target whose only recipe is an alternative with the wiki’s first one', () => {
    // Coal comes from the charcoal kiln only as a choice: no breakdown burns
    // wood for a smelter's coal, but a reader who lists Coal has chosen the kiln.
    const n = planNeeds(ix, [target('Coal', 10)]);
    expect(plain(n.direct)).toEqual({ Wood: 10 });
    expect(plain(n.raw)).toEqual({ Wood: 10 });
    expect(plain(n.stations)).toEqual({ charcoal_kiln: 1 });
    expect([n.missing, n.unexpanded, n.made]).toEqual([[], [], []]);
    // As an ingredient it stays a gathered material, as the maths keeps it.
    expect(planNeeds(ix, [target('MeadPoisonResist')]).raw.get('Coal')).toBe(10);
  });

  it('needs nothing for an empty list', () => {
    const n = planNeeds(ix, []);
    expect([n.direct.size, n.raw.size, n.fuel.size, n.crafts.length, n.stations.size, n.leftovers.size]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('reports the leftovers of the steps in between', () => {
    // 50 nails for ItemA: 3 crafts of 20, 10 nails over.
    expect(plain(planNeeds(ix, [target('ItemA')]).leftovers)).toEqual({ BronzeNails: 10 });
  });

  it('lets the rest of the list use what a target’s batches leave over, as the maths would', () => {
    // 30 nails wanted are two crafts, 10 over; ItemA's 50 take those 10 and
    // two more crafts: four in all, as the maths makes 80 nails, not five.
    const n = planNeeds(ix, [target('BronzeNails', 30), target('ItemA')]);
    expect(n.made).toEqual([{ id: 'BronzeNails', crafts: 2, made: 40, leftover: 0 }]);
    expect(n.crafts.find((s) => s.recipe.product === 'BronzeNails')).toMatchObject({ crafts: 2, produced: 40 });
    expect(plain(n.raw)).toEqual({ CopperOre: 8, TinOre: 4 });
    expect(plain(n.leftovers)).toEqual({});
    // With a Karve, 110 nails: six crafts, and the last one's 10 over are the breakdown's.
    const karve = planNeeds(ix, [target('BronzeNails', 30), target('Karve')]);
    expect(karve.made).toEqual([{ id: 'BronzeNails', crafts: 2, made: 40, leftover: 0 }]);
    expect(karve.crafts.find((s) => s.recipe.product === 'BronzeNails')).toMatchObject({ crafts: 4, produced: 80 });
    expect(plain(karve.leftovers)).toEqual({ BronzeNails: 10 });
  });

  it('keeps as a target’s leftover what the rest of the list does not take', () => {
    const bench = indexGraph(graphOf([...GRAPH.recipes, step('Bench', 1, 'piece_workbench', 1, [['BronzeNails', 5]])]));
    // 30 nails and a bench's 5: two crafts make 40, and 5 are over.
    const n = planNeeds(bench, [target('BronzeNails', 30), target('Bench')]);
    expect(n.made).toEqual([{ id: 'BronzeNails', crafts: 2, made: 40, leftover: 5 }]);
    expect(n.crafts.some((s) => s.recipe.product === 'BronzeNails')).toBe(false);
    expect(plain(n.leftovers)).toEqual({});
    // The reader's own 3 nails go to the bench first: 2 of the 10 over are taken.
    const held = planNeeds(bench, [target('BronzeNails', 30), target('Bench')], new Map([['BronzeNails', 3]]));
    expect(held.made).toEqual([{ id: 'BronzeNails', crafts: 2, made: 40, leftover: 8 }]);
    // Holding the target itself never shrinks the target: the list says what to make.
    const alone = planNeeds(bench, [target('BronzeNails', 30)], new Map([['BronzeNails', 100]]));
    expect(alone.made).toEqual([{ id: 'BronzeNails', crafts: 2, made: 40, leftover: 10 }]);
  });
});

describe('targetStep', () => {
  it('is the recipe the maths plans with, where there is one', () => {
    expect(targetStep(ix, 'Copper', 1)?.inputs).toEqual([['CopperOre', 1]]);
    expect(targetStep(ix, 'SwordIron', 3)?.stationLevel).toBe(4);
  });

  it('is the wiki’s first alternative where every recipe is one', () => {
    const kiln = indexGraph(
      graphOf([
        step('Coal', 1, 'charcoal_kiln', 1, [['RoundLog', 1]], { method: 'kiln', alt: 3 }),
        step('Coal', 1, 'charcoal_kiln', 1, [['Wood', 1]], { method: 'kiln', alt: 1 }),
        step('Coal', 1, 'charcoal_kiln', 1, [['FineWood', 1]], { method: 'kiln', alt: 2 }),
      ]),
    );
    expect(targetStep(kiln, 'Coal', 1)?.inputs).toEqual([['Wood', 1]]);
  });

  it('is null where the graph has no recipe for the step', () => {
    expect(targetStep(ix, 'Wood', 1)).toBeNull();
    expect(targetStep(ix, 'ShieldGapped', 3)).toBeNull();
    expect(targetStep(ix, 'Nope', 1)).toBeNull();
  });
});

describe('planNeeds against the maths', () => {
  /** A seeded generator, so a failing list can be run again. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  const sum = (map: Map<ItemId, number>, id: ItemId, qty: number) => map.set(id, (map.get(id) ?? 0) + qty);

  // The fixture, and things that take less of a batched item than a batch
  // can leave over (a bench's 5 nails, a quiver's 5 arrows), and a batched
  // item made from another (bundles of arrows), so lists reach every way a
  // target's leftover can be taken.
  const wide = indexGraph(
    graphOf([
      ...GRAPH.recipes,
      step('Bench', 1, 'piece_workbench', 1, [['BronzeNails', 5]]),
      step('Quiver', 1, 'piece_workbench', 1, [['ArrowFire', 5], ['DeerHide', 1]]),
      step('ArrowBundle', 1, null, 1, [['ArrowFire', 3]], { yield: 2 }),
      step('Rack', 1, 'piece_workbench', 1, [['ArrowBundle', 1], ['MeadPoisonResist', 2]]),
    ]),
  );

  /**
   * What the maths makes of a list as one demand: every new item, and every
   * upgrade's materials, all rounded at once. The planner rounds a target's
   * own batches first and hands what they leave over to the rest of the list,
   * which must come to the same crafts, materials, fuel and leftovers.
   */
  function asOneDemand(items: PlanItem[], have: Map<ItemId, number>) {
    const demand = new Map<ItemId, number>();
    for (const item of items) {
      if (item.from === 0) sum(demand, item.id, item.qty);
      for (const [id, qty] of totalCost(wide, item.id, Math.max(item.from, 1), item.level)) sum(demand, id, qty * item.qty);
    }
    return expandRaw(wide, demand, { have });
  }

  it('comes to the same numbers on random lists', () => {
    // Every product but Coal, which the maths keeps as a gathered material.
    const products = [...wide.recipes.keys()].filter((id) => id !== 'Coal');
    // Half the picks are batched items and what takes them, and half the
    // quantities small, so leftovers are often taken: of the 600 lists,
    // about 150 take one, 30 of them only in part, and 20 hold a chain of
    // batches.
    const batched = ['BronzeNails', 'Bench', 'ItemA', 'Karve', 'ArrowFire', 'Quiver', 'ArrowBundle', 'Rack', 'MeadPoisonResist'];
    const next = random(20261028);
    const pick = <T,>(list: T[]): T => list[Math.floor(next() * list.length)]!;
    for (let round = 0; round < 600; round += 1) {
      const items: PlanItem[] = Array.from({ length: 1 + Math.floor(next() * 5) }, () => {
        const id = next() < 0.5 ? pick(batched) : pick(products);
        const level = 1 + Math.floor(next() * wide.items.get(id)!.maxQuality);
        const qty = 1 + Math.floor(next() * (next() < 0.5 ? 3 : 60));
        return { id, level, from: next() < 0.6 ? 0 : Math.floor(next() * level), qty };
      });
      // What the reader holds of anything but the targets, whose own counts the list never takes.
      const have = new Map<ItemId, number>();
      for (const id of ['Bronze', 'Copper', 'Tin', 'Iron', 'BronzeNails', 'Crate', 'MeadBasePoisonResist', 'MeadPoisonResist', 'ArrowFire']) {
        if (!items.some((item) => item.id === id) && next() < 0.3) have.set(id, Math.floor(next() * 40));
      }

      const n = planNeeds(wide, items, have);
      const maths = asOneDemand(items, have);
      const label = JSON.stringify({ items, have: [...have] });

      const crafts = new Map<ItemId, number>();
      for (const step of n.crafts) sum(crafts, step.recipe.product, step.crafts);
      for (const entry of n.made) sum(crafts, entry.id, entry.crafts);
      // A target that makes one a craft is made once per item, and is not in `made`.
      for (const item of items) {
        const recipe = item.from === 0 ? targetStep(wide, item.id, 1) : null;
        if (recipe?.yieldKnown && recipe.yield === 1) sum(crafts, item.id, item.qty);
      }
      const leftovers = new Map(n.leftovers);
      for (const entry of n.made) if (entry.leftover > 0) sum(leftovers, entry.id, entry.leftover);
      const mathsCrafts = new Map<ItemId, number>();
      for (const step of maths.crafts) sum(mathsCrafts, step.recipe.product, step.crafts);

      expect(plain(n.raw), label).toEqual(plain(maths.raw));
      expect(plain(n.fuel), label).toEqual(plain(maths.fuel));
      expect(Object.fromEntries([...crafts].sort()), label).toEqual(Object.fromEntries([...mathsCrafts].sort()));
      expect(Object.fromEntries([...leftovers].sort()), label).toEqual(Object.fromEntries([...maths.leftovers].sort()));
    }
  });
});
