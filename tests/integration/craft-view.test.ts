import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { decodeGraph } from '@/lib/craft/codec';
import { expandRaw, indexGraph, totalCost } from '@/lib/craft/math';
import type { GraphItem, GraphRecipe, GraphReport, ItemId, RecipeGraph } from '@/lib/craft/types';
import { rawQuery, type Db, type DbHandle } from '@/lib/db/create-db';
import { getRecipeBasis, writeRecipeGraph } from '@/lib/db/recipe-repo';
import { saveTranslation, upsertArticle } from '@/lib/db/wiki-repo';
import type { ArticleImage, ArticleInfobox } from '@/lib/wiki/article-types';
import { slugify } from '@/lib/wiki/slug';
import { createTestDb } from '../helpers/db';

/**
 * The recipe graph as pages read it: the whole graph with the names readers
 * see today (`getRecipeGraphData`), and one item's slice of it for its
 * article (`getCraftView`).
 *
 * The ingest that assembles a graph from the wiki is built elsewhere, so the
 * graph here is written by hand, as `writeRecipeGraph` stores one, with the
 * game's internal IDs and the wiki's own recipes: the Iron Sword's four
 * steps at Forge levels 2 to 5, a Karve's 80 nails at 20 a craft, the
 * Cauldron and its five extensions, a mead and its base described on one
 * page, three things made by hand from Wood. It was built before most of its
 * articles were translated: its items
 * carry almost no Spanish names, and the ones it has are the assembly's.
 * The names a reader sees come from the articles and translations seeded
 * beside it.
 *
 * `unstable_cache` is replaced by a recorder that runs the function, as in
 * wiki-data.test.ts, so the tests see what the loader asks the cache for and
 * that nothing cached runs inside it.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  failDb: false,
  cached: [] as { keyParts: string[]; options: { tags?: string[]; revalidate?: number | false } }[],
  calls: [] as { keyParts: string[]; args: unknown[] }[],
  stored: new Map<string, unknown>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keyParts: string[],
    options: { tags?: string[]; revalidate?: number | false },
  ) => {
    state.cached.push({ keyParts, options });
    return async (...args: unknown[]) => {
      state.calls.push({ keyParts, args });
      // What the data cache does to every value: a JSON round trip. A
      // rejection propagates before anything is stored, as in Next.
      const value = JSON.parse(JSON.stringify(await fn(...args))) as unknown;
      state.stored.set(keyParts.join(','), value);
      return value;
    };
  },
}));
vi.mock('@/lib/db/client', () => ({
  getDb: async () => {
    if (state.failDb) throw new Error('database unavailable');
    return state.db;
  },
}));

const data = await import('@/lib/craft/data');

/** The graph's cache, as the module set it up when it loaded. */
const registered = state.cached.filter((c) => c.keyParts.includes('wiki-recipe-graph'));

/* -------------------------------------------------------------------------- */
/* The graph                                                                   */
/* -------------------------------------------------------------------------- */

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

/** An item with an article of its own, slugged as the site slugs its title. */
function article(id: ItemId, en: string, more: Partial<GraphItem> = {}): GraphItem {
  return { id, en, slug: slugify(en), kind: 'item', maxQuality: 1, ...more };
}

const CAULDRON_EXTENSIONS = [
  'cauldron_ext1_spice',
  'cauldron_ext3_butchertable',
  'cauldron_ext4_pots',
  'cauldron_ext5_mortarandpestle',
  'cauldron_ext6_rollingpins',
];

