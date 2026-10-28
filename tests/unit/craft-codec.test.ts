import { describe, expect, it } from 'vitest';
import { decodeGraph, encodeGraph, GraphShapeError } from '@/lib/craft/codec';
import type { GraphItem, GraphRecipe, ItemKind, Obtain, RecipeGraph, RecipeMethod } from '@/lib/craft/types';

/**
 * The planner downloads the whole graph, so it travels as compact arrays
 * instead of objects. What matters is the round trip: a codec that drops a
 * yield, a fuel line or an alternative on the way to the browser makes every
 * shopping list built from it wrong, and nothing on the page would say so.
 *
 * Ids, names and numbers are the game's and the wiki's own.
 */
const GRAPH: RecipeGraph = {
  v: 1,
  version: '4f0c2a9e5b7d1c3e',
  builtAt: '2026-10-27T18:00:00.000Z',
  items: [
    {
      id: 'SwordIron',
      en: 'Iron Sword',
      es: 'Espada de hierro',
      slug: 'iron-sword',
      icon: 'e/e7/Iron_Sword.png?cb=20210213022755',
      kind: 'item',
      maxQuality: 4,
    },
    {
      id: 'Wood',
      en: 'Wood',
      es: 'Madera',
      slug: 'wood',
      icon: 'a/a8/Wood.png',
      kind: 'item',
      maxQuality: 1,
      obtain: [{ how: 'chop', from: ['Beech', 'Birch', 'Oak'] }],
    },
    {
      id: 'FineWood',
      en: 'Finewood',
      es: 'Madera fina',
      slug: 'finewood',
      kind: 'item',
      maxQuality: 1,
      // The Bronze axe is not in this graph: the tool travels by its id.
      obtain: [{ how: 'chop', from: ['Birch', 'Oak'], tool: 'AxeBronze' }],
    },
    { id: 'Iron', en: 'Iron', es: 'Hierro', slug: 'iron', kind: 'item', maxQuality: 1 },
    {
      id: 'IronScrap',
      en: 'Scrap iron',
      es: 'Chatarra de hierro',
      slug: 'scrap-iron',
      kind: 'item',
      maxQuality: 1,
      obtain: [{ how: 'mine', from: ['Muddy scrap pile'], tool: 'PickaxeAntler' }],
    },
    { id: 'PickaxeAntler', en: 'Antler Pickaxe', es: 'Pico de asta', slug: 'antler-pickaxe', kind: 'item', maxQuality: 3 },
    {
      id: 'LeatherScraps',
      en: 'Leather scraps',
      es: 'Recortes de cuero',
      // Translations name it three ways; the interface shows one.
      aliases: ['Retazos de cuero', 'Restos de cuero'],
      slug: 'leather-scraps',
      kind: 'item',
      maxQuality: 1,
      obtain: [{ how: 'drop', from: ['Boar', 'Draugr'] }],
    },
    { id: 'Copper', en: 'Copper', es: 'Cobre', slug: 'copper', kind: 'item', maxQuality: 1 },
    { id: 'CopperOre', en: 'Copper ore', slug: 'copper-ore', kind: 'item', maxQuality: 1, obtain: [{ how: 'mine', from: ['Copper deposit'] }] },
    { id: 'CopperScrap', en: 'Copper scrap', slug: 'copper-scrap', kind: 'item', maxQuality: 1, obtain: [] },
    { id: 'Tin', en: 'Tin', es: 'Estaño', slug: 'tin', kind: 'item', maxQuality: 1 },
    { id: 'TinOre', en: 'Tin ore', slug: 'tin-ore', kind: 'item', maxQuality: 1 },
    // An icon file named differently from the item travels as it is.
    { id: 'Bronze', en: 'Bronze', es: 'Bronce', slug: 'bronze', icon: 'c/c2/Bronze_bar.png?cb=20210215131403', kind: 'item', maxQuality: 1 },
    { id: 'BronzeNails', en: 'Bronze Nails', es: 'Clavos de bronce', slug: 'bronze-nails', kind: 'item', maxQuality: 1 },
    // An icon kept as a full URL still has a file named after the item.
    { id: 'Coal', en: 'Coal', es: 'Carbón', slug: 'coal', icon: 'https://static.wikia.nocookie.net/valheim/images/4/4b/Coal.png', kind: 'item', maxQuality: 1 },
    { id: 'DeerHide', en: 'Deer hide', es: 'Cuero de ciervo', slug: 'deer-hide', kind: 'item', maxQuality: 1 },
    { id: 'YmirRemains', en: 'Ymir flesh', slug: 'ymir-flesh', kind: 'item', maxQuality: 1, obtain: [{ how: 'buy', from: 'Haldor', coins: 120 }] },
    {
      id: 'ArmorBronzeChest',
      en: 'Bronze plate cuirass',
      // A piece of a set, described in a tab of the set's page.
      slug: 'bronze-armor',
      anchor: 'chest',
      kind: 'item',
      maxQuality: 2,
    },
    {
      id: 'TrophyDeer',
      en: 'Deer trophy',
      aliases: ['Trofeo de ciervo'],
      slug: 'trophies',
      anchor: 'meadows',
      kind: 'virtual',
      maxQuality: 1,
      obtain: [{ how: 'drop', from: ['Deer'] }],
    },
    // No internal ID: the id is the page, and the place on it.
    { id: 'page:wood-structures#wood-floor-1x1', en: 'Wood floor 1x1', slug: 'wood-structures', anchor: 'wood-floor-1x1', kind: 'piece', maxQuality: 1 },
    { id: 'page:item-stand', en: 'Item Stand', es: 'Soporte para objetos', slug: 'item-stand', kind: 'piece', maxQuality: 1 },
    { id: 'Stone', en: 'Stone', es: 'Piedra', kind: 'item', maxQuality: 1 },
    { id: 'Hammer', en: 'Hammer', es: 'Martillo', slug: 'hammer', kind: 'item', maxQuality: 1 },
    {
      id: 'QueensJam',
      en: "Queen's jam",
      es: 'Mermelada de la reina',
      slug: 'queen-s-jam',
      // The wiki escapes the apostrophe in the file name.
      icon: '5/5d/Queen%27s_jam.png?cb=20210208235510',
      kind: 'item',
      maxQuality: 1,
    },
    { id: 'Raspberry', en: 'Raspberries', slug: 'raspberries', kind: 'item', maxQuality: 1 },
    {
      id: 'forge',
      en: 'Forge',
      es: 'Forja',
      slug: 'forge',
      kind: 'station',
      maxQuality: 1,
      station: { maxLevel: 7, extensions: ['forge_ext5', 'forge_ext6'] },
    },
    { id: 'forge_ext5', en: 'Forge cooler', slug: 'forge-cooler', kind: 'extension', maxQuality: 1, extends: 'forge' },
    { id: 'forge_ext6', en: 'Forge toolrack', slug: 'forge-toolrack', kind: 'extension', maxQuality: 1, extends: 'forge' },
    { id: 'piece_workbench', en: 'Workbench', es: 'Banco de trabajo', slug: 'workbench', kind: 'station', maxQuality: 1, station: { maxLevel: 5, extensions: [] } },
    { id: 'smelter', en: 'Smelter', es: 'Fundición', slug: 'smelter', kind: 'station', maxQuality: 1, station: { maxLevel: 1, extensions: [] } },
    { id: 'piece_cauldron', en: 'Cauldron', es: 'Caldero', slug: 'cauldron', kind: 'station', maxQuality: 1, station: { maxLevel: 6, extensions: [] } },
    { id: 'charcoal_kiln', en: 'Charcoal Kiln', slug: 'charcoal-kiln', kind: 'station', maxQuality: 1, station: { maxLevel: 1, extensions: [] } },
  ],
  recipes: [
    { product: 'SwordIron', quality: 1, station: 'forge', stationLevel: 2, yield: 1, yieldKnown: true, inputs: [['Wood', 2], ['Iron', 20], ['LeatherScraps', 3]], method: 'craft', from: 'Iron Sword' },
    { product: 'SwordIron', quality: 2, station: 'forge', stationLevel: 3, yield: 1, yieldKnown: true, inputs: [['Wood', 1], ['Iron', 10], ['LeatherScraps', 2]], method: 'craft', from: 'Iron Sword' },
    { product: 'SwordIron', quality: 3, station: 'forge', stationLevel: 4, yield: 1, yieldKnown: true, inputs: [['Wood', 2], ['Iron', 20], ['LeatherScraps', 4]], method: 'craft', from: 'Iron Sword' },
    { product: 'SwordIron', quality: 4, station: 'forge', stationLevel: 5, yield: 1, yieldKnown: true, inputs: [['Wood', 3], ['Iron', 30], ['LeatherScraps', 6]], method: 'craft', from: 'Iron Sword' },
    { product: 'Iron', quality: 1, station: 'smelter', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['IronScrap', 1]], method: 'smelt', fuel: ['Coal', 2], from: 'Iron' },
    // Copper from ore is the one planned with; from scrap is the alternative.
    { product: 'Copper', quality: 1, station: 'smelter', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['CopperOre', 1]], method: 'smelt', alt: 0, fuel: ['Coal', 2], from: 'Copper' },
    { product: 'Copper', quality: 1, station: 'smelter', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['CopperScrap', 1]], method: 'smelt', alt: 1, fuel: ['Coal', 2], from: 'Copper' },
    { product: 'Tin', quality: 1, station: 'smelter', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['TinOre', 1]], method: 'smelt', fuel: ['Coal', 2], from: 'Tin' },
    { product: 'Bronze', quality: 1, station: 'forge', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['Copper', 2], ['Tin', 1]], method: 'craft', from: 'Bronze' },
    { product: 'BronzeNails', quality: 1, station: 'forge', stationLevel: 1, yield: 20, yieldKnown: true, inputs: [['Bronze', 1]], method: 'craft', from: 'Bronze Nails' },
    { product: 'ArmorBronzeChest', quality: 1, station: 'forge', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['Bronze', 5], ['DeerHide', 2]], method: 'craft', from: 'Bronze Armor#Chest' },
    { product: 'ArmorBronzeChest', quality: 2, station: 'forge', stationLevel: 2, yield: 1, yieldKnown: true, inputs: [['Bronze', 3]], method: 'craft', from: 'Bronze Armor#Chest' },
    { product: 'page:wood-structures#wood-floor-1x1', quality: 1, station: 'piece_workbench', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['Wood', 1]], method: 'build', from: 'Wood Structures' },
    { product: 'page:item-stand', quality: 1, station: 'piece_workbench', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['FineWood', 10], ['BronzeNails', 1]], method: 'build', from: 'Item Stand' },
    // Made by hand, at no station, with a yield nothing settles.
    { product: 'Hammer', quality: 1, station: null, stationLevel: 1, yield: 1, yieldKnown: false, inputs: [['Wood', 3], ['Stone', 2]], method: 'craft', from: 'Hammer' },
    { product: 'QueensJam', quality: 1, station: 'piece_cauldron', stationLevel: 1, yield: 4, yieldKnown: true, inputs: [['Raspberry', 8]], method: 'cook', from: "Queen's Jam" },
    { product: 'forge', quality: 1, station: 'piece_workbench', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['Stone', 4], ['Coal', 4], ['Wood', 10], ['Copper', 6]], method: 'build', from: 'Forge' },
    { product: 'forge_ext5', quality: 1, station: 'forge', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['FineWood', 25], ['Copper', 10]], method: 'build', from: 'Forge Cooler' },
    // Coal's only recipe, and an alternative: coal is gathered, the kiln a choice.
    { product: 'Coal', quality: 1, station: 'charcoal_kiln', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['Wood', 1]], method: 'kiln', alt: 1, from: 'Charcoal Kiln' },
  ],
};

