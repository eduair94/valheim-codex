import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { getDb } from '@/lib/db/client';
import { getLatestRecipeGraph } from '@/lib/db/recipe-repo';
import { getSearchIndex, type TitleIndexEntry } from '@/lib/db/wiki-repo';
import { spanishTitle } from '@/lib/i18n/article-names';
import type { Lang } from '@/lib/i18n/strings';
import { logError } from '@/lib/log';
import { CORPUS_TAG } from '@/lib/wiki/data';
import { encodeGraph, type WireGraph } from './codec';
import { indexGraph, stepCost, usedIn, type GraphIndex } from './math';
import type { GraphItem, GraphRecipe, ItemId, ItemKind, RecipeGraph } from './types';

/**
 * The recipe graph, for the pages and the API that serve it.
 *
 * The ingest assembles one graph per run, on another machine, and stores it
 * as one row (src/lib/db/recipe-repo.ts). Readers get it two ways: the
 * planner downloads all of it, compact (`/api/wiki/recipes?v=1`), and an
 * item's article gets a slice of it small enough to be the props of one
 * client island (`getCraftView`). The whole graph never goes into a page.
 *
 * It is cached like the rest of the corpus (src/lib/wiki/data.ts):
 * `unstable_cache` tagged `corpus` and refilled at most an hour after it was
 * filled, behind React `cache()` so that one request reads it once. Nothing
 * revalidates the tag: the ingest that writes a new graph cannot reach this
 * server's cache, so a new graph is served within the hour, as everything
 * else an ingest changes is. The entry is the whole graph with its names, a
 * few hundred kilobytes of JSON: well inside the 2 MB Next allows one data
 * cache entry (a development server throws past it, and production stops
 * caching the entry).
 *
 * Names are the one thing not served as stored. The assembly names items
 * from the translations of the day it ran, and an article translated since
 * would not name its item until the next ingest. So every refill reads the
 * search index's names beside the graph, inside the same cached call: no
 * cached function here calls another, for the reason data.ts gives (Next
 * would run an inner one on every refill without ever reading its entry).
 */

/** Seconds before the cached graph is refilled even if nothing invalidated it: hourly, as the search index is. */
const REVALIDATE = 3600;

/* -------------------------------------------------------------------------- */
/* The whole graph: the planner, the chat                                      */
/* -------------------------------------------------------------------------- */

/**
 * The graph to serve, with today's names. Null until an ingest has written
 * one, or when the newest one stored is one no reader could decode.
 *
 * Used by `/api/wiki/recipes?v=1`, by `getCraftView`, and by the chat. The
 * same for every reader and both languages: an item carries its English name
 * and its Spanish one, and each reader picks.
 *
 * A null is kept like any other answer. Before the first graph is written,
 * every article page would otherwise ask the database for one on every view,
 * and where the table is still missing say so in the log on every view; the
 * first graph is served within the hour instead, like any ingest's changes.
 * A failed read is not kept (`unstable_cache` keeps nothing that rejects), so
 * the next request asks again.
 */
export const getRecipeGraphData = cache((): Promise<RecipeGraph | null> => storedRecipeGraph());

/** The newest graph and the article names, read side by side; named and checked here, once per refill. */
async function readRecipeGraph(): Promise<RecipeGraph | null> {
  const db = await getDb();
  // Side by side: once a graph exists, as it does on almost every refill,
  // the names cost no round trip of their own; while none does, they are one
  // unused read an hour.
  const [stored, titles] = await Promise.all([getLatestRecipeGraph(db), getSearchIndex(db)]);
  if (!stored) return null;
  try {
    const graph = withNames(stored.graph, titles);
    // The checks the planner's `decodeGraph` makes, made here once, so that a
    // graph the assembly got wrong (a recipe naming an item the graph lacks)
    // is no graph anywhere: neither a payload that fails in every browser
    // that downloads it, nor article cards drawn from it. The graphs stored
    // before it are still there: deleting its row serves the one before.
    encodeGraph(graph);
    return graph;
  } catch (error) {
    const version = (stored.graph as { version?: unknown } | null)?.version;
    logError('recipes', error, { stage: 'serve', version: typeof version === 'string' ? version : null });
    return null;
  }
}

const storedRecipeGraph = unstable_cache(readRecipeGraph, ['wiki-recipe-graph'], {
  tags: [CORPUS_TAG],
  revalidate: REVALIDATE,
});