const ITEMS: GraphItem[] = [
  article('SwordIron', 'Iron Sword', { maxQuality: 4 }),
  article('Wood', 'Wood', { obtain: [{ how: 'chop', from: ['Beech', 'Birch', 'Oak'] }] }),
  article('Iron', 'Iron'),
  // The Antler pickaxe is not in this graph: a tool travels by its id.
  article('IronScrap', 'Scrap Iron', { obtain: [{ how: 'mine', from: ['Muddy scrap pile'], tool: 'PickaxeAntler' }] }),
  // Named when the graph was built by the translation of the day, since retitled.
  article('LeatherScraps', 'Leather Scraps', {
    es: 'Restos de cuero',
    aliases: ['Retazos de cuero'],
    obtain: [{ how: 'drop', from: ['Boar'] }],
  }),
  article('Coal', 'Coal'),
  article('Copper', 'Copper'),
  article('CopperOre', 'Copper Ore', { obtain: [{ how: 'mine', from: ['Copper deposit'] }] }),
  article('CopperScrap', 'Copper Scrap'),
  article('Tin', 'Tin'),
  article('TinOre', 'Tin Ore', { obtain: [{ how: 'mine', from: ['Tin deposit'] }] }),
  article('Bronze', 'Bronze'),
  article('BronzeNails', 'Bronze Nails'),
  article('KnifeButcher', 'Butcher Knife'),
  article('FineWood', 'Finewood'),
  article('DeerHide', 'Deer Hide'),
  article('Resin', 'Resin'),
  article('Karve', 'Karve', { kind: 'piece' }),
  article('Honey', 'Honey'),
  article('Thistle', 'Thistle'),
  article('NeckTail', 'Neck Tail'),
  article('MeadPoisonResist', 'Poison Resistance Mead'),
  // Described inside the mead's page, with the name the overrides give it.
  {
    id: 'MeadBasePoisonResist',
    en: 'Mead base: Poison resistance',
    es: 'Base de hidromiel: resistencia al veneno',
    slug: 'poison-resistance-mead',
    anchor: 'mead-base',
    kind: 'item',
    maxQuality: 1,
  },
  article('forge', 'Forge', { kind: 'station', station: { maxLevel: 7, extensions: ['forge_ext5'] } }),
  article('forge_ext5', 'Forge Cooler', { kind: 'extension', extends: 'forge' }),
  article('smelter', 'Smelter', { kind: 'station' }),
  article('piece_workbench', 'Workbench', { kind: 'station', station: { maxLevel: 5, extensions: [] } }),
  article('piece_cauldron', 'Cauldron', { kind: 'station', station: { maxLevel: 6, extensions: CAULDRON_EXTENSIONS } }),
  article('piece_MeadCauldron', 'Mead Ketill', { kind: 'station' }),
  article('fermenter', 'Fermenter', { kind: 'station' }),
  article('charcoal_kiln', 'Charcoal Kiln', { kind: 'station' }),
  article('cauldron_ext1_spice', 'Spice Rack', { kind: 'extension', extends: 'piece_cauldron' }),
  article('cauldron_ext3_butchertable', "Butcher's Table", { kind: 'extension', extends: 'piece_cauldron' }),
  article('cauldron_ext4_pots', 'Pots and Pans', { kind: 'extension', extends: 'piece_cauldron' }),
  article('cauldron_ext5_mortarandpestle', 'Mortar and Pestle', { kind: 'extension', extends: 'piece_cauldron' }),
  article('cauldron_ext6_rollingpins', 'Rolling Pins and Cutting Boards', { kind: 'extension', extends: 'piece_cauldron' }),
  article('Dandelion', 'Dandelion'),
  article('Carrot', 'Carrot'),
  article('Mushroom', 'Mushroom'),
  article('Turnip', 'Turnip'),
  article('ElderBark', 'Ancient Bark'),
  article('RoundLog', 'Corewood'),
  article('Silver', 'Silver'),
  article('BlackMetal', 'Black Metal'),
  article('BlackMarble', 'Black Marble'),
  article('Blackwood', 'Ashwood'),
  article('FlametalNew', 'Flametal'),
  article('Torch', 'Torch'),
  article('wood_stack', 'Wood Stack', { kind: 'piece' }),
  // How raw materials are had, as the assembly writes it: the creatures,
  // places and traders by the titles of the wiki's pages, one of them in
  // another letter case than its article's.
  article('BoneFragments', 'Bone Fragments', {
    obtain: [
      { how: 'drop', from: ['Skeleton', 'Rancid remains'] },
      // The Antler pickaxe is not in this graph either.
      { how: 'mine', from: ['Stone Grave'], tool: 'PickaxeAntler' },
    ],
  }),
  article('SilverOre', 'Silver Ore', { obtain: [{ how: 'mine', from: ['Silver vein'], tool: 'PickaxeIron' }] }),
  article('PickaxeIron', 'Iron Pickaxe'),
  article('Thunderstone', 'Thunder Stone', { obtain: [{ how: 'buy', from: 'Haldor', coins: 50 }] }),
  article('ArmorLeatherChest', 'Leather Tunic', { maxQuality: 2 }),
  article('BoltBone', 'Bone Bolt'),
  // An armor set's pieces, each described by a tab of the set's page, which
  // has no item of its own: the page's stored infobox, and so its picture, is
  // its first tab's, the helmet's.
  {
    id: 'HelmetLeather',
    en: 'Leather helmet',
    es: 'Casco de cuero',
    slug: 'leather-armor',
    anchor: 'head',
    kind: 'item',
    maxQuality: 2,
  },
  { id: 'CapeDeerHide', en: 'Deer hide cape', es: 'Capa de piel de ciervo', slug: 'leather-armor', anchor: 'cape', kind: 'item', maxQuality: 1 },
  // The first piece of a set whose picture is named otherwise ("Troll_Leather_Helmet.png").
  { id: 'HelmetTrollLeather', en: 'Troll leather hood', slug: 'troll-set', anchor: 'helmet', kind: 'item', maxQuality: 1 },
  article('TrollHide', 'Troll Hide'),
  // A food's cooked form, described by a tab of the raw food's page.
  article('DeerMeat', 'Deer Meat'),
  { id: 'CookedDeerMeat', en: 'Cooked deer meat', slug: 'deer-meat', anchor: 'cooked', kind: 'item', maxQuality: 1 },
  // The same, on a page whose first tab is the cooked form's.
  article('LoxMeat', 'Lox Meat'),
  { id: 'CookedLoxMeat', en: 'Cooked lox meat', slug: 'lox-meat', anchor: 'cooked', kind: 'item', maxQuality: 1 },
  // Described in a section of a page that shows no tabs: a station's.
  { id: 'piece_smoker', en: 'Smoker', slug: 'cauldron', anchor: 'smoker', kind: 'piece', maxQuality: 1 },
  // Described in a section of a page, and with an article of its own by the same name.
  { id: 'Stonerock', en: 'Mysterious Rock', slug: 'early-axes', anchor: 'mysterious-rock', kind: 'item', maxQuality: 1 },
  // A row of a list page, pictured by another article, whose picture is named after it.
  { id: 'piece_gift1', en: 'Yuleklapp (small)', slug: 'storage', anchor: 'yuleklapp-small', kind: 'piece', maxQuality: 1 },
];

const RECIPES: GraphRecipe[] = [
  // Each tab is the cost of that step alone; the wiki's Total row reads
  // 8 Wood, 80 Iron, 15 Leather scraps.
  step('SwordIron', 1, 'forge', 2, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 3]], { from: 'Iron Sword' }),
  step('SwordIron', 2, 'forge', 3, [['Wood', 1], ['Iron', 10], ['LeatherScraps', 2]], { from: 'Iron Sword' }),
  step('SwordIron', 3, 'forge', 4, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 4]], { from: 'Iron Sword' }),
  step('SwordIron', 4, 'forge', 5, [['Wood', 3], ['Iron', 30], ['LeatherScraps', 6]], { from: 'Iron Sword' }),
  // Smelting burns 2 Coal per bar; copper from scrap is an alternative.
  step('Iron', 1, 'smelter', 1, [['IronScrap', 1]], { method: 'smelt', fuel: ['Coal', 2] }),
  step('Copper', 1, 'smelter', 1, [['CopperOre', 1]], { method: 'smelt', fuel: ['Coal', 2], alt: 0 }),
  step('Copper', 1, 'smelter', 1, [['CopperScrap', 1]], { method: 'smelt', fuel: ['Coal', 2], alt: 1 }),
  step('Tin', 1, 'smelter', 1, [['TinOre', 1]], { method: 'smelt', fuel: ['Coal', 2] }),
  step('Bronze', 1, 'forge', 1, [['Copper', 2], ['Tin', 1]]),
  step('BronzeNails', 1, 'forge', 1, [['Bronze', 1]], { yield: 20 }),
  step('KnifeButcher', 1, 'forge', 1, [['Wood', 2], ['Tin', 4]]),
  step('Karve', 1, 'piece_workbench', 1, [['FineWood', 30], ['DeerHide', 10], ['Resin', 20], ['BronzeNails', 80]], { method: 'build' }),
  step('piece_cauldron', 1, 'forge', 1, [['Tin', 10]], { method: 'build' }),
  step('piece_MeadCauldron', 1, 'forge', 1, [['Tin', 4], ['Copper', 6], ['LeatherScraps', 2]], { method: 'build' }),
  step('forge_ext5', 1, 'forge', 1, [['FineWood', 25], ['Copper', 10]], { method: 'build' }),
  step('cauldron_ext1_spice', 1, 'piece_workbench', 1, [['Dandelion', 3], ['Carrot', 2], ['Mushroom', 5], ['Thistle', 3], ['Turnip', 3]], { method: 'build' }),
  step('cauldron_ext3_butchertable', 1, 'piece_workbench', 1, [['ElderBark', 2], ['RoundLog', 4], ['FineWood', 4], ['Silver', 2]], { method: 'build' }),
  step('cauldron_ext4_pots', 1, 'piece_workbench', 1, [['Iron', 5], ['Copper', 5], ['BlackMetal', 5], ['FineWood', 10]], { method: 'build' }),
  step('cauldron_ext5_mortarandpestle', 1, 'piece_workbench', 1, [['BlackMarble', 8], ['FineWood', 6], ['RoundLog', 4]], { method: 'build' }),
  step('cauldron_ext6_rollingpins', 1, 'piece_workbench', 1, [['Blackwood', 8], ['FineWood', 6], ['FlametalNew', 4]], { method: 'build' }),
  // One mead base ferments into six meads.
  step('MeadPoisonResist', 1, 'fermenter', 1, [['MeadBasePoisonResist', 1]], { method: 'ferment', yield: 6 }),
  step('MeadBasePoisonResist', 1, 'piece_MeadCauldron', 1, [['Honey', 10], ['Thistle', 5], ['NeckTail', 1], ['Coal', 10]], {
    method: 'brew',
    from: 'Poison Resistance Mead#Mead base',
  }),
  // Coal's only recipe is a choice: coal stays a gathered material.
  step('Coal', 1, 'charcoal_kiln', 1, [['Wood', 1]], { method: 'kiln', alt: 1 }),
  // Made by hand, at no station: more of Wood's uses than the Forge has.
  step('Torch', 1, null, 1, [['Wood', 1], ['Resin', 1]]),
  step('piece_workbench', 1, null, 1, [['Wood', 10]], { method: 'build' }),
  step('wood_stack', 1, null, 1, [['Wood', 50]], { method: 'build' }),
  // Bone fragments go into a tunic's second level only, and into bolts made twenty at a time.
  step('ArmorLeatherChest', 1, 'piece_workbench', 1, [['DeerHide', 6]]),
  step('ArmorLeatherChest', 2, 'piece_workbench', 2, [['DeerHide', 2], ['BoneFragments', 1]]),
  step('BoltBone', 1, 'piece_workbench', 3, [['Resin', 2], ['BoneFragments', 8]], { yield: 20 }),
  // The set's pieces, from Troll hide and Deer hide; the cooked meat from the raw.
  step('HelmetLeather', 1, 'piece_workbench', 1, [['DeerHide', 6]], { from: 'Leather Armor#Head' }),
  step('HelmetLeather', 2, 'piece_workbench', 2, [['DeerHide', 2]], { from: 'Leather Armor#Head' }),
  step('CapeDeerHide', 1, 'piece_workbench', 2, [['DeerHide', 4]], { from: 'Leather Armor#Cape' }),
  step('HelmetTrollLeather', 1, 'piece_workbench', 2, [['TrollHide', 5]], { from: 'Troll Set#Helmet' }),
  step('CookedDeerMeat', 1, null, 1, [['DeerMeat', 1]], { method: 'cook', from: 'Deer Meat#Cooked' }),
  step('CookedLoxMeat', 1, null, 1, [['LoxMeat', 1]], { method: 'cook', from: 'Lox Meat#Cooked' }),
];