/** What the browser does with the payload: it arrives as JSON text. */
const overTheWire = (graph: RecipeGraph): unknown => JSON.parse(JSON.stringify(encodeGraph(graph)));

describe('encodeGraph and decodeGraph', () => {
  it('give back exactly the graph they were given', () => {
    expect(decodeGraph(encodeGraph(GRAPH))).toStrictEqual(GRAPH);
  });

  it('survive the trip through JSON text', () => {
    expect(decodeGraph(overTheWire(GRAPH))).toStrictEqual(GRAPH);
  });

  it('keep what is absent absent, and what is empty empty', () => {
    const decoded = decodeGraph(overTheWire(GRAPH));
    const byId = new Map(decoded.items.map((item) => [item.id, item]));
    // No key at all where the graph had none, so a strict comparison holds
    // and `'es' in item` means what it says.
    expect(Object.keys(byId.get('Iron')!).sort()).toEqual(['en', 'es', 'id', 'kind', 'maxQuality', 'slug']);
    expect(byId.get('CopperScrap')!.obtain).toEqual([]);
    expect(byId.get('smelter')!.station).toEqual({ maxLevel: 1, extensions: [] });
    // An alternative keeps its number, 0 included, and so does a lone one
    // (coal from the kiln, which the maths never plans with); a recipe that
    // is simply the only one has none.
    const copper = decoded.recipes.filter((r) => r.product === 'Copper');
    expect(copper.map((r) => r.alt)).toEqual([0, 1]);
    expect(decoded.recipes.find((r) => r.product === 'Coal')!.alt).toBe(1);
    expect('alt' in decoded.recipes.find((r) => r.product === 'Tin')!).toBe(false);
  });

  it('rebuild a left-out field only where it comes back exactly', () => {
    // Each of these is one character away from what the payload can rebuild
    // (the slug, the page id, the icon file, the provenance), so each must
    // travel as it is.
    const near: RecipeGraph = {
      ...GRAPH,
      items: [
        ...GRAPH.items,
        { id: 'page:iron-sword', en: 'Iron Sword', slug: 'iron-sword-2', icon: 'e/e7/Iron_sword.png', kind: 'item', maxQuality: 1 },
        { id: 'page:wood', en: 'Wood', slug: 'wood', anchor: 'raw', kind: 'virtual', maxQuality: 1 },
        { id: 'page:', en: '', slug: '', kind: 'virtual', maxQuality: 1 },
      ],
      recipes: [
        ...GRAPH.recipes,
        { product: 'page:iron-sword', quality: 1, station: null, stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['Wood', 1]], method: 'craft', from: 'Iron sword' },
      ],
    };
    expect(decodeGraph(JSON.parse(JSON.stringify(encodeGraph(near))))).toStrictEqual(near);
  });

  it('carry every kind, method and way of coming by a material', () => {
    const kinds: ItemKind[] = ['item', 'piece', 'station', 'extension', 'virtual'];
    const methods: RecipeMethod[] = ['craft', 'build', 'smelt', 'cook', 'bake', 'brew', 'ferment', 'refine', 'mill', 'spin', 'kiln', 'prepare'];
    const ways: Obtain[] = [
      { how: 'drop', from: ['Deer'] },
      { how: 'mine', from: ['Tin deposit'], tool: 'Item0' },
      { how: 'chop', from: ['Birch'] },
      { how: 'gather', from: ['Meadows'] },
      { how: 'fish', from: ['Ocean'] },
      { how: 'loot', from: ['Burial chamber'] },
      { how: 'farm', from: ['Carrot seeds'] },
      { how: 'buy', from: 'Haldor', coins: 50 },
    ];
    const items: GraphItem[] = kinds.map((kind, i) => ({ id: `Item${i}`, en: `Item ${i}`, kind, maxQuality: 1, obtain: ways }));
    const recipes: GraphRecipe[] = methods.map((method) => ({
      product: 'Item1',
      quality: 1,
      station: 'Item2',
      stationLevel: 1,
      yield: 1,
      yieldKnown: true,
      inputs: [['Item0', 1]],
      method,
      from: method,
    }));
    const graph: RecipeGraph = { v: 1, version: 'all', builtAt: GRAPH.builtAt, items, recipes };
    expect(decodeGraph(overTheWire(graph))).toStrictEqual(graph);
  });

  it('are smaller than the graph as plain JSON', () => {
    expect(JSON.stringify(encodeGraph(GRAPH)).length).toBeLessThan(JSON.stringify(GRAPH).length);
  });

  it('write an id at most once, and point at items by position', () => {
    const text = JSON.stringify(encodeGraph(GRAPH));
    // `Wood` is an id and a name; only ids that are no name can be counted.
    const names = new Set(GRAPH.items.flatMap((item) => [item.en, item.es, ...(item.aliases ?? [])]));
    for (const item of GRAPH.items.filter((item) => !names.has(item.id))) {
      expect(text.split(JSON.stringify(item.id)).length - 1).toBeLessThanOrEqual(1);
    }
    // The ids the page and its place spell out are not written at all.
    expect(text).not.toContain('page:');
  });

  it('write a provenance shared by several steps once', () => {
    const text = JSON.stringify(encodeGraph(GRAPH));
    expect(text.split('"Bronze Armor#Chest"').length - 1).toBe(1);
  });

  it('encode the same graph to the same payload', () => {
    expect(JSON.stringify(encodeGraph(GRAPH))).toBe(JSON.stringify(encodeGraph(structuredClone(GRAPH))));
  });
});

