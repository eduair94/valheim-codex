import { describe, expect, it } from 'vitest';
import {
  craftable,
  expandRaw,
  indexGraph,
  missingSteps,
  stationsNeeded,
  stepCost,
  totalCost,
  usedIn,
} from '@/lib/craft/math';
import type { GraphItem, GraphRecipe, ItemId, RecipeGraph } from '@/lib/craft/types';

/**
 * Every number a reader sees about crafting comes from these functions, so
 * each case is one a player would check by hand: the Iron Sword's total
 * matches the wiki's own "Total" row, a Karve's 80 nails are 4 Bronze and
 * not 80, a smelter burns 2 coal per bar. Ids are the game's; the recipes
 * are the wiki's, except the few made-up products the cases need.
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
  // Each tab is the cost of that step alone; the wiki's Total row reads
  // 8 Wood, 80 Iron, 15 Leather scraps.
  step('SwordIron', 1, 'forge', 2, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 3]]),
  step('SwordIron', 2, 'forge', 3, [['Wood', 1], ['Iron', 10], ['LeatherScraps', 2]]),
  step('SwordIron', 3, 'forge', 4, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 4]]),
  step('SwordIron', 4, 'forge', 5, [['Wood', 3], ['Iron', 30], ['LeatherScraps', 6]]),
  // Smelting burns 2 Coal per bar (the overrides' fuel line). Copper from
  // scrap is an alternative, never planned with unless chosen.
  step('Iron', 1, 'smelter', 1, [['IronScrap', 1]], { method: 'smelt', fuel: ['Coal', 2] }),
  step('Copper', 1, 'smelter', 1, [['CopperOre', 1]], { method: 'smelt', fuel: ['Coal', 2], alt: 0 }),
  step('Copper', 1, 'smelter', 1, [['CopperScrap', 1]], { method: 'smelt', fuel: ['Coal', 2], alt: 1 }),
  step('Tin', 1, 'smelter', 1, [['TinOre', 1]], { method: 'smelt', fuel: ['Coal', 2] }),
  step('Bronze', 1, 'forge', 1, [['Copper', 2], ['Tin', 1]]),
  step('BronzeNails', 1, 'forge', 1, [['Bronze', 1]], { yield: 20 }),
  step('Karve', 1, 'piece_workbench', 1, [['FineWood', 30], ['DeerHide', 10], ['Resin', 20], ['BronzeNails', 80]], { method: 'build' }),
  // Bronze plate cuirass, from a tab of its set's page.
  step('ArmorBronzeChest', 1, 'forge', 1, [['Bronze', 5], ['DeerHide', 2]], { from: 'Bronze Armor#Chest' }),
  step('ArmorBronzeChest', 2, 'forge', 2, [['Bronze', 3]], { from: 'Bronze Armor#Chest' }),
  step('ArmorBronzeChest', 3, 'forge', 3, [['Bronze', 6]], { from: 'Bronze Armor#Chest' }),
  step('ArmorBronzeChest', 4, 'forge', 4, [['Bronze', 9]], { from: 'Bronze Armor#Chest' }),
  // The stations Tin goes into.
  step('piece_cauldron', 1, 'forge', 1, [['Tin', 10]], { method: 'build' }),
  step('piece_MeadCauldron', 1, 'forge', 1, [['Tin', 4], ['Copper', 6], ['LeatherScraps', 2]], { method: 'build' }),
  // One mead base ferments into six meads.
  step('MeadPoisonResist', 1, 'fermenter', 1, [['MeadBasePoisonResist', 1]], { method: 'ferment', yield: 6 }),
  step('MeadBasePoisonResist', 1, 'piece_MeadCauldron', 1, [['Honey', 10], ['Thistle', 5], ['NeckTail', 1], ['Coal', 10]], { method: 'brew' }),
  // Coal's only recipe, the charcoal kiln, is an alternative (`alt` 1 with
  // nothing at 0, as the types say): coal is still a raw material.
  step('Coal', 1, 'charcoal_kiln', 1, [['Wood', 1]], { method: 'kiln', alt: 1 }),
  // Made up: things that need nails, one of them through a crate.
  step('ItemA', 1, 'piece_workbench', 1, [['BronzeNails', 50]]),
  step('ItemB', 1, 'piece_workbench', 1, [['BronzeNails', 40]]),
  step('ItemC', 1, 'piece_workbench', 1, [['BronzeNails', 30]]),
  step('Crate', 1, 'piece_workbench', 1, [['BronzeNails', 30]]),
  step('ItemE', 1, 'piece_workbench', 1, [['Crate', 1]]),
  // Made up: a product made two ways, for what an inventory makes either way.
  step('ItemF', 1, 'piece_workbench', 1, [['Resin', 10]], { alt: 0 }),
  step('ItemF', 1, 'piece_workbench', 1, [['Resin', 8], ['Wood', 100], ['Feathers', 2]], { alt: 1 }),
  // Made up: a dish whose yield the wiki does not settle, and a platter of it.
  step('MysteryStew', 1, 'piece_cauldron', 3, [['Thistle', 2], ['NeckTail', 1]], { method: 'cook', yieldKnown: false }),
  step('StewPlatter', 1, 'piece_workbench', 1, [['MysteryStew', 2], ['Wood', 1]]),
  // An item with a missing upgrade tab (the wiki's cell for quality 3 was unreadable).
  step('ShieldGapped', 1, 'forge', 1, [['Wood', 4]]),
  step('ShieldGapped', 2, 'forge', 2, [['Wood', 2]]),
  step('ShieldGapped', 4, 'forge', 4, [['Wood', 6]]),
  // What a first day's inventory is one ingredient short of: a tool that
  // needs Eikthyr's antler, and arrows that need feathers.
  step('PickaxeAntler', 1, 'piece_workbench', 1, [['Wood', 10], ['HardAntler', 1]]),
  step('ArrowFire', 1, 'piece_workbench', 2, [['Wood', 8], ['Resin', 8], ['Feathers', 2]], { yield: 20 }),
]);
const ix = indexGraph(GRAPH);

const plain = (map: Map<ItemId, number>) => Object.fromEntries(map);

describe('stepCost and totalCost', () => {
  it('give one step its own cost', () => {
    expect(stepCost(ix, 'SwordIron', 3)).toMatchObject({
      station: 'forge',
      stationLevel: 4,
      inputs: [['Wood', 2], ['Iron', 20], ['LeatherScraps', 4]],
    });
    expect(stepCost(ix, 'SwordIron', 5)).toBeNull();
    expect(stepCost(ix, 'Flametal', 1)).toBeNull();
  });

  it('use the preferred recipe, not an alternative', () => {
    expect(stepCost(ix, 'Copper', 1)!.inputs).toEqual([['CopperOre', 1]]);
    // Coal has only the kiln, which is an alternative: there is no step to plan with.
    expect(stepCost(ix, 'Coal', 1)).toBeNull();
  });

  it('total Iron Sword from new to quality 4', () => {
    expect(plain(totalCost(ix, 'SwordIron', 0, 4))).toEqual({ Wood: 8, Iron: 80, LeatherScraps: 15 });
  });

  it('upgrade only the missing steps', () => {
    expect(plain(totalCost(ix, 'SwordIron', 2, 4))).toEqual({ Wood: 5, Iron: 50, LeatherScraps: 10 });
    expect(totalCost(ix, 'SwordIron', 4, 4).size).toBe(0);
  });

  it('total the Bronze plate cuirass from new to quality 4', () => {
    expect(plain(totalCost(ix, 'ArmorBronzeChest', 0, 4))).toEqual({ Bronze: 23, DeerHide: 2 });
  });
});

describe('missingSteps', () => {
  it('names the steps a total would silently leave out', () => {
    expect(missingSteps(ix, 'ShieldGapped', 0, 4)).toEqual([3]);
    expect(missingSteps(ix, 'ShieldGapped', 3, 4)).toEqual([]);
    expect(missingSteps(ix, 'SwordIron', 0, 4)).toEqual([]);
    expect(missingSteps(ix, 'SwordIron', 0, 5)).toEqual([5]);
  });
});

describe('expandRaw', () => {
  it('expands a Karve through the nails yield', () => {
    const r = expandRaw(ix, new Map([['Karve', 1]]));
    expect(r.raw.get('CopperOre')).toBe(8);
    expect(r.raw.get('TinOre')).toBe(4);
    expect(plain(r.raw)).toEqual({ FineWood: 30, DeerHide: 10, Resin: 20, CopperOre: 8, TinOre: 4 });
    expect(r.crafts.find((s) => s.recipe.product === 'BronzeNails')).toMatchObject({ crafts: 4, produced: 80 });
    expect(r.crafts.find((s) => s.recipe.product === 'Bronze')).toMatchObject({ crafts: 4, produced: 4 });
    expect(r.unexpanded).toEqual([]);
  });

  it('lists the steps in the order they can be made', () => {
    const order = expandRaw(ix, new Map([['Karve', 1]])).crafts.map((s) => s.recipe.product);
    expect(order.indexOf('Copper')).toBeLessThan(order.indexOf('Bronze'));
    expect(order.indexOf('Tin')).toBeLessThan(order.indexOf('Bronze'));
    expect(order.indexOf('Bronze')).toBeLessThan(order.indexOf('BronzeNails'));
    expect(order.at(-1)).toBe('Karve');
  });

  it('rounds a part craft up, never to the nearest', () => {
    // One mead is still a whole batch of six, five left over.
    const mead = expandRaw(ix, new Map([['MeadPoisonResist', 1]]));
    expect(mead.crafts.find((s) => s.recipe.product === 'MeadPoisonResist')).toMatchObject({ crafts: 1, produced: 6 });
    expect(mead.leftovers.get('MeadPoisonResist')).toBe(5);
    expect(plain(mead.raw)).toEqual({ Honey: 10, Thistle: 5, NeckTail: 1, Coal: 10 });
    // 25 nails are two crafts of 20, not one.
    const nails = expandRaw(ix, new Map([['BronzeNails', 25]]));
    expect(nails.crafts.find((s) => s.recipe.product === 'BronzeNails')).toMatchObject({ crafts: 2, produced: 40 });
    expect(nails.leftovers.get('BronzeNails')).toBe(15);
  });

  it('aggregates demand before rounding crafts', () => {
    // 50 and 40 nails: 90 nails is 5 crafts and 100 nails, 10 left over.
    const r = expandRaw(ix, new Map([['ItemA', 1], ['ItemB', 1]]));
    expect(r.crafts.find((s) => s.recipe.product === 'BronzeNails')!.crafts).toBe(5);
    expect(r.leftovers.get('BronzeNails')).toBe(10);
  });

  it('rounds once for the whole list, not once per item', () => {
    // 50 and 30 nails are 80, 4 crafts; rounding each alone gives 3 + 2 = 5.
    const r = expandRaw(ix, new Map([['ItemA', 1], ['ItemC', 1]]));
    expect(r.crafts.find((s) => s.recipe.product === 'BronzeNails')!.crafts).toBe(4);
    expect(r.leftovers.has('BronzeNails')).toBe(false);
  });

  it('rounds once even when the same material is needed at different depths', () => {
    // ItemA needs 50 nails itself; ItemE needs a crate, which needs 30.
    // Expanding level by level would round 50 and then 30: 3 + 2 crafts.
    const r = expandRaw(ix, new Map([['ItemA', 1], ['ItemE', 1]]));
    expect(r.crafts.find((s) => s.recipe.product === 'BronzeNails')!.crafts).toBe(4);
  });

  it('counts smelter fuel separately', () => {
    // 2 per bar: 8 bars of copper and 4 of tin.
    const r = expandRaw(ix, new Map([['Bronze', 4]]));
    expect(r.fuel.get('Coal')).toBe(24);
    expect(r.raw.has('Coal')).toBe(false);
    expect(plain(r.raw)).toEqual({ CopperOre: 8, TinOre: 4 });
  });

  it('takes a demand made of totals, as the planner builds it', () => {
    // Bronze plate cuirass 1 to 4: 23 Bronze and 2 Deer hide.
    const r = expandRaw(ix, totalCost(ix, 'ArmorBronzeChest', 0, 4));
    expect(plain(r.raw)).toEqual({ CopperOre: 46, TinOre: 23, DeerHide: 2 });
  });

  it('follows a yield at the top: six meads are one batch', () => {
    const r = expandRaw(ix, new Map([['MeadPoisonResist', 6]]));
    expect(plain(r.raw)).toEqual({ Honey: 10, Thistle: 5, NeckTail: 1, Coal: 10 });
    expect(r.crafts.find((s) => s.recipe.product === 'MeadPoisonResist')).toMatchObject({ crafts: 1, produced: 6 });
  });

  it('stops at what the reader has', () => {
    expect(expandRaw(ix, new Map([['Karve', 1]]), { have: new Map([['Bronze', 4]]) }).raw.get('CopperOre') ?? 0).toBe(0);
    // One bar short: three more to smelt and make.
    const r = expandRaw(ix, new Map([['Karve', 1]]), { have: new Map([['Bronze', 1]]) });
    expect(r.raw.get('CopperOre')).toBe(6);
    expect(r.crafts.find((s) => s.recipe.product === 'Bronze')!.crafts).toBe(3);
  });

  it('keeps a raw material at its full need, so a ticked row stays on the list', () => {
    // "Tengo 10 de 30": the row compares, the maths does not subtract.
    const r = expandRaw(ix, new Map([['Karve', 1]]), { have: new Map([['FineWood', 10]]) });
    expect(r.raw.get('FineWood')).toBe(30);
  });

  it('never burns wood for coal: a lone alternative is not planned with', () => {
    // Coal's one recipe is the charcoal kiln, numbered as an alternative:
    // coal is gathered, and the kiln is a choice the reader makes.
    const r = expandRaw(ix, new Map([['Coal', 10]]));
    expect(plain(r.raw)).toEqual({ Coal: 10 });
    expect(r.crafts).toEqual([]);
    expect(missingSteps(ix, 'Coal', 0, 1)).toEqual([1]);
  });

  it('stops where it is told to', () => {
    const r = expandRaw(ix, new Map([['Karve', 1]]), { stopAt: new Set(['Bronze']) });
    expect(r.raw.get('Bronze')).toBe(4);
    expect(r.raw.has('CopperOre')).toBe(false);
  });

  it('treats an id the graph does not know as a raw material', () => {
    expect(plain(expandRaw(ix, new Map([['Flametal', 3]])).raw)).toEqual({ Flametal: 3 });
  });

  it('reports an unknown yield instead of assuming one', () => {
    expect(expandRaw(ix, new Map([['MysteryStew', 1]])).unexpanded).toContainEqual(
      expect.objectContaining({ reason: 'unknown-yield' }),
    );
    // Deeper in the tree: the platter is made, the stew is named, and none of
    // the stew's ingredients is guessed.
    const r = expandRaw(ix, new Map([['StewPlatter', 1]]));
    expect(r.unexpanded).toEqual([{ id: 'MysteryStew', need: 2, reason: 'unknown-yield' }]);
    expect(plain(r.raw)).toEqual({ Wood: 1 });
    expect(r.crafts.map((s) => s.recipe.product)).toEqual(['StewPlatter']);
  });

  it('reports an unknown yield at its whole need, to compare with what the reader holds', () => {
    // The breakdown stops at the stew as it does at the wood, so both rows
    // read the same way: holding one of the platter's two stews is "tengo 1
    // de 2", not a row of one that looks complete.
    const have = new Map([['MysteryStew', 1], ['Wood', 1]]);
    const r = expandRaw(ix, new Map([['StewPlatter', 1]]), { have });
    expect(r.unexpanded).toEqual([{ id: 'MysteryStew', need: 2, reason: 'unknown-yield' }]);
    expect(plain(r.raw)).toEqual({ Wood: 1 });
    // Holding both keeps the row, ticked, as a raw material's stays.
    const held = expandRaw(ix, new Map([['StewPlatter', 1]]), { have: new Map([['MysteryStew', 2]]) });
    expect(held.unexpanded).toEqual([{ id: 'MysteryStew', need: 2, reason: 'unknown-yield' }]);
  });

  it('needs nothing for an empty or non-positive demand', () => {
    const r = expandRaw(ix, new Map([['Karve', 0], ['Bronze', -2]]));
    expect([r.raw.size, r.fuel.size, r.crafts.length, r.leftovers.size, r.unexpanded.length]).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('expandRaw on a graph with cycles', () => {
  const cyclic = indexGraph(
    graphOf([
      step('A', 1, null, 1, [['B', 1]]),
      step('B', 1, null, 1, [['A', 1], ['Ore', 2]]),
      step('Loop', 1, null, 1, [['Loop', 1], ['Ore', 1]]),
      // Metal from ore is preferred; the alternative consumes metal itself.
      step('Metal', 1, 'smelter', 1, [['Ore', 1]], { alt: 0 }),
      step('Metal', 1, 'smelter', 1, [['Metal', 2]], { alt: 1 }),
    ]),
  );

  it('reports a cycle and terminates', () => {
    const r = expandRaw(cyclic, new Map([['A', 1]]));
    expect(r.unexpanded).toContainEqual(expect.objectContaining({ id: 'A', reason: 'cycle' }));
    expect(plain(r.raw)).toEqual({ Ore: 2 });
  });

  it('reports an item that needs itself', () => {
    const r = expandRaw(cyclic, new Map([['Loop', 1]]));
    expect(r.unexpanded).toEqual([{ id: 'Loop', need: 1, reason: 'cycle' }]);
    expect(plain(r.raw)).toEqual({ Ore: 1 });
  });

  it('counts a cycle’s row against everything the reader holds of it', () => {
    // Two A asked for and one held: the held one is the first A; making the
    // second takes a B, and a B takes an A again. Two A in all, one held.
    const r = expandRaw(cyclic, new Map([['A', 2]]), { have: new Map([['A', 1]]) });
    expect(r.unexpanded).toEqual([{ id: 'A', need: 2, reason: 'cycle' }]);
    expect(plain(r.raw)).toEqual({ Ore: 2 });
    // The held A goes to the A asked for, and the B asked for needs another.
    const both = expandRaw(cyclic, new Map([['A', 1], ['B', 1]]), { have: new Map([['A', 1]]) });
    expect(both.unexpanded).toEqual([{ id: 'A', need: 2, reason: 'cycle' }]);
  });

  it('plans with the preferred recipe when an alternative consumes the product', () => {
    const r = expandRaw(cyclic, new Map([['Metal', 3]]));
    expect(plain(r.raw)).toEqual({ Ore: 3 });
    expect(r.unexpanded).toEqual([]);
  });
});

describe('stationsNeeded', () => {
  it('needs the highest station level along the tree', () => {
    const r = expandRaw(ix, new Map([['SwordIron', 1]]));
    expect(stationsNeeded(r.crafts, [{ station: 'forge', level: 5 }]).get('forge')).toBe(5);
    expect(plain(stationsNeeded(r.crafts))).toEqual({ forge: 2, smelter: 1 });
  });

  it('names every station a Karve passes through', () => {
    const r = expandRaw(ix, new Map([['Karve', 1]]));
    expect(plain(stationsNeeded(r.crafts))).toEqual({ smelter: 1, forge: 1, piece_workbench: 1 });
  });

  it('keeps the highest level a station is asked for, whatever the order of the steps', () => {
    // The sword needs Forge level 2; the Karve's Bronze and nails, level 1.
    const r = expandRaw(ix, new Map([['SwordIron', 1], ['Karve', 1]]));
    expect(stationsNeeded(r.crafts).get('forge')).toBe(2);
    expect(stationsNeeded([...r.crafts].reverse()).get('forge')).toBe(2);
  });
});

describe('usedIn', () => {
  it('lists every recipe a material goes into', () => {
    expect([...new Set(usedIn(ix, 'Tin').map((u) => u.product))].sort()).toEqual(['Bronze', 'piece_MeadCauldron', 'piece_cauldron']);
  });

  it('gives each upgrade step its own quantity and station level', () => {
    expect(usedIn(ix, 'Iron')).toEqual([
      { product: 'SwordIron', quality: 1, qty: 20, station: 'forge', stationLevel: 2 },
      { product: 'SwordIron', quality: 2, qty: 10, station: 'forge', stationLevel: 3 },
      { product: 'SwordIron', quality: 3, qty: 20, station: 'forge', stationLevel: 4 },
      { product: 'SwordIron', quality: 4, qty: 30, station: 'forge', stationLevel: 5 },
    ]);
    expect(usedIn(ix, 'Flametal')).toEqual([]);
  });
});

describe('craftable', () => {
  /**
   * What one craft of a product still lacks, where `almost` lists it, as a
   * plain object. Not `toContainEqual` on the entries: it compares Maps by
   * their own keys, which a Map has none of, so any `missing` would match.
   */
  const lacking = (result: ReturnType<typeof craftable>, product: ItemId) => {
    const entry = result.almost.find((a) => a.product === product);
    return entry && plain(entry.missing);
  };

  it('counts the crafts an inventory allows', () => {
    const c = craftable(ix, new Map([['Copper', 4], ['Tin', 2]]));
    expect(c.now).toContainEqual({ product: 'Bronze', crafts: 2 });
  });

  it('needs the fuel a step burns', () => {
    // Ore and no coal smelts nothing; 4 Coal is two bars' worth.
    expect(craftable(ix, new Map([['CopperOre', 5]])).now.map((n) => n.product)).not.toContain('Copper');
    expect(craftable(ix, new Map([['CopperOre', 5], ['Coal', 4]])).now).toContainEqual({ product: 'Copper', crafts: 2 });
  });

  it('takes the better of a product’s recipes', () => {
    // No ore, but scrap: copper can still be smelted, by the alternative.
    expect(craftable(ix, new Map([['CopperScrap', 3], ['Coal', 6]])).now).toContainEqual({ product: 'Copper', crafts: 3 });
  });

  it('finds what is one ingredient away, when that ingredient is within reach', () => {
    const karve = new Map([['FineWood', 30], ['DeerHide', 10], ['Resin', 20]]);
    // Everything for a Karve but its nails: close when some nails are held,
    expect(lacking(craftable(ix, new Map([...karve, ['BronzeNails', 40]])), 'Karve')).toEqual({ BronzeNails: 40 });
    // or when the inventory can make them now,
    expect(lacking(craftable(ix, new Map([...karve, ['Bronze', 1]])), 'Karve')).toEqual({ BronzeNails: 80 });
    // and not when nothing in it leads to them.
    expect(lacking(craftable(ix, karve), 'Karve')).toBeUndefined();
    // Copper for Bronze, and the ore and coal to smelt its tin.
    expect(lacking(craftable(ix, new Map([['Copper', 4], ['TinOre', 1], ['Coal', 2]])), 'Bronze')).toEqual({ Tin: 1 });
    expect(lacking(craftable(ix, new Map([['Copper', 4]])), 'Bronze')).toBeUndefined();
  });

  it('never calls a first day’s inventory close to a boss’s drop', () => {
    // Wood, stone, flint, leather, hides and resin: one Hard antler from an
    // Antler pickaxe, but only Eikthyr drops it; one ingredient from the
    // cuirass, but nothing held leads to Bronze.
    const dayOne = new Map([['Wood', 50], ['Stone', 20], ['Flint', 10], ['LeatherScraps', 10], ['DeerHide', 6], ['Resin', 10]]);
    expect(lacking(craftable(ix, dayOne), 'PickaxeAntler')).toBeUndefined();
    expect(lacking(craftable(ix, dayOne), 'ArmorBronzeChest')).toBeUndefined();
    // One feather of two is close: the reader is already collecting them.
    expect(lacking(craftable(ix, new Map([...dayOne, ['Feathers', 1]])), 'ArrowFire')).toEqual({ Feathers: 1 });
  });

  it('ranks a product made two ways by its closest recipe, and not at all once one makes it', () => {
    // ItemF takes 10 Resin, or 8 Resin, 100 Wood and 2 Feathers. Holding 8
    // Resin, 100 Wood and a feather, both are close: the first with every
    // quantity close, which ranks first, and the second one feather short.
    expect(lacking(craftable(ix, new Map([['Resin', 8], ['Wood', 100], ['Feathers', 1]])), 'ItemF')).toEqual({ Resin: 2 });
    // Holding 10 Resin it is made now, so it is not also close.
    const made = craftable(ix, new Map([['Resin', 10], ['Wood', 100], ['Feathers', 1]]));
    expect(made.now).toContainEqual({ product: 'ItemF', crafts: 1 });
    expect(lacking(made, 'ItemF')).toBeUndefined();
  });

  it('finds what is within a fifth of every quantity', () => {
    // The cauldron takes 10 Tin: 8 is close, 7 is not.
    expect(lacking(craftable(ix, new Map([['Tin', 8]])), 'piece_cauldron')).toEqual({ Tin: 2 });
    expect(lacking(craftable(ix, new Map([['Tin', 7]])), 'piece_cauldron')).toBeUndefined();
  });

  it('puts every quantity close before one ingredient short, then the closest first', () => {
    // The cauldron lacks 2 of its 10 Tin. The Karve lacks 20 of its 80 nails,
    // a smaller share of the whole recipe but a quarter of its nails; Bronze
    // lacks 1 of its 2 Copper, a third of its recipe.
    const c = craftable(ix, new Map([['Tin', 8], ['FineWood', 30], ['DeerHide', 10], ['Resin', 20], ['BronzeNails', 60], ['Copper', 1]]));
    expect(c.almost.map((a) => a.product)).toEqual(['piece_cauldron', 'Karve', 'Bronze']);
  });

  it('does not call far-off recipes close', () => {
    // Two Wood is nowhere near an Iron Sword, and a single-ingredient recipe
    // is never "one ingredient away" from nothing.
    const c = craftable(ix, new Map([['Wood', 2]]));
    expect(c.almost.map((a) => a.product)).not.toContain('SwordIron');
    expect(c.almost.map((a) => a.product)).not.toContain('Iron');
    expect(c.now).toEqual([{ product: 'Coal', crafts: 2 }]);
  });

  it('counts only first crafts, never upgrades', () => {
    // An upgrade needs the item itself, which an inventory of materials does not say.
    const c = craftable(ix, new Map([['Wood', 100], ['Iron', 100], ['LeatherScraps', 100]]));
    expect(c.now).toContainEqual({ product: 'SwordIron', crafts: 5 });
  });
});