const GRAPH: RecipeGraph = { v: 1, version: 'craft-view-graph', builtAt: '2026-10-27T18:00:00.000Z', items: ITEMS, recipes: RECIPES };

function reportOn(graph: RecipeGraph): GraphReport {
  return {
    items: graph.items.length,
    recipes: graph.recipes.length,
    products: new Set(graph.recipes.map((r) => r.product)).size,
    raw: 0,
    unresolved: [],
    cycles: [],
    levelConflicts: [],
    duplicates: [],
    yieldSuspects: [],
  };
}

/* -------------------------------------------------------------------------- */
/* The articles beside it                                                      */
/* -------------------------------------------------------------------------- */

const icon = (file: string) => `https://static.wikia.nocookie.net/valheim/images/a/a1/${file}/revision/latest?cb=20210215131319`;

/** Spanish titles as the translator stores them, with the English gloss. */
const TRANSLATED: Record<string, string> = {
  'Iron Sword': 'Espada de hierro (Iron Sword)',
  Wood: 'Madera (Wood)',
  Iron: 'Hierro (Iron)',
  'Leather Scraps': 'Recortes de cuero (Leather Scraps)',
  Coal: 'Carbón (Coal)',
  Copper: 'Cobre (Copper)',
  'Copper Ore': 'Mineral de cobre (Copper Ore)',
  Tin: 'Estaño (Tin)',
  'Tin Ore': 'Mineral de estaño (Tin Ore)',
  Bronze: 'Bronce (Bronze)',
  'Bronze Nails': 'Clavos de bronce (Bronze Nails)',
  'Butcher Knife': 'Cuchillo de carnicero (Butcher Knife)',
  'Deer Hide': 'Cuero de ciervo (Deer Hide)',
  // The same in both languages: no Spanish name of its own.
  Karve: 'Karve',
  Thistle: 'Cardo (Thistle)',
  'Neck Tail': 'Cola de Neck (Neck Tail)',
  'Poison Resistance Mead': 'Hidromiel de resistencia al veneno (Poison Resistance Mead)',
  'Spice Rack': 'Especiero (Spice Rack)',
  Torch: 'Antorcha (Torch)',
  'Wood Stack': 'Montón de madera (Wood Stack)',
  'Charcoal Kiln': 'Horno de carbón (Charcoal Kiln)',
  'Bone Fragments': 'Fragmentos de hueso (Bone Fragments)',
  'Silver Ore': 'Mineral de plata (Silver Ore)',
  'Iron Pickaxe': 'Pico de hierro (Iron Pickaxe)',
  'Leather Tunic': 'Túnica de cuero (Leather Tunic)',
  'Bone Bolt': 'Virote de hueso (Bone Bolt)',
};

/**
 * Articles the graph has no item for, which name where its raw materials
 * are had: a creature with a translation, one without, a trader. The stone
 * grave and the silver vein have no article at all.
 */
const PLACES: Record<string, string | null> = {
  Skeleton: 'Esqueleto (Skeleton)',
  'Rancid Remains': null,
  Haldor: null,
};

/** A gallery picture, as the ingest stores one: the grid-sized thumbnail. */
const gallery = (file: string, alt: string) => ({
  url: `https://static.wikia.nocookie.net/valheim/images/b/b2/${file}/revision/latest/scale-to-width-down/155?cb=20220220`,
  alt,
  caption: alt,
});

/**
 * Pages whose stored article is more than one item's infobox with its
 * picture. A page that shows one infobox per tab stores the first tab's
 * (`variants`): on an armor set, a piece's, titled by the piece; on a food or
 * a mead, the page's own item's. Its gallery may hold a picture of the whole
 * set, named after the page.
 */
const PAGE_DOCS: Record<string, { infobox?: Partial<ArticleInfobox>; images?: ArticleImage[] }> = {
  'Leather Armor': {
    infobox: { title: 'Leather helmet', image: { url: icon('Leather_Helmet.png'), alt: 'Leather helmet' }, variants: ['Head', 'Chest', 'Legs', 'Cape'] },
    images: [gallery('Leather_Armor.png', 'A complete Leather armor set.'), gallery('Leather_armor_back.jpg', 'From behind.')],
  },
  'Troll Set': {
    infobox: { title: 'Troll leather hood', image: { url: icon('Troll_Leather_Helmet.png'), alt: 'Troll leather helmet' }, variants: ['Helmet', 'Tunic', 'Trousers', 'Cape'] },
  },
  'Deer Meat': { infobox: { variants: ['Raw', 'Cooked'] }, images: [gallery('Deer.png', 'Deer')] },
  'Lox Meat': { infobox: { variants: ['Cooked', 'Raw'] } },
  'Poison Resistance Mead': { infobox: { variants: ['Mead', 'Mead base'] } },
  Yuleklapp: { infobox: { image: { url: icon('Yuleklapp_%28small%29.png'), alt: 'Yuleklapp' } } },
};