describe('decodeGraph', () => {
  it('refuses another shape version', () => {
    expect(() => decodeGraph({ v: 2 })).toThrow(GraphShapeError);
  });

  /** Positions in the layout (`WireItem`, `WireGroup`, `WireStep`). */
  const KIND = 2;
  const PRODUCT = 0;
  const METHOD = 2;
  const FIRST_STEP = 4;
  const INPUTS = 2;

  type Wire = { i: unknown[][]; r: unknown[][] };
  /** A good payload with one thing broken, as a server bug or a truncated cache would deliver it. */
  const broken = (edit: (wire: Wire) => void): unknown => {
    const wire = overTheWire(GRAPH) as Wire;
    edit(wire);
    return wire;
  };
  const forge = (wire: Wire): unknown[] => wire.i[GRAPH.items.findIndex((item) => item.id === 'forge')]!;
  const leatherScraps = (wire: Wire): unknown[] => wire.i[GRAPH.items.findIndex((item) => item.id === 'LeatherScraps')]!;
  const firstInputs = (wire: Wire): unknown[] => (wire.r[0]![FIRST_STEP] as unknown[])[INPUTS] as unknown[];

  it.each<[string, unknown]>([
    ['nothing', undefined],
    ['null', null],
    ['text', 'graph'],
    ['a list', []],
    ['a version and nothing else', { v: 1 }],
    ['items that are not a list', broken((w) => void (w.i = 'x' as never))],
    ['an item that is not a tuple', broken((w) => void w.i.push('SwordIron' as never))],
    ['an item with more fields than this layout has', broken((w) => void w.i[0]!.push(0, 0, 0, 0, 0, 0, 0, 0, 0))],
    ['an unknown kind of item', broken((w) => void (w.i[0]![KIND] = 99))],
    ['an extension pointing past the items', broken((w) => void (forge(w)[9] = [7, 9999]))],
    ['a creature drop that needs a tool', broken((w) => void (leatherScraps(w)[11] = [[0, ['Boar'], 'PickaxeAntler']]))],
    ['a recipe pointing past the items', broken((w) => void (w.r[0]![PRODUCT] = 9999))],
    ['a recipe pointing at a fraction of an item', broken((w) => void (w.r[0]![PRODUCT] = 1.5))],
    ['an unknown method', broken((w) => void (w.r[0]![METHOD] = 99))],
    ['a product with no steps', broken((w) => void (w.r[0]!.length = FIRST_STEP))],
    ['a quantity that is not a number', broken((w) => void (firstInputs(w)[1] = '20'))],
    ['inputs that are not pairs', broken((w) => void firstInputs(w).push(3))],
  ])('refuses %s with a GraphShapeError, never a TypeError', (_label, wire) => {
    expect(() => decodeGraph(wire)).toThrow(GraphShapeError);
  });

  it('refuses two items with the same id', () => {
    // What a merge bug upstream would produce: a valid payload with its first
    // item appended again.
    const wire = overTheWire(GRAPH) as Wire;
    wire.i.push(structuredClone(wire.i[0]!));
    expect(() => decodeGraph(wire)).toThrow(GraphShapeError);
  });
});