/**
 * The graph with every item named as readers see it today. Recipes are not
 * touched.
 *
 * An item with an article of its own takes the names the search index gives
 * that article (`getSearchIndex`: the stored translation's title without its
 * gloss, then the hand-written names, then the vocabulary) and its picture:
 * a translation saved after the graph was built names its item. A Spanish
 * name the graph was built with that today's differs from stays as an
 * alias, so a reader who learned it as "Restos de cuero" still finds it.
 *
 * An item described inside another page (a mead base, an armor piece, a
 * building piece from a list) keeps the name the assembly gave it, from the
 * overrides' curated names: the names and the picture the search index has
 * for its page are the page's own item's, the mead's or the set's. Failing a
 * name from the assembly, the hand-written names and the vocabulary still
 * apply (`spanishTitle` with no translation), as they do for an item whose
 * article the index no longer has.
 */
function withNames(graph: RecipeGraph, titles: readonly TitleIndexEntry[]): RecipeGraph {
  const articles = new Map(titles.map((entry) => [entry.s, entry]));
  return { ...graph, items: graph.items.map((item) => named(item, articles)) };
}

function named(item: GraphItem, articles: ReadonlyMap<string, TitleIndexEntry>): GraphItem {
  const { es: built, aliases: builtAliases, icon: builtIcon, ...rest } = item;
  const entry = item.slug !== undefined && item.anchor === undefined ? articles.get(item.slug) : undefined;
  const listed = entry ? null : spanishTitle(item.en, null);

  const es = entry?.e ?? built ?? listed?.name ?? undefined;
  const aliases = otherNames(
    [...(entry?.a ?? []), ...(builtAliases ?? []), ...(built !== undefined ? [built] : []), ...(listed?.aliases ?? [])],
    [item.en, es],
  );
  const icon = entry?.i ?? builtIcon;

  const out: GraphItem = rest;
  if (es !== undefined) out.es = es;
  if (aliases.length > 0) out.aliases = aliases;
  if (icon !== undefined) out.icon = icon;
  return out;
}

/** Each name once, in its first spelling, leaving out the ones the item is already shown by. Case never makes two names. */
function otherNames(names: readonly string[], shown: readonly (string | undefined)[]): string[] {
  const key = (name: string): string => name.trim().toLowerCase();
  const seen = new Set(shown.filter((name): name is string => name !== undefined).map(key));
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(key(name))) continue;
    seen.add(key(name));
    out.push(name);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* One item's slice: its article                                               */
/* -------------------------------------------------------------------------- */

/** An item as a view names it, ready for a tile or a link. */
export type CraftRef = {
  id: ItemId;
  /** The name to show: the Spanish one for a Spanish reader where there is one, else the English one. */
  name: string;
  /** The English name, which a Spanish interface shows beside the Spanish one. */
  en: string;
  /** The article that describes it; null when none does. */
  slug: string | null;
  /** The tab or section of that article that describes it: a mead's base, an armor piece. */
  anchor: string | null;
  /** Its picture, as the title index sends icons (`expandIcon`). */
  icon: string | null;
};

/** A quantity of an item: a material of a step, or the fuel a step burns. */
export type CraftAmount = CraftRef & { qty: number };

/**
 * What an item's article shows about making it, already in the reader's
 * language: its steps, the slice of the graph its breakdown to raw materials
 * needs, what it goes into, and for a station, its upgrades.
 *
 * The craft card's client island takes `item` and `closure`, and nothing
 * else. Every step the card can show is in the closure, alternatives
 * included, with the name, article and picture of everything those steps
 * name, and the totals and the breakdown are worked out from it in the
 * browser. The closure travels compact, as the planner's download does: on
 * the graph built from the live wiki (853 items, 1,147 recipes) the two come
 * to at most 2.2 KB of props for any of its 662 products, 1.0 KB for an
 * Iron Sword, where the same closure as objects passed 3 KB for 59 of them.
 * `recipes`, `usedIn` and `station` are the same facts resolved for the
 * server's own rendering, which sends the reader only what the page shows of
 * them. As props they would break the island's budget: `recipes` repeats a
 * whole reference for every input of every step, 7.6 KB for the four steps
 * of a fishing hat.
 */