let nextPageId = 1;

/** What an ingest and a translation leave for one article: its page, the article with its picture, and its translation. */
async function seedArticle(db: Db, title: string, translated: string | null): Promise<void> {
  const pageId = nextPageId++;
  const pageKey = `fandom:${pageId}`;
  const url = `https://valheim.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const page = PAGE_DOCS[title];
  await db.execute(sql`
    INSERT INTO pages (key, source, page_id, title, url, revid)
    VALUES (${pageKey}, 'fandom', ${pageId}, ${title}, ${url}, 1)
  `);
  await upsertArticle(db, {
    pageKey,
    source: 'fandom',
    title,
    slug: slugify(title),
    url,
    categories: ['Materials'],
    doc: {
      lead: `${title}.`,
      blocks: [],
      infobox: { title, image: { url: icon(`${title.replace(/ /g, '_')}.png`), alt: title }, common: [], tabs: [], ...page?.infobox },
      images: page?.images ?? [],
      facets: {},
    },
  });
  if (translated) await translate(db, title, translated);
}

/** A translation of the article titled `title`, saved as the translation endpoint saves one. */
async function translate(db: Db, title: string, translated: string): Promise<void> {
  const [row] = await rawQuery<{ page_key: string }>(db, sql`SELECT page_key FROM articles WHERE title = ${title}`);
  await saveTranslation(db, {
    pageKey: row!.page_key,
    lang: 'es',
    title: translated,
    doc: { lead: '', blocks: [], infobox: null, images: [], facets: {} },
    model: 'test',
    sourceUpdatedAt: new Date(Date.now() + 60_000),
  });
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

const plain = (map: Map<ItemId, number>) => Object.fromEntries(map);

describe('the recipe graph as pages read it', () => {
  let handle: DbHandle;

  async function storeGraph(graph: RecipeGraph): Promise<void> {
    await writeRecipeGraph(handle.db, graph, reportOn(graph), 1, await getRecipeBasis(handle.db));
  }

  beforeAll(async () => {
    handle = await createTestDb();
    for (const item of ITEMS) {
      if (item.anchor !== undefined) continue;
      await seedArticle(handle.db, item.en, TRANSLATED[item.en] ?? null);
    }
    // An article the graph has nothing for.
    await seedArticle(handle.db, 'Eikthyr', null);
    // Pages that describe items of the graph but are none of them: an armor
    // set, and an article named like a thing described on another page.
    for (const title of ['Leather Armor', 'Troll Set', 'Mysterious Rock', 'Yuleklapp']) await seedArticle(handle.db, title, null);
    for (const [title, translated] of Object.entries(PLACES)) await seedArticle(handle.db, title, translated);
    await storeGraph(GRAPH);
    state.db = handle.db;
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(() => {
    state.failDb = false;
  });

  describe('getRecipeGraphData', () => {
    it('is cached across requests like the rest of the corpus: tagged, refilled hourly', () => {
      expect(registered).toEqual([{ keyParts: ['wiki-recipe-graph'], options: { tags: ['corpus'], revalidate: 3600 } }]);
    });

    it('names each item as its article is named today, though the graph was built before the translations', async () => {
      const graph = (await data.getRecipeGraphData())!;
      const item = (id: ItemId) => graph.items.find((i) => i.id === id)!;

      expect(graph.version).toBe('craft-view-graph');
      expect(item('Iron').es).toBe('Hierro');
      // The article's picture, as the title index sends it.
      expect(item('Iron').icon).toBe('a/a1/Iron.png?cb=20210215131319');
      // A station no one has translated takes the vocabulary's name, and its other names.
      expect(item('forge')).toMatchObject({ es: 'Forja', aliases: ['Fragua'] });
      // The hand-written list names an untranslated material.
      expect(item('FineWood').es).toBe('Madera fina');
      // No Spanish name anywhere: none is made up.
      expect(item('Resin').es).toBeUndefined();
      expect(item('Karve').es).toBeUndefined();
    });

    it("lets today's translation rename an item, keeping the names it had as aliases", async () => {
      const scraps = (await data.getRecipeGraphData())!.items.find((i) => i.id === 'LeatherScraps')!;
      expect(scraps.es).toBe('Recortes de cuero');
      expect(scraps.aliases).toEqual(expect.arrayContaining(['Retazos de cuero', 'Restos de cuero']));
      expect(scraps.aliases).not.toContain('Recortes de cuero');
    });

    it("keeps the overrides' name for an item described inside another page, never the page's", async () => {
      const base = (await data.getRecipeGraphData())!.items.find((i) => i.id === 'MeadBasePoisonResist')!;
      expect(base.es).toBe('Base de hidromiel: resistencia al veneno');
    });

    describe('pictures of things described inside another page', () => {
      const pictureOf = async (id: ItemId) => (await data.getRecipeGraphData())!.items.find((i) => i.id === id)!.icon;

      it("gives the first tab of a set its page's picture, which is that tab's, whatever its file is called", async () => {
        expect(await pictureOf('HelmetLeather')).toBe('a/a1/Leather_Helmet.png?cb=20210215131319');
        expect(await pictureOf('HelmetTrollLeather')).toBe('a/a1/Troll_Leather_Helmet.png?cb=20210215131319');
      });

      it("gives the other pieces of a set the set's own picture, never another piece's", async () => {
        // The gallery's picture named after the page: the whole set, cape included.
        expect(await pictureOf('CapeDeerHide')).toBe('b/b2/Leather_Armor.png?cb=20220220');
      });

      it("gives a food's other form, and a mead's base, the picture of the item the page is about", async () => {
        // Not the gallery's creature: the page's own infobox, the raw meat's.
        expect(await pictureOf('CookedDeerMeat')).toBe('a/a1/Deer_Meat.png?cb=20210215131319');
        expect(await pictureOf('MeadBasePoisonResist')).toBe('a/a1/Poison_Resistance_Mead.png?cb=20210215131319');
      });

      it('gives a thing with an article of its own by the same name that article\'s picture', async () => {
        expect(await pictureOf('Stonerock')).toBe('a/a1/Mysterious_Rock.png?cb=20210215131319');
      });

      it('gives a thing the picture named after it, whichever article holds it', async () => {
        // The Yuleklapp article's own picture is its small one's.
        expect(await pictureOf('piece_gift1')).toBe('a/a1/Yuleklapp_%28small%29.png?cb=20210215131319');
      });

      it('borrows nothing from a page that shows no tabs: its picture is the page\'s own item\'s', async () => {
        expect(await pictureOf('piece_smoker')).toBeUndefined();
      });

      it("never shows another thing in the picture of the page it is on", async () => {
        // On the mead's own page its base is no bottle of mead...
        const mead = (await data.getCraftView('poison-resistance-mead', 'es'))!;
        expect(mead.recipes[0]!.inputs[0]).toMatchObject({ id: 'MeadBasePoisonResist', icon: null });
        expect(decodeGraph(mead.closure).items.find((i) => i.id === 'MeadBasePoisonResist')!.icon).toBeUndefined();
        // ...nor the cooked meat raw meat on the raw meat's page.
        const meat = (await data.getCraftView('deer-meat', 'es'))!;
        expect(meat.usedIn.flatMap((g) => g.items).find((u) => u.id === 'CookedDeerMeat')).toMatchObject({ icon: null });
        expect(meat.item.icon).toBe('a/a1/Deer_Meat.png?cb=20210215131319');
        // Anywhere else they keep it.
        const honey = (await data.getCraftView('honey', 'es'))!;
        expect(honey.usedIn[0]!.items[0]).toMatchObject({ id: 'MeadBasePoisonResist', icon: 'a/a1/Poison_Resistance_Mead.png?cb=20210215131319' });
      });
    });

    it('changes names only: the items and recipes are the graph as it was built', async () => {
      const graph = (await data.getRecipeGraphData())!;
      expect(graph.recipes).toEqual(GRAPH.recipes);
      expect(graph.items.map((i) => i.id)).toEqual(GRAPH.items.map((i) => i.id));
    });

    it('reads the graph and the names in its own cached call, running nothing cached inside it', async () => {
      state.calls.length = 0;
      await data.getCraftView('iron-sword', 'es');
      expect(state.calls.map((c) => c.keyParts)).toEqual([['wiki-recipe-graph']]);
    });
  });

  describe('getCraftView', () => {
    it("gives the Iron Sword's four steps at Forge levels 2 to 5, named in Spanish", async () => {
      const view = (await data.getCraftView('iron-sword', 'es'))!;

      expect(view.item).toEqual({
        id: 'SwordIron',
        name: 'Espada de hierro',
        en: 'Iron Sword',
        slug: 'iron-sword',
        anchor: null,
        icon: 'a/a1/Iron_Sword.png?cb=20210215131319',
        kind: 'item',
        maxQuality: 4,
      });
      expect(view.recipes.map((r) => [r.quality, r.station?.name, r.stationLevel, r.inputs.map((i) => `${i.name}:${i.qty}`)])).toEqual([
        [1, 'Forja', 2, ['Madera:2', 'Hierro:20', 'Recortes de cuero:3']],
        [2, 'Forja', 3, ['Madera:1', 'Hierro:10', 'Recortes de cuero:2']],
        [3, 'Forja', 4, ['Madera:2', 'Hierro:20', 'Recortes de cuero:4']],
        [4, 'Forja', 5, ['Madera:3', 'Hierro:30', 'Recortes de cuero:6']],
      ]);
      expect(view.recipes[0]!.station).toEqual({ id: 'forge', name: 'Forja', en: 'Forge', slug: 'forge', anchor: null, icon: 'a/a1/Forge.png?cb=20210215131319' });
      expect(view.recipes[0]!.inputs[1]).toEqual({
        id: 'Iron',
        name: 'Hierro',
        en: 'Iron',
        slug: 'iron',
        anchor: null,
        icon: 'a/a1/Iron.png?cb=20210215131319',
        qty: 20,
      });
      expect(view.recipes[0]).toMatchObject({ alt: 0, yield: 1, yieldKnown: true, fuel: null });
      // A weapon is no one's ingredient, and no station.
      expect(view.usedIn).toEqual([]);
      expect(view.station).toBeUndefined();
    });

    it('carries a closure that breaks the sword down to raw materials without the full graph', async () => {
      const view = (await data.getCraftView('iron-sword', 'es'))!;
      const full = indexGraph((await data.getRecipeGraphData())!);
      const closure = decodeGraph(view.closure);
      const slice = indexGraph(closure);

      expect(plain(totalCost(slice, 'SwordIron', 0, 4))).toEqual({ Wood: 8, Iron: 80, LeatherScraps: 15 });
      for (const demand of [new Map([['SwordIron', 1]]), totalCost(full, 'SwordIron', 0, 4)]) {
        expect(expandRaw(slice, demand)).toEqual(expandRaw(full, demand));
      }
      expect(plain(expandRaw(slice, totalCost(slice, 'SwordIron', 0, 4)).raw)).toEqual({ Wood: 8, IronScrap: 80, LeatherScraps: 15 });

      // Only what the sword needs, with its stations named: none of the rest of the graph.
      expect(closure.items.map((i) => i.id).sort()).toEqual(
        ['Coal', 'Iron', 'IronScrap', 'LeatherScraps', 'SwordIron', 'Wood', 'forge', 'smelter'].sort(),
      );
      expect(closure.recipes.map((r) => `${r.product}@${r.quality}`)).toEqual([
        'SwordIron@1',
        'SwordIron@2',
        'SwordIron@3',
        'SwordIron@4',
        'Iron@1',
      ]);
    });

    it("names the closure in the reader's language only, and leaves the planner's details to the whole graph", async () => {
      const spanish = decodeGraph((await data.getCraftView('iron-sword', 'es'))!.closure).items.find((i) => i.id === 'LeatherScraps')!;
      expect(spanish).toMatchObject({ en: 'Leather Scraps', es: 'Recortes de cuero', slug: 'leather-scraps' });
      // Search's names, and where a material is had, in English only: neither is the card's.
      expect(spanish.aliases).toBeUndefined();
      expect(spanish.obtain).toBeUndefined();
      expect((await data.getRecipeGraphData())!.items.find((i) => i.id === 'LeatherScraps')!.obtain).toEqual([
        { how: 'drop', from: ['Boar'] },
      ]);

      const english = (await data.getCraftView('iron-sword', 'en'))!;
      const closure = decodeGraph(english.closure);
      expect(closure.items.every((i) => i.es === undefined && i.aliases === undefined)).toBe(true);
      expect(english.recipes[0]!.inputs.map((i) => i.name)).toEqual(['Wood', 'Iron', 'Leather Scraps']);
      // A station's levels and extensions are the station's own view: here they would name items the slice does not hold.
      expect(closure.items.find((i) => i.id === 'forge')).toEqual(
        expect.not.objectContaining({ station: expect.anything() }),
      );
    });

    it('gives the island everything the card shows in the closure, compact as the planner downloads it', async () => {
      const byStep = (a: { quality: number; alt?: number }, b: { quality: number; alt?: number }) =>
        a.quality - b.quality || (a.alt ?? 0) - (b.alt ?? 0);
      for (const [slug, lang] of [['copper', 'es'], ['iron-sword', 'en'], ['karve', 'es']] as const) {
        const view = (await data.getCraftView(slug, lang))!;
        // The codec's arrays, not objects: the island's props are a few kilobytes at most.
        expect(Array.isArray(view.closure.i), slug).toBe(true);
        const closure = indexGraph(decodeGraph(view.closure));

        // Every step `recipes` resolves for the server, alternatives included, read from the closure alone...
        expect(
          [...closure.recipes.get(view.item.id)!]
            .sort(byStep)
            .map((r) => [r.quality, r.alt ?? 0, r.station, r.stationLevel, r.yield, r.yieldKnown, r.inputs, r.fuel ?? null]),
          slug,
        ).toEqual(
          view.recipes.map((r) => [
            r.quality,
            r.alt,
            r.station?.id ?? null,
            r.stationLevel,
            r.yield,
            r.yieldKnown,
            r.inputs.map((i) => [i.id, i.qty]),
            r.fuel ? [r.fuel.id, r.fuel.qty] : null,
          ]),
        );
        // ...with the name, article and picture of everything they name.
        for (const ref of view.recipes.flatMap((r) => [r.station, ...r.inputs, r.fuel])) {
          if (!ref) continue;
          const item = closure.items.get(ref.id)!;
          expect(
            { name: lang === 'es' ? (item.es ?? item.en) : item.en, en: item.en, slug: item.slug ?? null, anchor: item.anchor ?? null, icon: item.icon ?? null },
            `${slug}: ${ref.id}`,
          ).toEqual({ name: ref.name, en: ref.en, slug: ref.slug, anchor: ref.anchor, icon: ref.icon });
        }
      }
    });

    it("breaks a Karve's 80 nails down to 4 Bronze, through the yield", async () => {
      const view = (await data.getCraftView('karve', 'es'))!;
      expect(view.recipes[0]!.inputs.map((i) => i.name)).toEqual(['Madera fina', 'Cuero de ciervo', 'Resin', 'Clavos de bronce']);
      expect(view.recipes[0]!.station?.name).toBe('Banco de trabajo');

      const closure = decodeGraph(view.closure);
      const r = expandRaw(indexGraph(closure), new Map([['Karve', 1]]));
      expect(plain(r.raw)).toEqual({ FineWood: 30, DeerHide: 10, Resin: 20, CopperOre: 8, TinOre: 4 });
      expect(plain(r.fuel)).toEqual({ Coal: 24 });
      expect(r.crafts.find((s) => s.recipe.product === 'BronzeNails')).toMatchObject({ crafts: 4, produced: 80 });
      // The scrap alternative is never planned with, so the slice leaves it out.
      expect(closure.items.some((i) => i.id === 'CopperScrap')).toBe(false);
    });

    it('lists where Tin goes, grouped by station', async () => {
      const view = (await data.getCraftView('tin', 'en'))!;
      expect(view.usedIn).toEqual([
        {
          station: { id: 'forge', name: 'Forge', en: 'Forge', slug: 'forge', anchor: null, icon: 'a/a1/Forge.png?cb=20210215131319' },
          items: [
            expect.objectContaining({ id: 'Bronze', name: 'Bronze', quality: 1, qty: 1 }),
            expect.objectContaining({ id: 'KnifeButcher', name: 'Butcher Knife', quality: 1, qty: 4 }),
            expect.objectContaining({ id: 'piece_cauldron', name: 'Cauldron', quality: 1, qty: 10 }),
            expect.objectContaining({ id: 'piece_MeadCauldron', name: 'Mead Ketill', quality: 1, qty: 4 }),
          ],
        },
      ]);
      // Tin's own recipe burns coal at the smelter.
      expect(view.recipes).toEqual([
        expect.objectContaining({
          station: expect.objectContaining({ id: 'smelter', name: 'Smelter' }),
          inputs: [expect.objectContaining({ id: 'TinOre', qty: 1 })],
          fuel: expect.objectContaining({ id: 'Coal', name: 'Coal', qty: 2 }),
        }),
      ]);
    });

    it('lists a use once per product, at the first step that needs it, and the busiest station first', async () => {
      const iron = (await data.getCraftView('iron', 'es'))!;
      // The sword needs Iron at every step; it is one use, from new.
      expect(iron.usedIn.flatMap((g) => g.items.map((i) => [i.id, i.quality, i.qty]))).toEqual(
        expect.arrayContaining([['SwordIron', 1, 20], ['cauldron_ext4_pots', 1, 5]]),
      );
      expect(iron.usedIn.flatMap((g) => g.items).filter((i) => i.id === 'SwordIron')).toHaveLength(1);

      const copper = (await data.getCraftView('copper', 'es'))!;
      expect(copper.usedIn.map((g) => [g.station?.name, g.items.map((i) => i.name)])).toEqual([
        ['Forja', ['Bronce', 'Forge Cooler', 'Mead Ketill']],
        ['Banco de trabajo', ['Pots and Pans']],
      ]);
      // Both ways copper is made, the preferred one first.
      expect(copper.recipes.map((r) => [r.alt, r.inputs[0]!.id])).toEqual([
        [0, 'CopperOre'],
        [1, 'CopperScrap'],
      ]);
      // Scrap's only use is the alternative.
      const scrap = (await data.getCraftView('copper-scrap', 'es'))!;
      expect(scrap.usedIn).toEqual([{ station: expect.objectContaining({ id: 'smelter' }), items: [expect.objectContaining({ id: 'Copper', qty: 1 })] }]);
    });

    it("orders a station's uses as its menu does: what it crafts, by the level it needs, then what is built near it", async () => {
      const hide = (await data.getCraftView('deer-hide', 'es'))!;
      expect(hide.usedIn.map((g) => [g.station?.name, g.items.map((i) => `${i.name}:${i.method}:${i.stationLevel}`)])).toEqual([
        ['Banco de trabajo', ['Casco de cuero:craft:1', 'Túnica de cuero:craft:1', 'Capa de piel de ciervo:craft:2', 'Karve:build:1']],
      ]);
    });

    it("says of each use whether its article opens on it, and so shows the levels a link can name", async () => {
      const opens = async (slug: string) =>
        Object.fromEntries((await data.getCraftView(slug, 'en'))!.usedIn.flatMap((g) => g.items.map((i) => [i.id, i.ownPage])));
      expect(await opens('deer-hide')).toEqual({
        // A set's page opens on its first tab's piece, whose levels its infobox shows...
        HelmetLeather: true,
        // ...and an article of its own on its own item...
        ArmorLeatherChest: true,
        Karve: true,
        // ...but another piece of the set is described on a page whose levels are the helmet's.
        CapeDeerHide: false,
      });
      expect(await opens('troll-hide')).toEqual({ HelmetTrollLeather: true });
      // A page with an item of its own opens on that item, whatever its tabs:
      // the raw meat, though the cooked form's tab comes first.
      expect(await opens('deer-meat')).toEqual({ CookedDeerMeat: false });
      expect(await opens('lox-meat')).toEqual({ CookedLoxMeat: false });
      expect((await data.getCraftView('lox-meat', 'en'))!.item.id).toBe('LoxMeat');
    });

    it('lists what is made by hand last, however much of it there is', async () => {
      const wood = (await data.getCraftView('wood', 'es'))!;
      expect(wood.usedIn.map((g) => [g.station?.name ?? null, g.items.map((i) => i.name)])).toEqual([
        ['Forja', ['Cuchillo de carnicero', 'Espada de hierro']],
        ['Horno de carbón', ['Carbón']],
        // Three things, more than the Forge's two, and still after every station.
        [null, ['Antorcha', 'Banco de trabajo', 'Montón de madera']],
      ]);
    });

    it('gives each use the whole step it goes into, the material first and the rest as the wiki lists them', async () => {
      const view = (await data.getCraftView('bone-fragments', 'es'))!;
      const workbench = {
        id: 'piece_workbench',
        name: 'Banco de trabajo',
        en: 'Workbench',
        slug: 'workbench',
        anchor: null,
        icon: 'a/a1/Workbench.png?cb=20210215131319',
      };
      const bones = { id: 'BoneFragments', name: 'Fragmentos de hueso', en: 'Bone Fragments', slug: 'bone-fragments', anchor: null };

      expect(view.usedIn).toEqual([
        {
          station: workbench,
          items: [
            {
              id: 'ArmorLeatherChest',
              name: 'Túnica de cuero',
              en: 'Leather Tunic',
              slug: 'leather-tunic',
              anchor: null,
              icon: 'a/a1/Leather_Tunic.png?cb=20210215131319',
              // The tunic's second level, an upgrade: making it new takes no bone.
              quality: 2,
              qty: 1,
              method: 'craft',
              station: workbench,
              stationLevel: 2,
              yield: 1,
              yieldKnown: true,
              // Its own article, which a link can open at that level.
              ownPage: true,
              inputs: [
                expect.objectContaining({ ...bones, qty: 1 }),
                expect.objectContaining({ id: 'DeerHide', name: 'Cuero de ciervo', en: 'Deer Hide', qty: 2 }),
              ],
            },
            expect.objectContaining({
              id: 'BoltBone',
              name: 'Virote de hueso',
              quality: 1,
              qty: 8,
              stationLevel: 3,
              // Twenty bolts a craft: a card says so.
              yield: 20,
              yieldKnown: true,
              // The wiki lists the resin first; the bones lead here, being the page's own material.
              inputs: [expect.objectContaining({ ...bones, qty: 8 }), expect.objectContaining({ id: 'Resin', name: 'Resin', qty: 2 })],
            }),
          ],
        },
      ]);
    });

    it('carries the same step on every use, alternatives and station levels included', async () => {
      const scrap = (await data.getCraftView('copper-scrap', 'en'))!;
      // Copper from scrap is the alternative: it is still where scrap goes.
      expect(scrap.usedIn[0]!.items[0]).toMatchObject({
        id: 'Copper',
        method: 'smelt',
        station: expect.objectContaining({ id: 'smelter', name: 'Smelter' }),
        stationLevel: 1,
        inputs: [expect.objectContaining({ id: 'CopperScrap', name: 'Copper Scrap', qty: 1 })],
      });

      const wood = (await data.getCraftView('wood', 'es'))!;
      const sword = wood.usedIn.flatMap((g) => g.items).find((i) => i.id === 'SwordIron')!;
      // The first step that takes wood: making the sword, at a level 2 Forge.
      expect(sword).toMatchObject({ quality: 1, qty: 2, stationLevel: 2, station: expect.objectContaining({ name: 'Forja' }) });
      expect(sword.inputs.map((i) => `${i.name}:${i.qty}`)).toEqual(['Madera:2', 'Hierro:20', 'Recortes de cuero:3']);
      // What is made by hand has no station on its uses either.
      const torch = wood.usedIn.at(-1)!.items.find((i) => i.id === 'Torch')!;
      expect(torch).toMatchObject({ station: null, stationLevel: 1, inputs: [expect.objectContaining({ id: 'Wood' }), expect.objectContaining({ id: 'Resin' })] });
    });

    it('says how a raw material is had, naming creatures and places as their articles do', async () => {
      const view = (await data.getCraftView('bone-fragments', 'es'))!;
      expect(view.obtain).toEqual([
        {
          how: 'drop',
          from: [
            { name: 'Esqueleto', en: 'Skeleton', slug: 'skeleton', icon: 'a/a1/Skeleton.png?cb=20210215131319' },
            // Found in another letter case; with no translation, the English name.
            { name: 'Rancid remains', en: 'Rancid remains', slug: 'rancid-remains', icon: 'a/a1/Rancid_Remains.png?cb=20210215131319' },
          ],
          tool: null,
        },
        // No article for the grave, and a tool the graph has no item for: both shown as far as they are known, no id.
        { how: 'mine', from: [{ name: 'Stone Grave', en: 'Stone Grave', slug: null, icon: null }], tool: null },
      ]);

      const english = (await data.getCraftView('bone-fragments', 'en'))!;
      expect(english.obtain[0]).toMatchObject({ from: [expect.objectContaining({ name: 'Skeleton', slug: 'skeleton' }), expect.anything()] });
    });

    it('names the tool a material needs, where the graph knows it', async () => {
      const view = (await data.getCraftView('silver-ore', 'es'))!;
      expect(view.obtain).toEqual([
        {
          how: 'mine',
          from: [{ name: 'Silver vein', en: 'Silver vein', slug: null, icon: null }],
          tool: {
            id: 'PickaxeIron',
            name: 'Pico de hierro',
            en: 'Iron Pickaxe',
            slug: 'iron-pickaxe',
            anchor: null,
            icon: 'a/a1/Iron_Pickaxe.png?cb=20210215131319',
          },
        },
      ]);
    });

    it('names the trader a material is bought from, and its price', async () => {
      const view = (await data.getCraftView('thunder-stone', 'en'))!;
      expect(view.obtain).toEqual([
        { how: 'buy', from: { name: 'Haldor', en: 'Haldor', slug: 'haldor', icon: 'a/a1/Haldor.png?cb=20210215131319' }, coins: 50 },
      ]);
      // Bought, and used in nothing here.
      expect(view.usedIn).toEqual([]);
      expect(view.recipes).toEqual([]);
    });

    it('says nothing of how a thing that is made is had', async () => {
      expect((await data.getCraftView('iron-sword', 'es'))!.obtain).toEqual([]);
      expect((await data.getCraftView('bronze', 'es'))!.obtain).toEqual([]);
    });

    it("gives the Cauldron's six levels and its five extensions with their materials", async () => {
      const view = (await data.getCraftView('cauldron', 'es'))!;
      expect(view.item).toMatchObject({ id: 'piece_cauldron', name: 'Caldero', kind: 'station' });
      expect(view.station!.maxLevel).toBe(6);
      expect(view.station!.extensions.map((e) => e.name)).toEqual([
        'Especiero',
        "Butcher's Table",
        'Pots and Pans',
        'Mortar and Pestle',
        'Rolling Pins and Cutting Boards',
      ]);
      expect(view.station!.extensions[0]!.inputs.map((i) => `${i.id}:${i.qty}`)).toEqual([
        'Dandelion:3',
        'Carrot:2',
        'Mushroom:5',
        'Thistle:3',
        'Turnip:3',
      ]);
      expect(view.station!.extensions[0]).toMatchObject({ id: 'cauldron_ext1_spice', slug: 'spice-rack' });
      expect(view.recipes.map((r) => [r.station?.name, r.inputs.map((i) => `${i.name}:${i.qty}`)])).toEqual([['Forja', ['Estaño:10']]]);
    });

    it('tells a mead from the base on its own page, each its own item', async () => {
      const mead = (await data.getCraftView('poison-resistance-mead', 'es'))!;
      expect(mead.item).toMatchObject({ id: 'MeadPoisonResist', name: 'Hidromiel de resistencia al veneno', anchor: null });
      expect(mead.recipes[0]).toMatchObject({ yield: 6, yieldKnown: true, station: expect.objectContaining({ id: 'fermenter', name: 'Fermentador' }) });
      expect(mead.recipes[0]!.inputs).toEqual([
        {
          id: 'MeadBasePoisonResist',
          name: 'Base de hidromiel: resistencia al veneno',
          en: 'Mead base: Poison resistance',
          slug: 'poison-resistance-mead',
          anchor: 'mead-base',
          icon: null,
          qty: 1,
        },
      ]);
      // One batch of six, down to what the base is brewed from.
      expect(plain(expandRaw(indexGraph(decodeGraph(mead.closure)), new Map([['MeadPoisonResist', 6]])).raw)).toEqual({
        Honey: 10,
        Thistle: 5,
        NeckTail: 1,
        Coal: 10,
      });

      const base = (await data.getCraftView('poison-resistance-mead', 'es', 'mead-base'))!;
      expect(base.item).toMatchObject({ id: 'MeadBasePoisonResist', name: 'Base de hidromiel: resistencia al veneno', anchor: 'mead-base' });
      expect(base.recipes[0]!.station).toMatchObject({ id: 'piece_MeadCauldron', name: 'Mead Ketill' });
      expect(base.usedIn).toEqual([{ station: expect.objectContaining({ id: 'fermenter' }), items: [expect.objectContaining({ id: 'MeadPoisonResist', qty: 1 })] }]);
    });

    it('is null for a page the graph has nothing for', async () => {
      expect(await data.getCraftView('no-such-article', 'es')).toBeNull();
      expect(await data.getCraftView('eikthyr', 'es')).toBeNull();
      expect(await data.getCraftView('poison-resistance-mead', 'es', 'no-such-tab')).toBeNull();
    });

    it("gives a set's page, which has no item of its own, the piece its infobox shows: its first tab's", async () => {
      const set = (await data.getCraftView('leather-armor', 'es'))!;
      expect(set.item).toMatchObject({ id: 'HelmetLeather', name: 'Casco de cuero', anchor: 'head', maxQuality: 2 });
      expect(set.recipes.map((r) => [r.quality, r.inputs.map((i) => `${i.id}:${i.qty}`)])).toEqual([
        [1, ['DeerHide:6']],
        [2, ['DeerHide:2']],
      ]);
      expect((await data.getCraftView('troll-set', 'en'))!.item).toMatchObject({ id: 'HelmetTrollLeather', name: 'Troll leather hood' });
      // A page with an item of its own is that item's, whatever its tabs.
      expect((await data.getCraftView('deer-meat', 'es'))!.item.id).toBe('DeerMeat');
    });
  });

  describe('when there is no graph to read', () => {
    it('has none before the first is written, and keeps that answer like any other', async () => {
      await handle.db.execute(sql`DELETE FROM recipe_graph`);
      try {
        state.stored.clear();
        expect(await data.getRecipeGraphData()).toBeNull();
        expect(await data.getCraftView('iron-sword', 'es')).toBeNull();
        // Kept, so that until an ingest writes one no page asks the database again.
        expect(state.stored.get('wiki-recipe-graph')).toBeNull();
      } finally {
        await storeGraph(GRAPH);
      }
    });

    it('serves none rather than one the planner could not decode, and says so in the log', async () => {
      const broken: RecipeGraph = {
        ...GRAPH,
        version: 'broken',
        recipes: [...GRAPH.recipes, step('Bronze', 2, 'forge', 2, [['NotAnItem', 1]])],
      };
      await storeGraph(broken);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await data.getRecipeGraphData()).toBeNull();
        expect(await data.getCraftView('bronze', 'es')).toBeNull();
        expect(errors.mock.calls.map(([scope]) => scope)).toContain('[recipes]');
        expect(String(errors.mock.calls[0]?.[1])).toContain('NotAnItem');
      } finally {
        errors.mockRestore();
        await storeGraph(GRAPH);
      }
      expect((await data.getRecipeGraphData())?.version).toBe('craft-view-graph');
    });

    it('leaves the article without its card when the database fails, and says so in the log', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      state.failDb = true;
      try {
        await expect(data.getRecipeGraphData()).rejects.toThrow('database unavailable');
        expect(await data.getCraftView('iron-sword', 'es')).toBeNull();
        expect(errors).toHaveBeenCalledWith('[recipes]', expect.stringContaining('iron-sword'));
      } finally {
        state.failDb = false;
        errors.mockRestore();
      }
    });
  });

  describe('names made after the graph was built', () => {
    it('names an item from a translation saved since, on the next refill', async () => {
      const honey = async () => (await data.getRecipeGraphData())!.items.find((i) => i.id === 'Honey')!.es;
      expect(await honey()).toBeUndefined();

      await translate(handle.db, 'Honey', 'Miel (Honey)');

      expect(await honey()).toBe('Miel');
      const base = (await data.getCraftView('poison-resistance-mead', 'es', 'mead-base'))!;
      expect(base.recipes[0]!.inputs[0]).toMatchObject({ id: 'Honey', name: 'Miel', en: 'Honey' });
    });

    it('names a place a material comes from by a translation saved since, on the next refill', async () => {
      const remains = async () => (await data.getCraftView('bone-fragments', 'es'))!.obtain[0];
      expect(await remains()).toMatchObject({ from: [expect.anything(), expect.objectContaining({ name: 'Rancid remains' })] });

      await translate(handle.db, 'Rancid Remains', 'Restos rancios (Rancid Remains)');

      expect(await remains()).toMatchObject({
        from: [expect.anything(), { name: 'Restos rancios', en: 'Rancid remains', slug: 'rancid-remains', icon: expect.any(String) }],
      });
    });
  });
});