describe('encodeGraph', () => {
  it('refuses a recipe that names an item the graph does not have', () => {
    const graph = structuredClone(GRAPH);
    graph.recipes[0]!.inputs.push(['Flametal', 1]);
    expect(() => encodeGraph(graph)).toThrow(GraphShapeError);
  });

  it('refuses two items with the same id', () => {
    const graph = structuredClone(GRAPH);
    graph.items.push({ ...graph.items[0]! });
    expect(() => encodeGraph(graph)).toThrow(GraphShapeError);
  });

  it('refuses an icon it could not give back', () => {
    // A file called `*` is how the layout writes "named after the item".
    const graph = structuredClone(GRAPH);
    graph.items[0]!.icon = 'e/e7/*';
    expect(() => encodeGraph(graph)).toThrow(GraphShapeError);
  });

  const recipeOf = (graph: RecipeGraph, product: string): GraphRecipe => graph.recipes.find((r) => r.product === product)!;
  const itemOf = (graph: RecipeGraph, id: string): GraphItem => graph.items.find((item) => item.id === id)!;

  // The route serves the payload with a day's cache and a week's stale
  // grace, and the service worker keeps it: one value the decoder refuses
  // would lose the whole graph to every reader. Each of these is what an
  // assembly bug or a trip through jsonb (where NaN becomes null) leaves.
  it.each<[string, (graph: RecipeGraph) => void]>([
    ['another shape version', (g) => void Object.assign(g, { v: 2 })],
    ['a station level a "nil" cell parsed to NaN', (g) => void (recipeOf(g, 'SwordIron').stationLevel = Number('nil'))],
    ['a station level stored as null', (g) => void Object.assign(recipeOf(g, 'SwordIron'), { stationLevel: null })],
    ['a quality in part', (g) => void (recipeOf(g, 'SwordIron').quality = 1.5)],
    ['a negative quantity', (g) => void (recipeOf(g, 'SwordIron').inputs[0]![1] = -1)],
    ['an endless yield', (g) => void (recipeOf(g, 'BronzeNails').yield = Infinity)],
    ['a fuel quantity that is no number', (g) => void (recipeOf(g, 'Iron').fuel![1] = NaN)],
    ['an alternative numbered -1, which the layout writes for none', (g) => void (recipeOf(g, 'Tin').alt = -1)],
    ['a yield neither known nor unknown', (g) => void Object.assign(recipeOf(g, 'Hammer'), { yieldKnown: undefined })],
    ['a provenance that is not text', (g) => void Object.assign(recipeOf(g, 'Tin'), { from: null })],
    ['a highest quality that is no number', (g) => void (itemOf(g, 'SwordIron').maxQuality = NaN)],
    ['a station’s highest level that is no number', (g) => void (itemOf(g, 'forge').station!.maxLevel = NaN)],
    ['a price in part coins', (g) => void (itemOf(g, 'YmirRemains').obtain = [{ how: 'buy', from: 'Haldor', coins: 2.5 }])],
    ['a name that is not text', (g) => void Object.assign(itemOf(g, 'Iron'), { en: null })],
    ['a Spanish name that is not text', (g) => void Object.assign(itemOf(g, 'Iron'), { es: 7 })],
    ['an alias that is not text', (g) => void (itemOf(g, 'LeatherScraps').aliases = ['Retazos de cuero', null as never])],
    ['a source that is not text', (g) => void (itemOf(g, 'Wood').obtain = [{ how: 'chop', from: [null as never] }])],
    // Names every object has: a plain lookup in the code tables finds a function.
    ['a kind called toString', (g) => void Object.assign(itemOf(g, 'Iron'), { kind: 'toString' })],
    ['a method called constructor', (g) => void Object.assign(recipeOf(g, 'Tin'), { method: 'constructor' })],
    ['a way of coming by a material called valueOf', (g) => void (itemOf(g, 'Wood').obtain = [{ how: 'valueOf' as never, from: ['Beech'] }])],
  ])('refuses %s, so it never serves a payload no reader can decode', (_label, edit) => {
    const graph = structuredClone(GRAPH);
    edit(graph);
    expect(() => encodeGraph(graph)).toThrow(GraphShapeError);
  });
});