export type CraftView = {
  item: CraftRef & { kind: ItemKind; maxQuality: number };
  /**
   * Every step of the item, by quality (1 is making it new); for one quality,
   * the recipe the maths plans with before its alternatives. Each is the cost
   * of that step alone, as the wiki's tabs state it.
   */
  recipes: {
    quality: number;
    /** 0 for the recipe the maths plans with; 1 and up for an alternative (copper from scrap). */
    alt: number;
    /** Where it is made; null when it is made by hand. */
    station: CraftRef | null;
    stationLevel: number;
    /** How many one craft makes. */
    yield: number;
    /** False where the wiki leaves the yield in doubt: then it is not stated, and nothing is computed past it. */
    yieldKnown: boolean;
    inputs: CraftAmount[];
    /** What one craft burns besides its inputs: a smelter's coal. */
    fuel: CraftAmount | null;
  }[];
  /**
   * The part of the graph the item's breakdown reads (`closureOf`), compact
   * (`encodeGraph`), for the maths in the browser. Read with `decodeGraph`,
   * which refuses a layout it does not know, then `indexGraph`: the item's
   * steps are `recipes.get(item.id)` there, and its `totalCost` between any
   * two of its qualities, and `expandRaw` and `stationsNeeded` of anything
   * its steps consume, come out the same as on the whole graph.
   */
  closure: WireGraph;
  /**
   * What the item goes into, by station, the busiest first and by hand
   * (null) last: each product once, at the first step that needs the item,
   * with that step's quantity.
   */
  usedIn: { station: CraftRef | null; items: (CraftRef & { quality: number; qty: number })[] }[];
  /** For a station: its highest level, and the extensions that raise it one level each, with what each costs to build. */
  station?: { maxLevel: number; extensions: (CraftRef & { inputs: CraftAmount[] })[] };
};

/**
 * One item's slice of the graph, for its article. `anchor` asks for an item
 * described inside the page (the "mead-base" tab of a mead's page, a piece
 * of an armor set's page), as the graph's anchors name the page's tabs and
 * sections; without it, the item that is the page's own.
 *
 * Null when the graph has no such item, or no graph is served; and null as
 * well, said in the log, when the graph cannot be read. A page without its
 * card still shows the recipe as its infobox states it, which an error page
 * would not.
 *
 * React `cache()` over the cached graph, never a data cache entry of its
 * own: that entry would read the graph inside its own cached call, the
 * nesting this module never does, and a slice takes a few milliseconds to
 * work out (most of it parsing the graph's entry, about 3 ms).
 */
export const getCraftView = cache(async (slug: string, lang: Lang, anchor?: string): Promise<CraftView | null> => {
  try {
    const graph = await getRecipeGraphData();
    return graph ? craftView(graph, slug, lang, anchor) : null;
  } catch (error) {
    logError('recipes', error, { stage: 'view', slug, anchor });
    return null;
  }
});

function craftView(graph: RecipeGraph, slug: string, lang: Lang, anchor: string | undefined): CraftView | null {
  const item = graph.items.find((candidate) => candidate.slug === slug && candidate.anchor === anchor);
  if (!item) return null;

  const index = indexGraph(graph);
  const ref = refs(index, lang);
  const amount = ([id, qty]: [ItemId, number]): CraftAmount => ({ ...ref(id), qty });

  const view: CraftView = {
    item: { ...ref(item.id), kind: item.kind, maxQuality: item.maxQuality },
    // A stable sort: two recipes for one quality and rank keep the graph's order.
    recipes: [...(index.recipes.get(item.id) ?? [])]
      .sort((a, b) => a.quality - b.quality || (a.alt ?? 0) - (b.alt ?? 0))
      .map((recipe) => ({
        quality: recipe.quality,
        alt: recipe.alt ?? 0,
        station: recipe.station === null ? null : ref(recipe.station),
        stationLevel: recipe.stationLevel,
        yield: recipe.yield,
        yieldKnown: recipe.yieldKnown,
        inputs: recipe.inputs.map(amount),
        fuel: recipe.fuel ? amount(recipe.fuel) : null,
      })),
    closure: encodeGraph(closureOf(graph, index, item.id, lang)),
    usedIn: usesOf(index, item.id, ref, lang),
  };
  if (item.station) {
    view.station = {
      maxLevel: item.station.maxLevel,
      // What building each extension costs: its own first step.
      extensions: item.station.extensions.map((id) => ({ ...ref(id), inputs: (stepCost(index, id, 1)?.inputs ?? []).map(amount) })),
    };
  }
  return view;
}

