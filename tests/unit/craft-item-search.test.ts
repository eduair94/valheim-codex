import { describe, expect, it } from 'vitest';
import { prepareItemSearch, searchItems } from '@/lib/craft/item-search';
import type { GraphItem, GraphRecipe, ItemId, RecipeGraph } from '@/lib/craft/types';

/**
 * Finding an item to add to the planner, or a material to count in "Lo que
 * tengo", by the name the reader knows it by: Spanish first, English, or a
 * name the translations use. The graph is a slice of the fixture
 * `tests/unit/craft-math.test.ts` checks the maths on, with the names the
 * wiki and the translations give these items.
 */

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

/** The items' names, as the assembly attaches them. */
const NAMES: Record<ItemId, Partial<GraphItem>> = {
  SwordIron: { en: 'Iron Sword', es: 'Espada de hierro', icon: 'e/e7/Iron_Sword.png' },
  SwordBronze: { en: 'Bronze Sword', es: 'Espada de bronce' },
  Iron: { en: 'Iron', es: 'Hierro' },
  Wood: { en: 'Wood', es: 'Madera' },
  LeatherScraps: { en: 'Leather scraps', es: 'Recortes de cuero', aliases: ['Retazos de cuero', 'Restos de cuero'] },
  Bronze: { en: 'Bronze', es: 'Bronce' },
  Copper: { en: 'Copper', es: 'Cobre' },
  CopperOre: { en: 'Copper ore', es: 'Mineral de cobre' },
  CopperScrap: { en: 'Copper scrap' },
  Tin: { en: 'Tin', es: 'Estaño' },
  BronzeNails: { en: 'Bronze nails', es: 'Clavos de bronce' },
  Karve: { en: 'Karve', es: 'Karve' },
  FineWood: { en: 'Fine wood', es: 'Madera fina' },
  Coal: { en: 'Coal', es: 'Carbón' },
  forge: { en: 'Forge', es: 'Forja' },
  smelter: { en: 'Smelter', es: 'Fundición' },
  charcoal_kiln: { en: 'Charcoal kiln', es: 'Horno de carbón' },
  piece_workbench: { en: 'Workbench', es: 'Banco de trabajo' },
};

function graphOf(recipes: GraphRecipe[]): RecipeGraph {
  const items = new Map<ItemId, GraphItem>();
  const add = (id: ItemId, kind: GraphItem['kind']) => {
    if (!items.has(id)) items.set(id, { id, en: id, kind, maxQuality: 1, ...NAMES[id] });
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
  step('SwordBronze', 1, 'forge', 1, [['Wood', 2], ['Bronze', 8], ['LeatherScraps', 2]]),
  step('Copper', 1, 'smelter', 1, [['CopperOre', 1]], { method: 'smelt', fuel: ['Coal', 2], alt: 0 }),
  step('Copper', 1, 'smelter', 1, [['CopperScrap', 1]], { method: 'smelt', fuel: ['Coal', 2], alt: 1 }),
  step('Bronze', 1, 'forge', 1, [['Copper', 2], ['Tin', 1]]),
  step('BronzeNails', 1, 'forge', 1, [['Bronze', 1]], { yield: 20 }),
  step('Karve', 1, 'piece_workbench', 1, [['FineWood', 30], ['BronzeNails', 80]], { method: 'build' }),
  // Coal's only recipe is the charcoal kiln, an alternative no breakdown plans with.
  step('Coal', 1, 'charcoal_kiln', 1, [['Wood', 1]], { method: 'kiln', alt: 1 }),
  // A target whose first level the wiki leaves out can still be upgraded.
  step('ShieldGapped', 2, 'forge', 2, [['Wood', 2]]),
]);

const ids = (items: GraphItem[]) => items.map((item) => item.id);

describe('searchItems', () => {
  const products = prepareItemSearch(GRAPH, 'products');
  const all = prepareItemSearch(GRAPH, 'all');

  it('finds items by their Spanish name', () => {
    expect(ids(searchItems(products, 'espada de hierro'))[0]).toBe('SwordIron');
    expect(ids(searchItems(products, 'espada'))).toEqual(expect.arrayContaining(['SwordIron', 'SwordBronze']));
    expect(ids(searchItems(products, 'clavos'))[0]).toBe('BronzeNails');
  });

  it('finds them by their English name and by the names translations use', () => {
    expect(ids(searchItems(products, 'iron sword'))[0]).toBe('SwordIron');
    expect(ids(searchItems(all, 'retazos de cuero'))[0]).toBe('LeatherScraps');
    // Typed the way a phone keyboard often does: no accent.
    expect(ids(searchItems(all, 'estano'))[0]).toBe('Tin');
  });

  it('hands back the graph’s own items', () => {
    const [sword] = searchItems(products, 'espada de hierro');
    expect(sword).toBe(GRAPH.items.find((item) => item.id === 'SwordIron'));
    expect(products.byId.get('SwordIron')).toBe(sword);
  });

  it('offers what has a recipe, when adding to the list', () => {
    // Wood is gathered: nothing makes it.
    expect(ids(searchItems(products, 'madera'))).toEqual([]);
    expect(products.byId.has('Wood')).toBe(false);
    // Coal has only the kiln, which a list plans a Coal target with (`targetStep`).
    expect(ids(searchItems(products, 'carbon'))).toEqual(['Coal']);
    // Copper is made from ore, though scrap is a second way.
    expect(ids(searchItems(products, 'cobre'))).toContain('Copper');
    expect(products.byId.has('Karve')).toBe(true);
    expect(products.byId.has('ShieldGapped')).toBe(true);
  });

  it('offers every item, when counting what the reader holds', () => {
    expect(ids(searchItems(all, 'madera'))).toEqual(expect.arrayContaining(['Wood', 'FineWood']));
    expect(ids(searchItems(all, 'carbon'))).toContain('Coal');
    expect(all.byId.size).toBe(GRAPH.items.length);
  });

  it('stops at eight unless asked for more', () => {
    // Every item's English name here has a vowel; 'e' starts no word, but the
    // English titles containing it still match.
    const many = searchItems(all, 'o');
    expect(many.length).toBeLessThanOrEqual(8);
    expect(searchItems(all, 'o', 3).length).toBeLessThanOrEqual(3);
    expect(searchItems(all, 'o', 50).length).toBeGreaterThan(8);
  });

  it('answers nothing to nothing', () => {
    expect(searchItems(all, '')).toEqual([]);
    expect(searchItems(all, '   ')).toEqual([]);
  });
});
