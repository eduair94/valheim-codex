import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { rawQuery, type Db } from '@/lib/db/create-db';
import { getLatestRecipeGraph } from '@/lib/db/recipe-repo';
import { getSearchIndex, type TitleIndexEntry } from '@/lib/db/wiki-repo';
import { spanishTitle } from '@/lib/i18n/article-names';
import type { Lang } from '@/lib/i18n/strings';
import { logError } from '@/lib/log';
import { CORPUS_TAG } from '@/lib/wiki/data';
import { slugify } from '@/lib/wiki/slug';
import { compactIcon } from '@/lib/wiki/title-search';
import { encodeGraph, type WireGraph } from './codec';
import { indexGraph, stepCost, type GraphIndex } from './math';
import type { GraphItem, GraphRecipe, ItemId, ItemKind, Obtain, RecipeGraph, RecipeMethod } from './types';

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
 * Names and pictures are what is not served as stored. The assembly names items
 * from the translations of the day it ran, and an article translated since
 * would not name its item until the next ingest. So every refill reads the
 * search index's names beside the graph, inside the same cached call: no
 * cached function here calls another, for the reason data.ts gives (Next
 * would run an inner one on every refill without ever reading its entry).
 * The same read names the creatures, places and traders the graph's raw
 * materials are had from, which are articles but no items of the graph.
 * One more, once the graph is in hand, reads the stored articles of the
 * pages it describes things inside (an armor set, a mead and its base), for
 * the pictures the title index cannot give those things (`borrowedPicture`).
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
 * Used by `/api/wiki/recipes?v=1` and by the chat; `getCraftView` reads the
 * same refill. The same for every reader and both languages: an item carries
 * its English name and its Spanish one, and each reader picks.
 *
 * A null is kept like any other answer. Before the first graph is written,
 * every article page would otherwise ask the database for one on every view,
 * and where the table is still missing say so in the log on every view; the
 * first graph is served within the hour instead, like any ingest's changes.
 * A failed read is not kept (`unstable_cache` keeps nothing that rejects), so
 * the next request asks again.
 */
export const getRecipeGraphData = cache(async (): Promise<RecipeGraph | null> => (await servedRecipeGraph())?.graph ?? null);

/**
 * The graph as one refill serves it: the graph, and what only an item's own
 * view reads: the articles of what its raw materials are had from
 * (`placesOf`), and the first tab of each page that shows one item per tab
 * (`firstTabsOf`).
 */
type ServedGraph = { graph: RecipeGraph; places: Places; tabs: FirstTabs };

/**
 * What the search index says of each creature, place and trader the graph
 * names as where a raw material comes from: its article, its Spanish name
 * and its picture, keyed by the name folded to lower case. Only names with
 * something to say are kept. A plain object, so the data cache stores it.
 */
type Places = Record<string, { slug: string | null; es: string | null; icon: string | null }>;

/** One read of the cached graph per request, for `getRecipeGraphData` and `getCraftView` alike. */
const servedRecipeGraph = cache((): Promise<ServedGraph | null> => storedRecipeGraph());

/** The newest graph and the article names, read side by side; named and checked here, once per refill. */
async function readRecipeGraph(): Promise<ServedGraph | null> {
  const db = await getDb();
  // Side by side: once a graph exists, as it does on almost every refill,
  // the names cost no round trip of their own; while none does, they are one
  // unused read an hour.
  const [stored, titles] = await Promise.all([getLatestRecipeGraph(db), getSearchIndex(db)]);
  if (!stored) return null;
  // Then what only the graph can say it needs: the pages its tabs and
  // sections are on, for the pictures of the things described inside them.
  // A failed read rejects like the two above, so that nothing is kept and the
  // next request asks again.
  const pages = await readHostPages(db, stored.graph);
  try {
    const graph = withNames(stored.graph, titles, pages);
    // The checks the planner's `decodeGraph` makes, made here once, so that a
    // graph the assembly got wrong (a recipe naming an item the graph lacks)
    // is no graph anywhere: neither a payload that fails in every browser
    // that downloads it, nor article cards drawn from it. The graphs stored
    // before it are still there: deleting its row serves the one before.
    encodeGraph(graph);
    return { graph, places: placesOf(graph, titles), tabs: firstTabsOf(pages) };
  } catch (error) {
    const version = (stored.graph as { version?: unknown } | null)?.version;
    logError('recipes', error, { stage: 'serve', version: typeof version === 'string' ? version : null });
    return null;
  }
}