/** Names items for one reader. */
function refs(index: GraphIndex, lang: Lang): (id: ItemId) => CraftRef {
  return (id) => {
    const item = index.items.get(id);
    // A graph the codec accepts names no item it lacks; were one missing, it
    // would still be shown, by its id, rather than dropped from a recipe.
    if (!item) return { id, name: id, en: id, slug: null, anchor: null, icon: null };
    return {
      id,
      name: lang === 'es' ? (item.es ?? item.en) : item.en,
      en: item.en,
      slug: item.slug ?? null,
      anchor: item.anchor ?? null,
      icon: item.icon ?? null,
    };
  };
}

/**
 * The part of the graph an item's breakdown reads: every step of the item
 * itself, alternatives included, and for each material those steps need,
 * the one recipe the maths makes it with (`stepCost` at quality 1, as
 * `expandRaw` does), down to the raw materials, with the items all of them
 * name. A material's alternatives and upgrades are left out: no breakdown
 * reads them. `usedIn` and `craftable` need the whole graph, and are never
 * asked of this.
 *
 * Its items keep what a breakdown and its tiles show: the name in the
 * reader's language (the English name, and for a Spanish reader the Spanish
 * one), the article, the picture. The rest stays with the whole graph,
 * because the slice is the props of a client island with a budget of a few
 * kilobytes: aliases are for search; how a raw material is had is the
 * planner's, and names its creatures and places in English only; a
 * station's levels and extensions are the station's own view, and kept here
 * they would name items the slice does not hold, which `encodeGraph` refuses.
 * Items and recipes keep the graph's order.
 */
function closureOf(graph: RecipeGraph, index: GraphIndex, product: ItemId, lang: Lang): RecipeGraph {
  const recipes = new Set<GraphRecipe>();
  const items = new Set<ItemId>([product]);
  const followed = new Set<ItemId>([product]);
  const take = (recipe: GraphRecipe): void => {
    recipes.add(recipe);
    if (recipe.station !== null) items.add(recipe.station);
    if (recipe.fuel) items.add(recipe.fuel[0]);
    for (const [input] of recipe.inputs) {
      items.add(input);
      // Once per material, which also ends a cycle: the breakdown reports it.
      if (followed.has(input)) continue;
      followed.add(input);
      const made = stepCost(index, input, 1);
      if (made) take(made);
    }
  };
  for (const recipe of index.recipes.get(product) ?? []) take(recipe);

  return {
    v: graph.v,
    version: graph.version,
    builtAt: graph.builtAt,
    items: graph.items.filter((item) => items.has(item.id)).map((item) => inLanguage(item, lang)),
    recipes: graph.recipes.filter((recipe) => recipes.has(recipe)),
  };
}

function inLanguage(item: GraphItem, lang: Lang): GraphItem {
  const { es, aliases: _aliases, obtain: _obtain, station: _station, extends: _extends, ...kept } = item;
  return lang === 'es' && es !== undefined ? { ...kept, es } : kept;
}

/**
 * Where a material goes, by station: the busiest station first, ties by
 * name; within a group, the products by name in the reader's language.
 *
 * What is made by hand comes last however much of it there is, after every
 * station, so that it closes the list in the same place on every page: a
 * station's group is where a reader standing at that station looks, and
 * by hand is no place. The article renders the groups in this order.
 */
function usesOf(index: GraphIndex, id: ItemId, ref: (id: ItemId) => CraftRef, lang: Lang): CraftView['usedIn'] {
  const groups = new Map<ItemId | null, Map<ItemId, { quality: number; qty: number }>>();
  for (const use of usedIn(index, id)) {
    let products = groups.get(use.station);
    if (!products) groups.set(use.station, (products = new Map()));
    // A sword that needs iron at every level is one use, from the first step that needs it.
    const first = products.get(use.product);
    if (!first || use.quality < first.quality) products.set(use.product, { quality: use.quality, qty: use.qty });
  }

  const byName = (a: string, b: string): number => a.localeCompare(b, lang);
  return [...groups]
    .map(([station, products]) => ({
      station: station === null ? null : ref(station),
      items: [...products].map(([product, use]) => ({ ...ref(product), ...use })).sort((a, b) => byName(a.name, b.name)),
    }))
    .sort(
      (a, b) =>
        Number(a.station === null) - Number(b.station === null) ||
        b.items.length - a.items.length ||
        byName(a.station?.name ?? '', b.station?.name ?? ''),
    );
}
