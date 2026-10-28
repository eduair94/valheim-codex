import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { decodeGraph } from '@/lib/craft/codec';
import { expandRaw, indexGraph, totalCost } from '@/lib/craft/math';
import type { GraphItem, GraphRecipe, GraphReport, ItemId, RecipeGraph } from '@/lib/craft/types';
import { rawQuery, type Db, type DbHandle } from '@/lib/db/create-db';
import { getRecipeBasis, writeRecipeGraph } from '@/lib/db/recipe-repo';
import { saveTranslation, upsertArticle } from '@/lib/db/wiki-repo';
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
};

let nextPageId = 1;

/** What an ingest and a translation leave for one article: its page, the article with its picture, and its translation. */
async function seedArticle(db: Db, title: string, translated: string | null): Promise<void> {
  const pageId = nextPageId++;
  const pageKey = `fandom:${pageId}`;
  const url = `https://valheim.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
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
      infobox: { title, image: { url: icon(`${title.replace(/ /g, '_')}.png`), alt: title }, common: [], tabs: [] },
      images: [],
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
      // Nor the page's picture: that is the mead's.
      expect(base.icon).toBeUndefined();
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

    it('lists what is made by hand last, however much of it there is', async () => {
      const wood = (await data.getCraftView('wood', 'es'))!;
      expect(wood.usedIn.map((g) => [g.station?.name ?? null, g.items.map((i) => i.name)])).toEqual([
        ['Forja', ['Cuchillo de carnicero', 'Espada de hierro']],
        ['Horno de carbón', ['Carbón']],
        // Three things, more than the Forge's two, and still after every station.
        [null, ['Antorcha', 'Banco de trabajo', 'Montón de madera']],
      ]);
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
  });
});