// Next keys the entry by this function's source as well as by its key parts,
// so an entry stored by a build whose refill returned another shape (the
// graph alone, or without the first tabs) is never read as this one.
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
 * overrides' curated names: the names the search index has for its page are
 * the page's own item's, the mead's or the set's. Failing a name from the
 * assembly, the hand-written names and the vocabulary still apply
 * (`spanishTitle` with no translation), as they do for an item whose article
 * the index no longer has. Its picture is the best the stored articles have
 * of it (`borrowedPicture`).
 */
function withNames(graph: RecipeGraph, titles: readonly TitleIndexEntry[], pages: readonly HostPage[]): RecipeGraph {
  const articles = new Map(titles.map((entry) => [entry.s, entry]));
  const pictures = picturesFor(titles, pages);
  return { ...graph, items: graph.items.map((item) => named(item, articles, pictures)) };
}

function named(item: GraphItem, articles: ReadonlyMap<string, TitleIndexEntry>, pictures: Pictures): GraphItem {
  const { es: built, aliases: builtAliases, icon: builtIcon, ...rest } = item;
  const entry = item.slug !== undefined && item.anchor === undefined ? articles.get(item.slug) : undefined;
  const listed = entry ? null : spanishTitle(item.en, null);

  const es = entry?.e ?? built ?? listed?.name ?? undefined;
  const aliases = otherNames(
    [...(entry?.a ?? []), ...(builtAliases ?? []), ...(built !== undefined ? [built] : []), ...(listed?.aliases ?? [])],
    [item.en, es],
  );
  const icon = entry?.i ?? builtIcon ?? (item.anchor !== undefined ? borrowedPicture(item, pictures) : undefined);

  const out: GraphItem = rest;
  if (es !== undefined) out.es = es;
  if (aliases.length > 0) out.aliases = aliases;
  if (icon !== undefined) out.icon = icon;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Pictures of what is described inside another page                           */
/* -------------------------------------------------------------------------- */

/*
 * The assembly reads no pictures, and the title index pictures an article
 * by its stored infobox: the page's own item. An item described inside
 * another page (an armor piece on its set's page, a cooked meat on the raw
 * meat's, a mead's base, a piece on a list of pieces) has no picture of its
 * own anywhere the graph reaches, and "Usado en" drew a row of empty plates
 * where a reader looks for one. What the stored articles do hold is read
 * once per refill, for the pages those items are on: their infobox (on a page
 * that shows one infobox per tab, its first tab's) and their gallery.
 */

/** A page an item of the graph is described inside, or whose infobox names one, as its article is stored. */
type HostPage = {
  slug: string;
  title: string;
  /** The stored infobox's own title: "Leather helmet" on Leather Armor, the page's own name on a mead. */
  box: string | null;
  /** That infobox's picture, as the ingest stored it. */
  picture: string | null;
  /** On a page that shows one infobox per tab, the first tab's label ("Head", "Raw"); null on any other page. */
  firstTab: string | null;
  /** The page's gallery, as stored. */
  images: unknown;
};

/** Every page the graph describes an item inside, and every article whose infobox is titled like one of those items. */
async function readHostPages(db: Db, graph: RecipeGraph): Promise<HostPage[]> {
  const inside = Array.isArray(graph?.items) ? graph.items.filter((item) => item?.anchor !== undefined) : [];
  if (inside.length === 0) return [];
  const slugs = [...new Set(inside.flatMap((item) => (typeof item.slug === 'string' ? [item.slug] : [])))];
  const names = [...new Set(inside.map((item) => String(item.en).toLowerCase()))];
  // A list goes in as one JSON parameter, which both drivers read the same way.
  const rows = await rawQuery<{
    slug: string;
    title: string;
    box: string | null;
    picture: string | null;
    first_tab: string | null;
    images: unknown;
  }>(
    db,
    sql`SELECT slug, title,
               infobox->>'title' AS box,
               infobox->'image'->>'url' AS picture,
               infobox->'variants'->>0 AS first_tab,
               images
        FROM articles
        WHERE slug IN (SELECT jsonb_array_elements_text(${JSON.stringify(slugs)}::jsonb))
           OR lower(infobox->>'title') IN (SELECT jsonb_array_elements_text(${JSON.stringify(names)}::jsonb))`,
  );
  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    box: row.box,
    picture: row.picture,
    firstTab: row.first_tab,
    images: row.images,
  }));
}

/** A name as two spellings of it compare: letters and digits only, in lower case, without accents. */
function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The name a picture's file gives it, compared as a name: `Yuleklapp_%28small%29.png`
 * is "yuleklapp small". From a stored URL or the title index's short path
 * alike, both of which keep the CDN's two hashed folders before the file.
 */
function fileKey(url: string): string | null {
  const file = /(?:^|\/)[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/.exec(url)?.[1];
  if (!file) return null;
  let decoded = file;
  try {
    decoded = decodeURIComponent(file);
  } catch {
    // A stray percent sign: the name as written.
  }
  return nameKey(decoded.replace(/\.[a-z0-9]+$/i, ''));
}

/** The URLs of a stored gallery, whatever shape a row predating the parser's last change has. */
function galleryOf(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  return images.flatMap((image) => {
    const url = (image as { url?: unknown } | null)?.url;
    return typeof url === 'string' ? [url] : [];
  });
}

/** The lookups `borrowedPicture` reads, built once per refill. */
type Pictures = {
  /** Articles by their title's `nameKey`: an item's own article under its own name. */
  articles: ReadonlyMap<string, string>;
  /** Infobox pictures by the infobox title's `nameKey`: the item an infobox is about. */
  boxes: ReadonlyMap<string, string>;
  /** Every picture the articles hold where an item could look for it, by its file's name (`fileKey`). */
  files: ReadonlyMap<string, string>;
  pages: ReadonlyMap<string, HostPage>;
};

function picturesFor(titles: readonly TitleIndexEntry[], pages: readonly HostPage[]): Pictures {
  const articles = new Map<string, string>();
  const files = new Map<string, string>();
  const file = (icon: string): void => {
    const key = fileKey(icon);
    if (key && !files.has(key)) files.set(key, icon);
  };
  for (const entry of titles) {
    if (!entry.i) continue;
    const key = nameKey(entry.t);
    if (!articles.has(key)) articles.set(key, entry.i);
    file(entry.i);
  }
  const boxes = new Map<string, string>();
  for (const page of pages) {
    const picture = page.picture ? compactIcon(page.picture) : null;
    if (page.box && picture && !boxes.has(nameKey(page.box))) boxes.set(nameKey(page.box), picture);
    for (const url of galleryOf(page.images)) {
      const icon = compactIcon(url);
      if (icon) file(icon);
    }
  }
  return { articles, boxes, files, pages: new Map(pages.map((page) => [page.slug, page])) };
}

/**
 * The picture of an item described inside another page: the best the stored
 * articles hold of it, never another thing's. In order:
 *
 * 1. An article of its own under its name (the Mysterious Rock, described on
 *    the early axes' page too).
 * 2. An infobox titled like it: on a set's page the stored infobox is the
 *    first tab's, the helmet's, whatever its picture's file is called
 *    ("Troll_Leather_Helmet.png" for the Troll leather hood).
 * 3. A picture whose file is named after it, on its page or any article's
 *    (a fragment of Dyrnwyn in Dyrnwyn's gallery; the small Yuleklapp, which
 *    is the Yuleklapp article's picture): the wiki names a thing's picture
 *    after the thing.
 * 4. On a page that shows one item per tab, what the page is a picture of:
 *    the whole set (its gallery's picture named after the page, "A complete
 *    Leather armor set"), which a cape or a tunic is part of; or, where the
 *    stored infobox is the page's own item, that item's (the raw meat for
 *    the cooked, the mead for its base), a thing in another state. The set
 *    page's own picture, its helmet, goes to no other piece.
 *
 * A page that shows no tabs lends nothing: its picture is its own item's (a
 * Cauldron for the Smoker described in one of its sections).
 */
function borrowedPicture(item: GraphItem, pictures: Pictures): string | undefined {
  const name = nameKey(item.en);
  const own = pictures.articles.get(name) ?? pictures.boxes.get(name) ?? pictures.files.get(name);
  if (own) return own;

  const page = item.slug === undefined ? undefined : pictures.pages.get(item.slug);
  if (!page || page.firstTab === null) return undefined;
  const set = galleryOf(page.images).find((url) => fileKey(url) === nameKey(page.title));
  if (set) return compactIcon(set) ?? undefined;
  if (page.picture && page.box && nameKey(page.box) === nameKey(page.title)) return compactIcon(page.picture) ?? undefined;
  return undefined;
}

/**
 * The first tab of each page that shows one item per tab, as the graph
 * anchors it ("head" on an armor set), by the page's slug. A set's page has
 * no item of its own, and its stored infobox, levels and recipe rows are its
 * first tab's: that piece is the page's card.
 */
type FirstTabs = Record<string, string>;

function firstTabsOf(pages: readonly HostPage[]): FirstTabs {
  // Built as own properties, never assigned one by one: a slug called
  // `__proto__` stays a key like any other.
  return Object.fromEntries(pages.flatMap((page) => (page.firstTab ? [[page.slug, slugify(page.firstTab)]] : [])));
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

/**
 * The articles of everything the graph says its raw materials are had from:
 * the creatures that drop them, the places they are mined or gathered, the
 * traders that sell them (`Obtain`).
 *
 * The assembly writes them as the wiki titles their pages, in English, and
 * none is an item of the graph, so nothing else names them for a Spanish
 * reader or says where their articles are. Each is looked up as an article
 * title, letter case aside, and takes that article's Spanish name and
 * picture; one with no article (a stone grave) can still have a Spanish name
 * from the hand-written names and the vocabulary, as an item can.
 */
function placesOf(graph: RecipeGraph, titles: readonly TitleIndexEntry[]): Places {
  const articles = new Map<string, TitleIndexEntry>();
  for (const entry of titles) {
    const key = entry.t.toLowerCase();
    if (!articles.has(key)) articles.set(key, entry);
  }
  const places = new Map<string, Places[string]>();
  const seen = new Set<string>();
  for (const item of graph.items) {
    for (const way of item.obtain ?? []) {
      for (const name of way.how === 'buy' ? [way.from] : way.from) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = articles.get(key);
        const es = entry?.e ?? (entry ? null : spanishTitle(name, null).name);
        const place = { slug: entry?.s ?? null, es: es ?? null, icon: entry?.i ?? null };
        if (place.slug !== null || place.es !== null) places.set(key, place);
      }
    }
  }
  // Built as own properties, never assigned one by one: a place called
  // `__proto__` stays a key like any other.
  return Object.fromEntries(places);
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
 * One thing a material goes into: the product, and the step of it that
 * first takes the material, whole, so that a reader sees what else that
 * step needs and where it is made without opening the product's page.
 */
export type CraftUse = CraftRef & {
  /** The quality that step reaches: 1 is making the product new; above 1 the material goes into an upgrade. */
  quality: number;
  /** How much of the material one craft of that step takes. */
  qty: number;
  /** How the step is made: built near its station, crafted, smelted… */
  method: RecipeMethod;
  /**
   * Where it is made, and at which level; null where the wiki names no
   * station (by hand, or a piece the hammer builds). The group's station, so
   * that a use reads on its own.
   */
  station: CraftRef | null;
  stationLevel: number;
  /** How many one craft makes. */
  yield: number;
  /** False where the wiki leaves the yield in doubt: then it is not stated. */
  yieldKnown: boolean;
  /**
   * Whether the product's article opens on it (`opensOn`): its own article,
   * or a set's page whose first tab, and so whose infobox and levels, are
   * this piece's. Only then can a link open the article at the step's level
   * (`#level-2`): another piece of a set is described on a page whose levels
   * are the first piece's, and a cooked meat on a page whose levels, if it
   * had any, would be the raw meat's.
   */
  ownPage: boolean;
  /** Everything one craft of that step takes: the material first, then the rest as the wiki lists them. */
  inputs: CraftAmount[];
};

/**
 * A creature, place or trader a raw material is had from: the name to show
 * (the Spanish one for a Spanish reader where there is one), the wiki's
 * English name, and its article and picture where it has an article.
 */
export type CraftSource = { name: string; en: string; slug: string | null; icon: string | null };

/**
 * One way a raw material is had (`Obtain`), named for the reader. `tool` is
 * what the job needs (a pickaxe for silver), null where the wiki says
 * nothing or names a tool the graph has no item for: a game id is no name to
 * show a reader.
 */
export type CraftObtain =
  | { how: Exclude<Obtain['how'], 'buy'>; from: CraftSource[]; tool: CraftRef | null }
  | { how: 'buy'; from: CraftSource; coins: number };

/**
 * What an item's article shows about making it, already in the reader's
 * language: its steps, the slice of the graph its breakdown to raw materials
 * needs, what it goes into, how it is had when it is a raw material, and for
 * a station, its upgrades.
 *
 * The craft card's client island takes `item` and `closure`, and nothing
 * else. Every step the card can show is in the closure, alternatives
 * included, with the name, article and picture of everything those steps
 * name, and the totals and the breakdown are worked out from it in the
 * browser. The closure travels compact, as the planner's download does: on
 * the graph built from the live wiki (853 items, 1,147 recipes) the two come
 * to at most 2.2 KB of props for any of its 662 products, 1.0 KB for an
 * Iron Sword, where the same closure as objects passed 3 KB for 59 of them.
 * `recipes`, `usedIn`, `obtain` and `station` are the same facts resolved
 * for the server's own rendering, which sends the reader only what the page
 * shows of them. As props they would break the island's budget: `recipes`
 * repeats a whole reference for every input of every step, 7.6 KB for the
 * four steps of a fishing hat, and `usedIn` the whole step of every use.
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
    /** Where it is made; null where the wiki names no station. */
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
   * What the item goes into, by station, the busiest first and no station
   * (null) last: each product once, at the first step that needs the item,
   * with that step's quantity and the whole step.
   */
  usedIn: { station: CraftRef | null; items: CraftUse[] }[];
  /** How the item is had, where it is a raw material and the wiki says; empty for anything made. */
  obtain: CraftObtain[];
  /** For a station: its highest level, and the extensions that raise it one level each, with what each costs to build. */
  station?: { maxLevel: number; extensions: (CraftRef & { inputs: CraftAmount[] })[] };
};

/**
 * One item's slice of the graph, for its article. `anchor` asks for an item
 * described inside the page (the "mead-base" tab of a mead's page, a piece
 * of an armor set's page), as the graph's anchors name the page's tabs and
 * sections; without it, the item that is the page's own, or on a page that
 * has none, an armor set's, the piece of its first tab, which is the one its
 * stored infobox shows.
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
    const served = await servedRecipeGraph();
    return served ? craftView(served, slug, lang, anchor) : null;
  } catch (error) {
    logError('recipes', error, { stage: 'view', slug, anchor });
    return null;
  }
});

function craftView({ graph: served, places, tabs }: ServedGraph, slug: string, lang: Lang, anchor: string | undefined): CraftView | null {
  const described = (tab: string | undefined) => served.items.find((candidate) => candidate.slug === slug && candidate.anchor === tab);
  // A set's page has no item of its own, and everything its infobox stores
  // (the levels, the stats, the recipe rows) is its first tab's piece's: the
  // card is that piece's, or it would replace one item's rows with nothing.
  const item = described(anchor) ?? (anchor === undefined && Object.hasOwn(tabs, slug) ? described(tabs[slug]) : undefined);
  if (!item) return null;

  // On an item's own page nothing else wears its picture. A thing that
  // borrows it (a mead's base, a cooked meat) is another thing in another
  // state, and drawn beside the page's own name it reads as the item itself:
  // "to make this mead you need this mead". It shows the empty plate there.
  const graph =
    item.icon === undefined
      ? served
      : { ...served, items: served.items.map((other) => (other.id !== item.id && other.icon === item.icon ? withoutIcon(other) : other)) };

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
    usedIn: usesOf(index, item.id, ref, lang, opensOn(graph.items, tabs)),
    obtain: (item.obtain ?? []).map((way) => obtained(way, index, ref, places, lang)),
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

/**
 * Whether an item's article opens on it, as `craftView` picks what a page
 * is about: the item whose own article it is, or on a set's page, which has
 * no item of its own, the piece of its first tab. A page with an item of its
 * own opens on that item whatever its tabs (the raw meat, not the cooked).
 *
 * Which pages have an item of their own is only asked for a piece that is
 * its page's first tab, which few uses are, and then once per view.
 */
function opensOn(items: readonly GraphItem[], tabs: FirstTabs): (item: GraphItem) => boolean {
  let owned: Set<string> | null = null;
  return (item) => {
    if (item.slug === undefined) return false;
    if (item.anchor === undefined) return true;
    if (!Object.hasOwn(tabs, item.slug) || tabs[item.slug] !== item.anchor) return false;
    owned ??= new Set(items.flatMap((other) => (other.anchor === undefined && other.slug !== undefined ? [other.slug] : [])));
    return !owned.has(item.slug);
  };
}

function withoutIcon(item: GraphItem): GraphItem {
  const { icon: _icon, ...rest } = item;
  return rest;
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
 * name. Within a group, the station's own menu first, what is crafted at
 * it, by the station level its step needs; then the pieces built near it,
 * which the game lists in the hammer's menu instead; each by name in the
 * reader's language. A group reads in the order a player gets to make its
 * things, and its first cards, which are all a busy group shows, are what a
 * player who has just found the material can make at that station, not a
 * decoration built beside it.
 *
 * What no station makes comes last however much of it there is, after every
 * station, so that it closes the list in the same place on every page: a
 * station's group is where a reader standing at that station looks, and
 * no station is no place. The article renders the groups in this order.
 *
 * Each use is the step of the product that first takes the material, read
 * from the index's own list of what the material goes into (alternatives
 * and upgrades included, as `usedIn` reads it), and carries that step
 * whole: the reader wants to know what else it takes, not only how much of
 * this. It says too whether the product's article opens on the product
 * (`opens`), where a link to an upgrade can name its level.
 */
function usesOf(
  index: GraphIndex,
  id: ItemId,
  ref: (id: ItemId) => CraftRef,
  lang: Lang,
  opens: (item: GraphItem) => boolean,
): CraftView['usedIn'] {
  const groups = new Map<ItemId | null, Map<ItemId, GraphRecipe>>();
  for (const recipe of index.uses.get(id) ?? []) {
    let products = groups.get(recipe.station);
    if (!products) groups.set(recipe.station, (products = new Map()));
    // A sword that needs iron at every level is one use, from the first step that needs it.
    const first = products.get(recipe.product);
    if (!first || recipe.quality < first.quality) products.set(recipe.product, recipe);
  }

  const use = (recipe: GraphRecipe): CraftUse => {
    // As `usedIn` counts it: a material the wiki lists twice in one recipe takes both.
    const qty = recipe.inputs.reduce((sum, [material, n]) => (material === id ? sum + n : sum), 0);
    const product = index.items.get(recipe.product);
    return {
      ...ref(recipe.product),
      quality: recipe.quality,
      qty,
      method: recipe.method,
      station: recipe.station === null ? null : ref(recipe.station),
      stationLevel: recipe.stationLevel,
      yield: recipe.yield,
      yieldKnown: recipe.yieldKnown,
      ownPage: product !== undefined && opens(product),
      // The page's own material leads, once, so the eye finds it in the same
      // place on every use; the rest keep the wiki's order.
      inputs: [
        { ...ref(id), qty },
        ...recipe.inputs.filter(([material]) => material !== id).map(([material, n]) => ({ ...ref(material), qty: n })),
      ],
    };
  };

  const byName = (a: string, b: string): number => a.localeCompare(b, lang);
  return [...groups]
    .map(([station, products]) => ({
      station: station === null ? null : ref(station),
      items: [...products.values()]
        .map(use)
        .sort(
          (a, b) =>
            Number(a.method === 'build') - Number(b.method === 'build') || a.stationLevel - b.stationLevel || byName(a.name, b.name),
        ),
    }))
    .sort(
      (a, b) =>
        Number(a.station === null) - Number(b.station === null) ||
        b.items.length - a.items.length ||
        byName(a.station?.name ?? '', b.station?.name ?? ''),
    );
}

/**
 * One way a raw material is had, named for one reader: each source by its
 * article where it has one (`placesOf`), the tool by its item.
 *
 * A tool the graph has no item for is left unnamed: its id (`PickaxeAntler`)
 * is the game's, no reader's, and the way is still worth stating without it.
 */
function obtained(way: Obtain, index: GraphIndex, ref: (id: ItemId) => CraftRef, places: Places, lang: Lang): CraftObtain {
  const source = (en: string): CraftSource => {
    const key = en.toLowerCase();
    const place = Object.hasOwn(places, key) ? places[key] : undefined;
    return {
      name: lang === 'es' ? (place?.es ?? en) : en,
      en,
      slug: place?.slug ?? null,
      icon: place?.icon ?? null,
    };
  };
  if (way.how === 'buy') return { how: 'buy', from: source(way.from), coins: way.coins };
  const tool = way.how !== 'drop' && way.tool !== undefined && index.items.has(way.tool) ? ref(way.tool) : null;
  return { how: way.how, from: way.from.map(source), tool };
}
