import { createHash } from 'node:crypto';
import { splitStationLevel } from '@/lib/wiki/browse-groups';
import { ingredientKey } from '@/lib/wiki/recipe';
import type { PageRecipes, RawEntry, RawInfobox, RawLink, RawListRow, RawUpgradeTable } from '@/lib/wiki/recipes';
import { slugify } from '@/lib/wiki/slug';
import { OVERRIDES, type RecipeOverrides } from './recipe-overrides';
import type { GraphItem, GraphRecipe, GraphReport, ItemId, ItemKind, Obtain, RecipeGraph, RecipeMethod } from './types';

/**
 * Builds the recipe graph from the recipes the extractor read off every page
 * (recipes.ts), once per ingest run.
 *
 * The extractor keeps what each page says, as the page says it: a material
 * is a link title ("Mead base: Poison resistance", "Leather scraps"), a
 * station is a line of Source, a cooked meat is the second infobox of its raw
 * meat's page. Only with every page at hand, and the wiki's redirects, can
 * those become one thing each:
 *
 *   1. Resolve. Every material, station and extension is followed by its
 *      link to a page, through a redirect where the link names one, and to
 *      the infobox or table row the redirect's section names: "Mead base:
 *      Poison resistance" is the "Mead base" tab of Poison Resistance Mead,
 *      "Deer trophy" a section of the Trophies page. A material with no link
 *      is looked up by its name. What resolves nowhere is still a material,
 *      named as the wiki names it, and reported: a recipe missing one of its
 *      materials is a shopping list that comes up short.
 *   2. Correct, from the overrides module (recipe-overrides.ts): a material
 *      linked to the wrong page, an internal ID copied from a neighbour, a
 *      step's cost, the fuel a smelter burns, the charcoal kiln. Each
 *      correction is counted in the report with its reason.
 *   3. Deduplicate and validate. A step stated twice (on two pages, or in an
 *      item's infobox and its table of upgrades) keeps the item's own
 *      infobox's; where the statements cost it differently, the game's rule
 *      for upgrades settles which is right when it can, and otherwise the
 *      report lists them for a person to settle. A level past a station's
 *      stated maximum, a yield another page contradicts, a cycle: each is
 *      reported and none is settled here. An upgrade off the game's rule
 *      that nothing else states otherwise is reported too, and left out of
 *      the graph, so that no total counts it.
 *   4. Identify every thing by the game's internal ID, else by where it is
 *      described (`page:<slug>`, `page:<slug>#<anchor>`), so saved lists and
 *      share links outlive renamed pages.
 *
 * Pure apart from hashing: the same pages, redirects and overrides give the
 * same graph and the same version, whatever order the pages arrive in.
 */

/** A page as the ingest stored it: its slug, title and categories, and what the extractor read from it. */
export type AssemblyPage = { slug: string; title: string; categories: string[]; recipes: PageRecipes };

/**
 * Where the wiki's redirects lead, by the title a link names: "Bronze nails"
 * to Bronze Nails, "Cooked deer meat" to the "Cooked" tab of Deer Meat. The
 * client's `fetchRedirects` answers in this shape; a title is looked up as
 * written and as MediaWiki spells it, its first letter capital.
 */
export type Redirects = ReadonlyMap<string, { title: string; fragment: string | null }>;

/**
 * The report, with five lists the graph's type has no place for yet:
 *
 * - `notes`: what the wiki states that the graph could not use, and why: a
 *   cell the extractor could not read, a table row naming no extension its
 *   station lists, a station whose levels and extensions disagree, an
 *   override that found nothing to change;
 * - `idConflicts`: an internal ID the wiki gives two different things. The
 *   first keeps it; the other falls back to where it is described (`as`),
 *   until an override gives it its own;
 * - `unavailable`: steps needing a station level the game does not have yet
 *   (`notYetAvailable` in the overrides). Like a level conflict, the step
 *   keeps the level the wiki states, past the station's highest; unlike one,
 *   nothing is left to settle;
 * - `costConflicts`: a step two statements cost differently, or ask a
 *   different station level for, and the game's rule cannot settle: what
 *   each says, the kept one first (its level null where it states none).
 *   The item's own infobox is kept, as for any step stated twice, until an
 *   override settles which is right;
 * - `overruled`: a statement of a step off the game's rule for upgrades,
 *   beside one on it, which the graph keeps (see `settleStep`): what each
 *   says. Nothing is left to settle but the wiki, which states it twice;
 * - `costSuspects`: an upgrade step off the game's rule (see
 *   `checkUpgradeCosts`), with what the wiki states and what the rule gives.
 *   The step is left out of the graph until an override settles it.
 */
export type AssemblyReport = GraphReport & {
  applied: NonNullable<GraphReport['applied']>;
  notes: { text: string; from: string }[];
  idConflicts: { id: ItemId; kept: string; moved: string; as: ItemId }[];
  unavailable: GraphReport['levelConflicts'];
  costConflicts: {
    product: ItemId;
    quality: number;
    statements: { from: string; inputs: [ItemId, number][]; stationLevel: number | null }[];
  }[];
  overruled: {
    product: ItemId;
    quality: number;
    from: string;
    stated: [ItemId, number][];
    kept: { from: string; inputs: [ItemId, number][] };
  }[];
  costSuspects: { product: ItemId; quality: number; from: string; stated: [ItemId, number][]; linear: [ItemId, number][] }[];
};

/**
 * Assembles the graph and its report from every page's recipes.
 *
 * `builtAt` is stamped on the graph and is not part of its version: two
 * builds from the same wiki are the same graph. `overrides` is for tests;
 * the ingest uses the module's.
 */
export function assembleGraph(
  pages: AssemblyPage[],
  redirects: Redirects,
  builtAt: string,
  overrides: RecipeOverrides = OVERRIDES,
): { graph: RecipeGraph; report: AssemblyReport } {
  const ctx = prepare(pages, redirects, overrides);
  const drafts = readRecipes(ctx);
  assignIds(ctx);
  const recipes = settleRecipes(ctx, drafts);
  const items = buildItems(ctx, recipes);

  items.sort((a, b) => compare(a.id, b.id));
  recipes.sort((a, b) => compare(a.product, b.product) || a.quality - b.quality || (a.alt ?? 0) - (b.alt ?? 0));
  const graph: RecipeGraph = { v: 1, version: versionOf(items, recipes), builtAt, items, recipes };
  return { graph, report: reportOf(ctx, graph) };
}

/**
 * Every title the assembly may look up among the redirects: what materials,
 * stations, extensions, food rows and table rows link to or are named, the
 * creature each trophy is named after, and the extensions the overrides
 * add, less the titles that are a page's own. The ingest asks the wiki about
 * these (`fetchRedirects`), about ten requests for the whole wiki, instead of
 * listing all of its redirects.
 */
export function redirectTitles(pages: AssemblyPage[], overrides: RecipeOverrides = OVERRIDES): string[] {
  const titles = new Set<string>();
  const add = (title: string | null | undefined) => {
    if (title) titles.add(title);
  };
  const addLink = (link: RawLink | null) => add(link?.title);
  for (const key of Object.keys(overrides.extensions)) add(key.slice(key.indexOf('#') + 1));
  for (const page of pages) {
    for (const box of page.recipes.infoboxes) {
      for (const level of box.levels) for (const entry of level.entries) addEntry(entry, add, overrides);
      box.source?.links.forEach(addLink);
      box.improvements.forEach(addLink);
      addLink(box.upgrades);
    }
    for (const row of page.recipes.listRows) {
      add(row.name);
      for (const entry of row.entries) addEntry(entry, add, overrides);
    }
    for (const food of page.recipes.foodRows) {
      addLink(food.item);
      add(food.station);
    }
    const table = page.recipes.upgradeTable;
    if (table) {
      for (const level of table.levels) for (const entry of level.entries) addEntry(entry, add, overrides);
      add(table.station);
    }
  }
  for (const page of pages) titles.delete(page.title);
  return [...titles].sort(compare);
}

/** A trophy's name, and in it the creature it is named after: "Deer trophy", the Deer. */
const TROPHY = /^(.+?)\s+trophy$/i;

/**
 * A material's titles as the assembly looks them up: its link, corrected
 * where an override says, and its text; for a trophy, also the creature it
 * is named after, whose page says who drops it (`trophyDrop`).
 */
function addEntry(entry: RawEntry, add: (title: string | undefined) => void, overrides: RecipeOverrides): void {
  const title = entry.link?.title ?? entry.text;
  for (const name of [fixFor(overrides, title)?.to ?? title, ...(entry.link ? [entry.text] : [])]) {
    add(name);
    add(TROPHY.exec(name)?.[1]);
  }
}

/* -------------------------------------------------------------------------- */
/* Pages and places                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A thing some page describes, before it has an id: a page's own infobox, a
 * secondary infobox (a tab), a row of a table, or a thing only named (a
 * trophy, a material no page describes). Several places can be one item:
 * the Troll hide cape is described on its own page and in the Troll Set.
 */
type Place = {
  /**
   * Where it is described: "Iron Sword", "Bronze Armor#Chest",
   * "Wood Structures#Wood floor 1x1", "Trophies#Deer trophy", or just the
   * name of a thing no page describes. The overrides name places this way.
   */
  key: string;
  page: Page | null;
  shape: 'own' | 'tab' | 'row' | 'virtual';
  en: string;
  /** Slugified tab or row name: where on its page it is described. */
  anchor: string | null;
  box: RawInfobox | null;
  row: RawListRow | null;
  /** The internal ID it claims, from an override or its infobox, before conflicts are settled. */
  claimed: ItemId | null;
  id: ItemId;
};

type Page = {
  slug: string;
  title: string;
  /** Lower case, for comparing. */
  categories: Set<string>;
  recipes: PageRecipes;
  own: Place | null;
  tabs: Place[];
  rows: Place[];
  /** Whether its rows are its station's table of extensions, rather than building pieces. */
  stationTable: boolean;
};

/** Everything the assembly works from and writes to, built once per call. */
type Ctx = {
  overrides: RecipeOverrides;
  redirects: Redirects;
  pages: Page[];
  byTitle: Map<string, Page>;
  byName: Map<string, Page>;
  /** Every place, in the order ids are claimed: pages' own infoboxes first, then tabs, rows and named things. */
  places: Place[];
  virtuals: Map<string, Place>;
  /** Secondary infoboxes by their title, for a material no page or redirect names. */
  tabsByTitle: Map<string, Place[]>;
  /** The name a redirect gives the infobox it points at, by "Page#tab". */
  redirectNames: Map<string, string>;
  applied: Map<string, { override: string; reason: string; count: number }>;
  unresolved: Map<string, { text: string; from: string; count: number }>;
  notes: { text: string; from: string }[];
  idConflicts: AssemblyReport['idConflicts'];
  duplicates: GraphReport['duplicates'];
  yieldSuspects: GraphReport['yieldSuspects'];
  costConflicts: AssemblyReport['costConflicts'];
  overruled: AssemblyReport['overruled'];
  costSuspects: AssemblyReport['costSuspects'];
  /** The extensions each station's Improvements list, and the overrides add, once looked up. */
  extensions: Map<Place, Place[]>;
  /** The override that made a place a station's extension, by its key. */
  addedExtensions: Map<Place, string>;
  /**
   * The highest quality each infobox states, an unreadable tab's and an
   * upgrade held back included: its notes keep the tab's number ("Quality 4:
   * …"), and a level nobody could read, or price, is still a level the item
   * has.
   */
  statedQuality: Map<Place, number>;
  /** The place each id names, once ids are given: the first to be given it, where the item is described best. */
  home: Map<ItemId, Place>;
  /** The stations something is made at, once the recipes are settled. */
  stations: Set<ItemId>;
};

/** A name as names are compared: case, spacing and the shape of an apostrophe mean nothing. */
function nameKey(text: string): string {
  return ingredientKey(text.replace(/[’‘`]/g, "'"));
}

/** A title as MediaWiki stores it: spaces for underscores, the first letter a capital. */
function wikiTitle(title: string): string {
  const text = title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Code point order: the same everywhere, unlike a locale's. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function prepare(input: AssemblyPage[], redirects: Redirects, overrides: RecipeOverrides): Ctx {
  const ctx: Ctx = {
    overrides,
    redirects,
    pages: [],
    byTitle: new Map(),
    byName: new Map(),
    places: [],
    virtuals: new Map(),
    tabsByTitle: new Map(),
    redirectNames: new Map(),
    applied: new Map(),
    unresolved: new Map(),
    notes: [],
    idConflicts: [],
    duplicates: [],
    yieldSuspects: [],
    costConflicts: [],
    overruled: [],
    costSuspects: [],
    extensions: new Map(),
    addedExtensions: new Map(),
    statedQuality: new Map(),
    home: new Map(),
    stations: new Set(),
  };

  // Sorted, so that which of two places claims an ID first, and every list
  // the report holds, never depends on the order the database returned.
  const sorted = [...input].sort((a, b) => compare(a.title, b.title));
  for (const source of sorted) {
    const ignored = overrides.ignore[source.title];
    if (ignored) {
      // Counted only where it leaves a recipe out: a page that states none
      // makes nothing, and is out of the graph either way.
      if (statesRecipes(source.recipes)) apply(ctx, `ignore: ${source.title}`, ignored.reason);
      continue;
    }
    const page: Page = {
      slug: source.slug,
      title: source.title,
      categories: new Set(source.categories.map((c) => c.toLowerCase())),
      recipes: source.recipes,
      own: null,
      tabs: [],
      rows: [],
      stationTable: false,
    };
    ctx.pages.push(page);
    ctx.byTitle.set(page.title, page);
    if (!ctx.byName.has(nameKey(page.title))) ctx.byName.set(nameKey(page.title), page);
  }
  for (const title of Object.keys(overrides.ignore)) {
    if (!ctx.applied.has(`ignore: ${title}`)) staleOverride(ctx, `ignore: ${title}`);
  }

  for (const page of ctx.pages) {
    for (const box of page.recipes.infoboxes) {
      const place = newPlace(ctx, {
        key: box.tab === null ? page.title : `${page.title}#${box.tab}`,
        page,
        shape: box.tab === null ? 'own' : 'tab',
        en: box.tab === null ? page.title : box.title,
        anchor: box.tab === null ? null : slugify(box.tab),
        box,
        row: null,
        claimed: box.internalId,
      });
      if (box.tab === null) {
        page.own = place;
      } else {
        page.tabs.push(place);
        const titled = ctx.tabsByTitle.get(nameKey(box.title));
        if (titled) titled.push(place);
        else ctx.tabsByTitle.set(nameKey(box.title), [place]);
      }
    }
    page.stationTable = page.own !== null && page.recipes.listRows.length > 0;
    for (const row of page.recipes.listRows) {
      // A name can repeat in one table, or in two of a page's tables: the
      // same piece, stated again.
      if (page.rows.some((p) => nameKey(p.en) === nameKey(row.name))) continue;
      page.rows.push(
        newPlace(ctx, {
          key: `${page.title}#${row.name}`,
          page,
          shape: 'row',
          en: row.name,
          anchor: slugify(row.name),
          box: null,
          row,
          claimed: null,
        }),
      );
    }
  }

  // The name a redirect gives the tab it points at. A secondary infobox
  // titled like its page (the Anti-Sting Concoction's mead base) is named
  // nowhere else: "Mead base: Anti-sting" is the redirect's. Where several
  // redirects lead there ("Mead Base: Anti-Sting" too), the one the recipes
  // link by comes first, then the wiki's own spelling of a title.
  const linked = new Set<string>();
  for (const page of ctx.pages) {
    const { infoboxes, listRows, foodRows, upgradeTable } = page.recipes;
    const entries = [
      ...infoboxes.flatMap((box) => box.levels.flatMap((l) => l.entries)),
      ...listRows.flatMap((r) => r.entries),
      ...(upgradeTable?.levels.flatMap((l) => l.entries) ?? []),
    ];
    for (const entry of entries) if (entry.link) linked.add(entry.link.title);
    for (const food of foodRows) linked.add(food.item.title);
  }
  const preferred = (a: string, b: string) =>
    Number(!linked.has(a)) - Number(!linked.has(b)) ||
    Number(a !== wikiTitle(a)) - Number(b !== wikiTitle(b)) ||
    compare(a, b);
  for (const name of [...redirects.keys()].sort(preferred)) {
    const target = redirects.get(name)!;
    if (target.fragment === null) continue;
    const key = `${nameKey(target.title)}#${nameKey(target.fragment)}`;
    if (!ctx.redirectNames.has(key)) ctx.redirectNames.set(key, name);
  }
  for (const page of ctx.pages) {
    for (const tab of page.tabs) {
      const box = tab.box!;
      if (nameKey(box.title) !== nameKey(page.title)) continue;
      tab.en = ctx.redirectNames.get(`${nameKey(page.title)}#${nameKey(box.tab!)}`) ?? `${box.title} (${box.tab})`;
    }
  }

  // Overrides name places by key; an ID they give takes the infobox's place.
  for (const place of ctx.places) {
    const fix = overrides.internalIds[place.key];
    if (fix) place.claimed = fix.id;
  }
  return ctx;
}

function newPlace(ctx: Ctx, place: Omit<Place, 'id'>): Place {
  const made: Place = { ...place, id: '' };
  ctx.places.push(made);
  return made;
}

/** Whether a page states anything the assembly makes a recipe of: a quality tab, a table row, a food, a table of upgrades. */
function statesRecipes(recipes: PageRecipes): boolean {
  return (
    recipes.infoboxes.some((box) => box.levels.length > 0) ||
    recipes.listRows.length > 0 ||
    recipes.foodRows.length > 0 ||
    (recipes.upgradeTable?.levels.length ?? 0) > 0
  );
}

/**
 * A thing only named, as a place: on a page (a trophy in a section of the
 * Trophies page), or on no page at all (a material the wiki has no page
 * for). One per name and page. A name that is the page's own title is the
 * page itself, a page that describes no one thing, unless `within` says it
 * is a thing on the page of the same name: the rock the Mysterious Rock is
 * made from.
 */
function virtual(ctx: Ctx, page: Page | null, name: string, within = false): Place {
  const itself = page !== null && !within && nameKey(name) === nameKey(page.title);
  const key = page === null ? name : itself ? page.title : `${page.title}#${name}`;
  const lookup = `${page?.title ?? ''}\u0000${nameKey(itself ? '' : name)}`;
  const existing = ctx.virtuals.get(lookup);
  if (existing) return existing;
  const place = newPlace(ctx, {
    key,
    page,
    shape: 'virtual',
    en: itself ? page.title : name,
    anchor: page === null || itself ? null : slugify(name),
    box: null,
    row: null,
    claimed: ctx.overrides.internalIds[key]?.id ?? null,
  });
  ctx.virtuals.set(lookup, place);
  return place;
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The page a title names: the page of that title, else the one a redirect
 * leads to (with the section it names), else a page whose title differs only
 * in case ("Leather scraps" for Leather Scraps). Null for a page the wiki
 * does not have, or one the graph leaves out.
 */
function findPage(ctx: Ctx, title: string): { page: Page; fragment: string | null } | null {
  const exact = ctx.byTitle.get(title) ?? ctx.byTitle.get(wikiTitle(title));
  if (exact) return { page: exact, fragment: null };
  const target = ctx.redirects.get(title) ?? ctx.redirects.get(wikiTitle(title));
  if (target) {
    const page = ctx.byTitle.get(target.title) ?? ctx.byName.get(nameKey(target.title));
    if (page) return { page, fragment: target.fragment };
  }
  const folded = ctx.byName.get(nameKey(title));
  return folded ? { page: folded, fragment: null } : null;
}

/**
 * What on a page a reference means: the infobox its section names (by tab,
 * or by the bracket in an infobox's title: "Item Stand#Vertical" is "Item
 * stand (vertical)"), else the table row named like the reference, else the
 * secondary infobox titled like it ("Unbaked sweetbread" redirects to the
 * Frosted Sweetbread page as a whole), else the page's own infobox. A name
 * that is the page's own title means the page's own thing, even where a
 * secondary infobox repeats the title.
 *
 * Null on a page that describes no one thing, and for a section that names
 * nothing on the page under a name that is not the page's: the caller
 * decides what such a reference is. "Dyrnwyn tip fragment" redirects to the
 * "Dyrnwyn fragments" section of the Dyrnwyn's page, which describes the
 * fragments in prose; taken for the page's own infobox, a recipe needing one
 * fragment would need a whole sword.
 */
function locate(page: Page, fragment: string | null, name: string): Place | null {
  const key = nameKey(name);
  if (fragment) {
    const section = nameKey(fragment);
    const tab =
      page.tabs.find((p) => nameKey(p.box!.tab!) === section) ??
      [page.own, ...page.tabs].find((p) => p !== null && namesFragment(p.box!.title, section));
    if (tab) return tab;
  }
  const row = page.rows.find((p) => nameKey(p.en) === key);
  if (row) return row;
  if (key !== nameKey(page.title)) {
    const titled = page.tabs.find((p) => nameKey(p.box!.title) === key);
    if (titled) return titled;
    if (fragment) return null;
  }
  return page.own;
}

/** Whether an infobox's title is a section's name, whole or in its bracket. */
function namesFragment(title: string, fragment: string): boolean {
  const bracket = /\(([^()]+)\)\s*$/.exec(title)?.[1];
  return nameKey(title) === fragment || (bracket !== undefined && nameKey(bracket) === fragment);
}

/** The override that corrects a material's link, if one does. */
function fixFor(overrides: RecipeOverrides, title: string): (RecipeOverrides['linkFixes'][string] & { from: string }) | null {
  for (const [from, fix] of Object.entries(overrides.linkFixes)) {
    if (nameKey(from) === nameKey(title)) return { ...fix, from };
  }
  return null;
}

/**
 * The thing a recipe's material is.
 *
 * By its link's title first, corrected where an override says, then by its
 * text; an entry whose link leads to no page here may still be named like
 * one. A link straight to a page that describes no one thing (a
 * disambiguation page, an armor set) is reported, as is a name nothing
 * resolves; both stay materials, named as the wiki names them.
 *
 * A material named like the very thing being made, that resolves to it, is
 * another thing of the same name: the Mysterious Rock is made from a rock
 * found in the world, linked to its own page. It becomes a thing of its own
 * on that page, reported until an override gives it its ID, and never a
 * recipe that consumes its own product. A material that reaches its product
 * under another name is taken at its word: the recipe needs itself, and the
 * report lists the cycle for a person to settle.
 */
function resolveEntry(ctx: Ctx, entry: RawEntry, product: Place, from: string): Place {
  const linked = entry.link?.title ?? null;
  const fix = fixFor(ctx.overrides, linked ?? entry.text);
  if (fix) apply(ctx, `linkFixes: ${fix.from}`, fix.reason);
  const title = fix?.to ?? linked ?? entry.text;
  const titles = [title, ...(nameKey(entry.text) !== nameKey(title) ? [entry.text] : [])];

  for (const [i, name] of titles.entries()) {
    const found = findPage(ctx, name);
    if (!found) continue;
    // The link's own section counts first; the redirect's when it names none.
    const fragment = (i === 0 && !fix ? entry.link?.fragment : null) ?? found.fragment;
    const place = locate(found.page, fragment, name) ?? virtual(ctx, found.page, name);
    if (sameThing(place, product) && namedLike(product, [entry.text, name])) {
      const other = virtual(ctx, product.page, entry.text, true);
      if (other.claimed === null) unresolve(ctx, entry.text, from);
      return other;
    }
    if (place.shape === 'virtual' && place.key === found.page.title) unresolve(ctx, name, from);
    return place;
  }
  // No page by that name: one secondary infobox of that title, anywhere,
  // is what it names (a redirect the wiki has but the ingest did not ask about).
  for (const name of titles) {
    const tabs = ctx.tabsByTitle.get(nameKey(name));
    if (tabs?.length === 1 && !sameThing(tabs[0]!, product)) return tabs[0]!;
  }
  unresolve(ctx, title, from);
  return virtual(ctx, null, title);
}

/** Whether two places are one thing: the same place, or one ID claimed under one name. */
function sameThing(a: Place, b: Place): boolean {
  return a === b || (a.claimed !== null && a.claimed === b.claimed && sharesName(a, b));
}

/** Whether two places go by a name in common: their names, or their infoboxes' titles. */
function sharesName(a: Place, b: Place): boolean {
  return namesOf(a).some((n) => namesOf(b).includes(n));
}

/** Whether a place goes by one of these names. */
function namedLike(place: Place, names: string[]): boolean {
  return names.some((name) => namesOf(place).includes(nameKey(name)));
}

/** What a place goes by, as names are compared: its name and its infobox's title. */
function namesOf(place: Place): string[] {
  return [place.en, place.box?.title].filter((n): n is string => !!n).map(nameKey);
}

/**
 * Whether a place is a crafting station: a page's own infobox with levels, a
 * known station's internal ID, or a page among the wiki's crafting
 * structures, and never an extension. Being one makes it a station only
 * where a recipe is made at it: Beehives and Sap extractors are crafting
 * structures too, and nothing is made at them.
 */
function couldBeStation(place: Place): boolean {
  if (place.shape !== 'own' || !place.box || place.box.upgrades) return false;
  if (place.box.maxLevel !== null) return true;
  if (place.claimed !== null && Object.hasOwn(METHOD_AT, place.claimed)) return true;
  return place.page!.categories.has('crafting structures') && !place.page!.categories.has('crafting station upgrades');
}

/**
 * The station a recipe is made at: the first link of its Source that is one
 * ("Forge; Smelter" is the Forge's, "Cauldron, Workbench" the Cauldron's).
 * None for "Player crafting menu", "Hammer" or a Source with no station.
 * The level is Source's, where Source states one ("Cauldron (level 3)").
 */
function stationOf(ctx: Ctx, box: RawInfobox): { place: Place; level: number | null } | null {
  for (const link of box.source?.links ?? []) {
    const found = findPage(ctx, link.title);
    if (!found) continue;
    const place = locate(found.page, link.fragment ?? found.fragment, link.title);
    if (place && couldBeStation(place)) return { place, level: levelIn(box.source!.text, link) };
  }
  return null;
}

/**
 * The station an extension's own page says it raises ("Upgrades Forge"),
 * where that is a station. An extension the station's Improvements predate
 * (1.0's Smith's Aprons) is found by this alone.
 */
function upgradedStation(ctx: Ctx, place: Place): Place | null {
  const upgrades = place.box?.upgrades;
  if (!upgrades) return null;
  const found = findPage(ctx, upgrades.title);
  const station = found ? locate(found.page, upgrades.fragment ?? found.fragment, upgrades.title) : null;
  return station && couldBeStation(station) ? station : null;
}

/** The level Source states beside a station: "Cauldron (level 3)", "Artisan table level 2". */
function levelIn(text: string, link: RawLink): number | null {
  for (const part of text.split(/[\n,;]/)) {
    const { base, level } = splitStationLevel(part.trim());
    if (level !== null && [link.text, link.title].some((name) => nameKey(name) === nameKey(base))) return level;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Recipes as the pages state them                                             */
/* -------------------------------------------------------------------------- */

/** A step as a page states it, before ids, duplicates and corrections. */
type Draft = {
  product: Place;
  quality: number;
  station: Place | null;
  /**
   * For a list page's piece, the key of the override that names its station
   * (`listStations`); the station is looked up by id once ids are given.
   */
  stationOverride: string | null;
  /** Null where nothing states a level. */
  stationLevel: number | null;
  /** Null where the wiki states none. */
  yield: number | null;
  /** Whether another statement contradicts the yield: the food table, or the same step on another page. */
  doubt: boolean;
  inputs: [Place, number][];
  from: string;
  /** The page it was read on: the same step twice on one page is no duplicate of it. */
  page: Page;
  /**
   * Which statement of a step is kept, lowest first, where the game's rule
   * does not decide: 0 for the item's own infobox, 1 for its own table of
   * upgrades, 2 for another page's infobox, 3 for a row of a table.
   */
  rank: number;
};

/**
 * A note from a quality tab, and the tab's number: "Quality 4: Wood x3,
 * Iron x30". The extractor numbers what it could not read, so that a level
 * nobody could read still counts as one the item has.
 */
const QUALITY_NOTE = /^Quality (\d+):/;

function readRecipes(ctx: Ctx): Draft[] {
  const drafts: Draft[] = [];

  for (const page of ctx.pages) {
    for (const place of [page.own, ...page.tabs]) {
      if (!place) continue;
      const box = place.box!;
      for (const note of box.notes) {
        ctx.notes.push({ text: note, from: place.key });
        const quality = QUALITY_NOTE.exec(note);
        if (quality) ctx.statedQuality.set(place, Math.max(ctx.statedQuality.get(place) ?? 0, Number(quality[1])));
      }
      if (box.levels.length === 0) continue;
      const station = stationOf(ctx, box);
      for (const level of box.levels) {
        drafts.push({
          product: place,
          quality: level.quality,
          station: station?.place ?? null,
          stationOverride: null,
          stationLevel: level.stationLevel ?? station?.level ?? null,
          yield: level.yield,
          doubt: false,
          inputs: level.entries.map((entry) => [resolveEntry(ctx, entry, place, place.key), entry.qty]),
          from: place.key,
          page,
          rank: place.shape === 'own' ? 0 : 2,
        });
      }
    }
    const table = page.recipes.upgradeTable;
    if (page.own && table) readTableRecipes(ctx, page, page.own, table, drafts);
  }

  // Every station's extensions are looked up here, before ids are given:
  // one the overrides add may be a thing only named, a place of its own
  // that needs an id like any other.
  for (const page of ctx.pages) {
    if (page.own && listsExtensions(ctx, page.own)) extensionsOf(ctx, page.own);
  }
  for (const page of ctx.pages) {
    if (page.stationTable) readExtensionRows(ctx, page, drafts);
    else readPieceRows(ctx, page, drafts);
  }

  applyFoodTable(ctx, drafts);
  return drafts;
}

/**
 * The steps an item's table of upgrades states, a second statement of each
 * step its infobox states and the only one of a quality the infobox leaves
 * out. Made at the station the infobox names; a thing it names none for is
 * made by hand, and the game upgrades it where it is repaired, from the
 * second quality on: at the station the table's level row names ("Workbench
 * level 1 2 3 4" on the Club).
 */
function readTableRecipes(ctx: Ctx, page: Page, own: Place, table: RawUpgradeTable, drafts: Draft[]): void {
  const from = `${page.title}#${table.anchor ?? 'Upgrade information'}`;
  for (const note of table.notes) {
    ctx.notes.push({ text: note, from });
    const quality = QUALITY_NOTE.exec(note);
    if (quality) ctx.statedQuality.set(own, Math.max(ctx.statedQuality.get(own) ?? 0, Number(quality[1])));
  }
  if (table.levels.length === 0) return;
  const station = stationOf(ctx, own.box!)?.place ?? null;
  const repairs = station === null && table.station !== null ? namedStation(ctx, table.station) : null;
  for (const level of table.levels) {
    drafts.push({
      product: own,
      quality: level.quality,
      station: station ?? (level.quality >= 2 ? repairs : null),
      stationOverride: null,
      stationLevel: level.stationLevel,
      yield: level.yield,
      doubt: false,
      inputs: level.entries.map((entry) => [resolveEntry(ctx, entry, own, from), entry.qty]),
      from,
      page,
      rank: 1,
    });
  }
}

/** The station a name names, written as a table writes it ("Galdr table"); null when it is none. */
function namedStation(ctx: Ctx, name: string): Place | null {
  const found = findPage(ctx, name);
  const place = found ? locate(found.page, found.fragment, name) : null;
  return place && couldBeStation(place) ? place : null;
}

/**
 * A list page's building pieces. A row names a thing with a page of its own
 * when it is named exactly like it ("Reinforced chest", the Reinforced
 * Chest), and that page's recipe is kept; a row named otherwise is a piece of
 * its own, even where a redirect leads to a page: the three Yuleklapp sizes
 * all redirect to the one Yuleklapp, whose single infobox cannot state them.
 */
function readPieceRows(ctx: Ctx, page: Page, drafts: Draft[]): void {
  for (const place of page.rows) {
    const row = place.row!;
    for (const note of row.notes) ctx.notes.push({ text: note, from: place.key });
    const product = describedElsewhere(ctx, place) ?? place;
    // The page's text names the station once for all its pieces; a piece it
    // names apart is keyed by its row.
    const stationOverride =
      [`${page.title}#${row.name}`, page.title].find((key) => Object.hasOwn(ctx.overrides.listStations, key)) ?? null;
    drafts.push({
      product,
      quality: 1,
      station: null,
      stationOverride,
      stationLevel: null,
      yield: null,
      doubt: false,
      inputs: row.entries.map((entry) => [resolveEntry(ctx, entry, product, place.key), entry.qty]),
      from: page.title,
      page,
      rank: 3,
    });
  }
}

/** The place a row names when a page describes it under exactly the row's name, else null. */
function describedElsewhere(ctx: Ctx, place: Place): Place | null {
  const found = findPage(ctx, place.en);
  const other = found ? locate(found.page, found.fragment, place.en) : null;
  return other && other !== place && sharesName(other, place) ? other : null;
}

/**
 * A station's table of extensions: each row a recipe for one of the
 * extensions its infobox lists (Improvements), the overrides add, or whose
 * own page says it upgrades the station. An extension with a page of its
 * own states it there too, and that is kept; the Artisan press has none. A
 * row naming no such extension is left out and noted: whether a row the
 * station's pages do not list is in the game yet is not the graph's to
 * guess, and the overrides say so only where the wiki does (the Cauldron's
 * Smoker, which version 1.0 brought).
 */
function readExtensionRows(ctx: Ctx, page: Page, drafts: Draft[]): void {
  const listed = extensionsOf(ctx, page.own!);
  for (const place of page.rows) {
    const row = place.row!;
    const from = row.anchor ? `${page.title}#${row.anchor}` : page.title;
    const product = describedElsewhere(ctx, place) ?? place;
    if (!listed.includes(product) && upgradedStation(ctx, product) !== page.own) {
      ctx.notes.push({
        text: `${row.name}: in the table of extensions but not among the station's Improvements; left out`,
        from,
      });
      continue;
    }
    for (const note of row.notes) ctx.notes.push({ text: note, from: place.key });
    drafts.push({
      product,
      quality: 1,
      station: null,
      stationOverride: null,
      stationLevel: null,
      yield: null,
      doubt: false,
      inputs: row.entries.map((entry) => [resolveEntry(ctx, entry, product, place.key), entry.qty]),
      from,
      page,
      rank: 3,
    });
  }
}

/**
 * The extensions a station's Improvements list, each by its page, or by its
 * row in the station's own table where it has no page; then the ones the
 * overrides add (`extensions`), looked up the same way, or a thing only
 * named on the station's page where nothing describes it yet. Memoized: the
 * station's item and its table both ask.
 */
function extensionsOf(ctx: Ctx, station: Place): Place[] {
  const known = ctx.extensions.get(station);
  if (known) return known;
  const out: Place[] = [];
  const page = station.page!;
  const lookUp = (name: string, fragment: string | null): Place | null => {
    const found = findPage(ctx, name);
    return (
      (found ? locate(found.page, fragment ?? found.fragment, name) : null) ??
      page.rows.find((p) => nameKey(p.en) === nameKey(name)) ??
      null
    );
  };

  for (const link of station.box!.improvements) {
    const place = lookUp(link.title, link.fragment);
    if (!place || place === station) {
      ctx.notes.push({ text: `Improvements: ${link.title} names no page or table row`, from: station.key });
      continue;
    }
    if (!out.includes(place)) out.push(place);
  }

  for (const key of Object.keys(ctx.overrides.extensions)) {
    const hash = key.indexOf('#');
    if (key.slice(0, hash) !== page.title) continue;
    const name = key.slice(hash + 1);
    const place = lookUp(name, null) ?? virtual(ctx, page, name);
    // Listed already, or found by its own "Upgrades" (`buildItems`): the
    // wiki caught up, and the sweep reports the entry as one to delete.
    if (place === station || out.includes(place) || upgradedStation(ctx, place) === station) continue;
    out.push(place);
    ctx.addedExtensions.set(place, key);
  }
  ctx.extensions.set(station, out);
  return out;
}

/** Whether a page's own infobox may have extensions to look up: Improvements, or an override adding one. */
function listsExtensions(ctx: Ctx, place: Place): boolean {
  if (place.box!.improvements.length > 0) return true;
  return Object.keys(ctx.overrides.extensions).some((key) => key.slice(0, key.indexOf('#')) === place.page!.title);
}

/**
 * What the Food page's table says about each food: the Cauldron level the
 * food's own infobox leaves out (it says "Cauldron" for a soup that needs
 * level 5), and how many one craft makes. A level is taken only where the
 * infobox states none and the table names the same station; a count that
 * disagrees with the recipe's puts its yield in doubt.
 */
function applyFoodTable(ctx: Ctx, drafts: Draft[]): void {
  const rows = new Map<Place, { station: Place | null; level: number | null; multiplier: number | null }>();
  for (const page of ctx.pages) {
    for (const food of page.recipes.foodRows) {
      const found = findPage(ctx, food.item.title);
      const place = found ? locate(found.page, food.item.fragment ?? found.fragment, food.item.title) : null;
      if (!place || rows.has(place)) continue;
      const at = food.station ? findPage(ctx, food.station) : null;
      const station = at ? locate(at.page, at.fragment, food.station!) : null;
      rows.set(place, {
        station: station && couldBeStation(station) ? station : null,
        level: food.stationLevel,
        multiplier: food.multiplier,
      });
    }
  }

  for (const draft of drafts) {
    const row = draft.quality === 1 ? rows.get(draft.product) : undefined;
    if (!row || !row.station || row.station !== draft.station) continue;
    if (draft.stationLevel === null && row.level !== null) draft.stationLevel = row.level;
    if (row.multiplier !== null && row.multiplier !== (draft.yield ?? 1)) draft.doubt = true;
  }
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Gives every place its id: the internal ID it claims, else where it is
 * described. One ID claimed under one name is one item, described twice
 * (the Troll hide cape, on its own page and in the Troll Set). One ID
 * claimed under two names is the wiki copying a neighbour's: the first keeps
 * it, own infoboxes before tabs, and the other is reported.
 */
function assignIds(ctx: Ctx): void {
  const shapes: Place['shape'][] = ['own', 'tab', 'row', 'virtual'];
  const ordered = shapes.flatMap((shape) => ctx.places.filter((place) => place.shape === shape));
  const owners = new Map<ItemId, Place>();
  const taken = new Map<ItemId, Place>();

  for (const place of ordered) {
    let id: ItemId | null = place.claimed;
    if (id !== null) {
      const owner = owners.get(id);
      if (owner && !sharesName(owner, place)) {
        const fallback = unique(taken, fallbackId(place), place);
        ctx.idConflicts.push({ id, kept: owner.key, moved: place.key, as: fallback });
        id = fallback;
      } else if (!owner) {
        owners.set(id, place);
      }
    }
    place.id = id ?? unique(taken, fallbackId(place), place);
    if (!taken.has(place.id)) taken.set(place.id, place);
  }
  ctx.home = taken;
}

/** Where a place is described, as an id: `page:<slug>`, or `page:<slug>#<anchor>`. */
function fallbackId(place: Place): ItemId {
  if (place.page === null) return `page:${slugify(place.en)}`;
  return place.anchor === null ? `page:${place.page.slug}` : `page:${place.page.slug}#${place.anchor}`;
}

/** An id no other thing has: `-2`, `-3`… after one that two places would share. */
function unique(taken: Map<ItemId, Place>, id: ItemId, place: Place): ItemId {
  let candidate = id;
  for (let n = 2; taken.has(candidate) && taken.get(candidate) !== place; n += 1) candidate = `${id}-${n}`;
  return candidate;
}

/** The place an id names, once ids are given. */
function placeById(ctx: Ctx, id: ItemId): Place | null {
  return ctx.home.get(id) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Recipes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Turns the drafts into the graph's recipes: one per product and quality,
 * with the corrections and alternatives the overrides add, and every doubt
 * on the way into the report.
 */
function settleRecipes(ctx: Ctx, drafts: Draft[]): GraphRecipe[] {
  // Every statement of each step, product by product in the order the pages
  // were read, and a product's steps in quality order: the rule that settles
  // a step past the second goes by the product's second, settled first.
  const products = new Map<ItemId, Map<number, Draft[]>>();
  for (const draft of drafts) {
    const steps = products.get(draft.product.id) ?? new Map<number, Draft[]>();
    products.set(draft.product.id, steps);
    const same = steps.get(draft.quality);
    if (same) same.push(draft);
    else steps.set(draft.quality, [draft]);
  }

  let recipes: GraphRecipe[] = [];
  const settled = new Map<GraphRecipe, SettledStep>();
  for (const steps of products.values()) {
    let second: GraphRecipe | null = null;
    for (const quality of [...steps.keys()].sort((a, b) => a - b)) {
      const recipe = settleStep(ctx, steps.get(quality)!, second, settled);
      if (quality === 2) second = recipe;
      recipes.push(recipe);
    }
  }

  addSteps(ctx, recipes, settled);
  recipes = checkUpgradeCosts(ctx, recipes, settled);
  addAlternatives(ctx, recipes);
  addFuel(ctx, recipes);
  return recipes;
}

/** A step by its product's id and quality, as `steps` overrides name it: `HelmetTrollLeather@2`. */
function stepKey(product: ItemId, quality: number): string {
  return `${product}@${quality}`;
}

/** A step an override states, and whether it changed what the pages state: an entry that did not may still settle a suspect. */
type SettledStep = { key: string; reason: string; changed: boolean };

/**
 * One step, from every statement of it: an item's infobox, its table of
 * upgrades, another page's infobox, a row of a table.
 *
 * The statement kept is the best placed (`rank`) of those the game's rule
 * bears out, else the best placed of all. The rule is how the game prices an
 * upgrade: the same materials again at every quality, so that the step to
 * quality q is (q - 1) times the step to quality 2 (`second`), as the Iron
 * Sword's 10, 20 and 30 Iron are. It says nothing of the first two steps or
 * of station levels.
 *
 * A statement that disagrees with the kept one is overruled (`overruled`)
 * where the rule bears out the kept one and not it, and otherwise a cost
 * conflict (`costConflicts`) for a person to settle, with the kept one
 * standing meanwhile; one on another page is also a duplicate. A station or
 * a level the kept statement leaves out is taken from another on its page:
 * the table names where a thing made by hand is upgraded.
 *
 * An override (`steps`) settles the step whatever the statements say. One
 * that names a material the graph has no place for is left alone, as is one
 * every statement already agrees with: the sweep reports both. One that
 * agrees with every statement and settles an upgrade the cost check would
 * hold back counts there.
 */
function settleStep(ctx: Ctx, statements: Draft[], second: GraphRecipe | null, settled: Map<GraphRecipe, SettledStep>): GraphRecipe {
  // A stable sort: among equals, the order the pages were read in decides.
  const ranked = [...statements].sort((a, b) => a.rank - b.rank);
  const { product, quality } = ranked[0]!;
  const key = stepKey(product.id, quality);
  const costOf = (draft: Draft): [ItemId, number][] => draft.inputs.map(([place, qty]) => [place.id, qty]);
  const linear = quality >= 3 && second ? second.inputs.map(([id, qty]): [ItemId, number] => [id, qty * (quality - 1)]) : null;
  const onRule = (draft: Draft): boolean => linear !== null && sameInputs(costOf(draft), linear);
  const fix = ctx.overrides.steps[key];
  const fixed = fix && fix.inputs.every(([id]) => placeById(ctx, id)) ? fix : null;

  const kept = (fixed ? undefined : ranked.find(onRule)) ?? ranked[0]!;
  const others = ranked.filter((draft) => draft !== kept);
  for (const dropped of others) {
    if (dropped.page !== kept.page) ctx.duplicates.push({ product: product.id, quality, kept: kept.from, dropped: dropped.from });
    // A yield another statement states and the kept one leaves out, or contradicts.
    if (dropped.yield !== null && dropped.yield !== (kept.yield ?? 1)) kept.doubt = true;
  }
  const beside = others.filter((draft) => draft.page === kept.page);

  const recipe: GraphRecipe = {
    product: product.id,
    quality,
    station:
      kept.station?.id ??
      beside.find((draft) => draft.station !== null)?.station?.id ??
      listStation(ctx, kept.stationOverride) ??
      upgradeStation(ctx, kept),
    stationLevel: kept.stationLevel ?? beside.find((draft) => draft.stationLevel !== null)?.stationLevel ?? 1,
    yield: kept.yield ?? 1,
    yieldKnown: true,
    inputs: costOf(kept),
    method: 'craft',
    from: kept.from,
  };
  settleYield(ctx, recipe, kept.doubt);

  // Levels disagree only where both statements state one.
  const sameLevel = (draft: Draft): boolean =>
    draft.stationLevel === null || kept.stationLevel === null || draft.stationLevel === kept.stationLevel;
  const conflict = (): void => {
    ctx.costConflicts.push({
      product: product.id,
      quality,
      statements: [kept, ...others].map((draft) => ({ from: draft.from, inputs: costOf(draft), stationLevel: draft.stationLevel })),
    });
  };

  if (fixed) {
    const changed = ranked.some(
      (draft) =>
        !sameInputs(costOf(draft), fixed.inputs) ||
        (fixed.stationLevel !== undefined && (draft.stationLevel ?? 1) !== fixed.stationLevel),
    );
    recipe.inputs = fixed.inputs.map(([id, qty]) => [id, qty]);
    if (fixed.stationLevel !== undefined) recipe.stationLevel = fixed.stationLevel;
    settled.set(recipe, { key, reason: fixed.reason, changed });
    if (changed) apply(ctx, `steps: ${key}`, fixed.reason);
    // An entry that states no level leaves the level to the statements, and
    // a level they disagree on is still one to settle.
    if (fixed.stationLevel === undefined && !others.every(sameLevel)) conflict();
    return recipe;
  }

  const disagree = others.filter((draft) => !sameInputs(costOf(draft), recipe.inputs) || !sameLevel(draft));
  if (disagree.length === 0) return recipe;
  if (onRule(kept) && disagree.every((draft) => !onRule(draft) && sameLevel(draft))) {
    for (const draft of disagree) {
      ctx.overruled.push({
        product: product.id,
        quality,
        from: draft.from,
        stated: costOf(draft),
        kept: { from: kept.from, inputs: recipe.inputs },
      });
    }
    return recipe;
  }
  conflict();
  return recipe;
}

/**
 * The steps nothing states that the overrides add: a quality past the
 * highest an infobox or a table of upgrades states, made at the station of
 * the step before it. An entry with no step before it to follow is left to
 * the sweep.
 */
function addSteps(ctx: Ctx, recipes: GraphRecipe[], settled: Map<GraphRecipe, SettledStep>): void {
  const planned = new Map(recipes.filter((r) => !r.alt).map((r) => [stepKey(r.product, r.quality), r]));
  const added = Object.keys(ctx.overrides.steps)
    .filter((key) => !planned.has(key))
    .map((key) => ({ key, product: key.slice(0, key.lastIndexOf('@')), quality: Number(key.slice(key.lastIndexOf('@') + 1)) }))
    .filter(({ quality }) => Number.isInteger(quality) && quality >= 2)
    // A quality after the one before it, which may be added here too.
    .sort((a, b) => a.quality - b.quality || compare(a.key, b.key));
  for (const { key, product, quality } of added) {
    const fix = ctx.overrides.steps[key]!;
    const before = planned.get(stepKey(product, quality - 1));
    if (!before || !fix.inputs.every(([id]) => placeById(ctx, id))) continue;
    const recipe: GraphRecipe = {
      product,
      quality,
      station: before.station,
      // Every quality needs the station a level higher than the one before it.
      stationLevel: fix.stationLevel ?? before.stationLevel + 1,
      yield: before.yield,
      yieldKnown: before.yieldKnown,
      inputs: fix.inputs.map(([id, qty]) => [id, qty]),
      method: before.method,
      from: before.from,
    };
    recipes.push(recipe);
    planned.set(key, recipe);
    settled.set(recipe, { key, reason: fix.reason, changed: true });
    apply(ctx, `steps: ${key}`, fix.reason);
  }
}

/**
 * Holds back every upgrade the wiki states off the game's rule. An upgrade
 * costs the same materials again at every quality: the step to quality q is
 * (q - 1) times the step to quality 2, as the Iron Sword's 10, 20 and 30
 * Iron are. A step off that line is a slip on some page, most often a fourth
 * step twice the third, and a total that counts it is a wrong number.
 *
 * Each is reported (`costSuspects`) with what the rule gives, and left out
 * of the graph while the item still goes up to its quality, so that the
 * maths names the step it cannot price (`missingSteps`) instead of adding it
 * up, until an override settles it. A step an override states is settled,
 * whatever it costs.
 */
function checkUpgradeCosts(ctx: Ctx, recipes: GraphRecipe[], settled: Map<GraphRecipe, SettledStep>): GraphRecipe[] {
  const planned = new Map(recipes.filter((r) => !r.alt).map((r) => [stepKey(r.product, r.quality), r]));
  const held = new Set<GraphRecipe>();
  for (const recipe of recipes) {
    const second = recipe.quality >= 3 && !recipe.alt ? planned.get(stepKey(recipe.product, 2)) : undefined;
    if (!second) continue;
    const linear = second.inputs.map(([id, qty]): [ItemId, number] => [id, qty * (recipe.quality - 1)]);
    if (sameInputs(recipe.inputs, linear)) continue;
    const fix = settled.get(recipe);
    if (fix) {
      if (!fix.changed) apply(ctx, `steps: ${fix.key}`, fix.reason);
      continue;
    }
    ctx.costSuspects.push({ product: recipe.product, quality: recipe.quality, from: recipe.from, stated: recipe.inputs, linear });
    held.add(recipe);
    const place = ctx.home.get(recipe.product)!;
    ctx.statedQuality.set(place, Math.max(ctx.statedQuality.get(place) ?? 0, recipe.quality));
  }
  return recipes.filter((recipe) => !held.has(recipe));
}

/** Whether two lists of materials ask for the same amounts, in whatever order they list them. */
function sameInputs(a: [ItemId, number][], b: [ItemId, number][]): boolean {
  const amounts = (inputs: [ItemId, number][]) => {
    const total = new Map<ItemId, number>();
    for (const [id, qty] of inputs) total.set(id, (total.get(id) ?? 0) + qty);
    return total;
  };
  const left = amounts(a);
  const right = amounts(b);
  return left.size === right.size && [...left].every(([id, qty]) => right.get(id) === qty);
}

/** The station a list page's text names for its pieces, by the override's key; null when it names none here. */
function listStation(ctx: Ctx, key: string | null): ItemId | null {
  if (key === null) return null;
  const fix = ctx.overrides.listStations[key]!;
  if (!placeById(ctx, fix.station)) return null;
  apply(ctx, `listStations: ${key}`, fix.reason);
  return fix.station;
}

/**
 * Where an upgrade of a thing made by hand is made, from the overrides
 * (`upgradeStations`): the first level is the Player crafting menu's, and
 * every later one the station's. Null for anything else.
 */
function upgradeStation(ctx: Ctx, draft: Draft): ItemId | null {
  if (draft.quality < 2) return null;
  const fix = ctx.overrides.upgradeStations[draft.product.id];
  if (!fix || !placeById(ctx, fix.station)) return null;
  apply(ctx, `upgradeStations: ${draft.product.id}`, fix.reason);
  return fix.station;
}

/**
 * A yield in doubt is settled by an override, or stays in doubt: the maths
 * then stops at the item instead of counting on one per craft.
 */
function settleYield(ctx: Ctx, recipe: GraphRecipe, doubt: boolean): void {
  const fix = recipe.quality === 1 ? ctx.overrides.yields[recipe.product] : undefined;
  if (fix) {
    // Counted where it settles a doubt or changes the count, not where it repeats the recipe.
    if (doubt || fix.yield !== recipe.yield) apply(ctx, `yields: ${recipe.product}`, fix.reason);
    recipe.yield = fix.yield;
    return;
  }
  if (!doubt) return;
  recipe.yieldKnown = false;
  ctx.yieldSuspects.push({ product: recipe.product, from: recipe.from });
}

/** The overrides' other ways to make a product, numbered after the product's own recipe. */
function addAlternatives(ctx: Ctx, recipes: GraphRecipe[]): void {
  ctx.overrides.alternatives.forEach((alt) => {
    const name = `alternatives: ${alt.product} from ${alt.inputs.map(([id]) => id).join(' + ')} (${alt.from})`;
    const ids = [alt.product, alt.station, ...alt.inputs.map(([id]) => id)];
    if (ids.some((id) => !placeById(ctx, id))) {
      staleOverride(ctx, name);
      return;
    }
    const others = recipes.filter((r) => r.product === alt.product && r.quality === 1 && (r.alt ?? 0) > 0).length;
    recipes.push({
      product: alt.product,
      quality: 1,
      station: alt.station,
      stationLevel: 1,
      yield: 1,
      yieldKnown: true,
      inputs: alt.inputs.map(([id, qty]) => [id, qty]),
      method: alt.method,
      alt: others + 1,
      from: alt.from,
    });
    apply(ctx, name, alt.reason);
  });
}

/** The fuel each station burns per craft, from the overrides. */
function addFuel(ctx: Ctx, recipes: GraphRecipe[]): void {
  for (const [station, fix] of Object.entries(ctx.overrides.fuel)) {
    const name = `fuel: ${station}`;
    if (!placeById(ctx, fix.fuel[0])) {
      staleOverride(ctx, name);
      continue;
    }
    let count = 0;
    for (const recipe of recipes) {
      if (recipe.station !== station) continue;
      recipe.fuel = [fix.fuel[0], fix.fuel[1]];
      count += 1;
    }
    if (count > 0) apply(ctx, name, fix.reason, count);
    else staleOverride(ctx, name);
  }
}

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How things are made at the stations that do something other than craft,
 * by the station's internal ID. Anything built with the hammer is built,
 * wherever it is built.
 */
const METHOD_AT: Record<string, RecipeMethod> = {
  smelter: 'smelt',
  blastfurnace: 'smelt',
  piece_cookingstation: 'cook',
  Piece_ironcookingstation: 'cook',
  piece_cauldron: 'cook',
  piece_oven: 'bake',
  piece_MeadCauldron: 'brew',
  fermenter: 'ferment',
  eitrrefinery: 'refine',
  windmill: 'mill',
  piece_spinningwheel: 'spin',
  charcoal_kiln: 'kiln',
  piece_preptable: 'prepare',
};

/** Categories of things built with the hammer and placed in the world. */
const PIECE_CATEGORIES = [
  'building structures',
  'crafting structures',
  'misc structures',
  'furniture',
  'storage',
  'fires',
  'beds',
  'chairs',
  'tables',
  'banners',
  'rugs',
  'roofs',
  'stacks & piles',
  'seasonal furniture',
  'grants comfort',
  'boats',
  'transport',
  'light sources',
];

/** Categories of things carried in the inventory, which win over any of the above: a Fire arrow is a light source too. */
const ITEM_CATEGORIES = [
  'weapons',
  'armor',
  'tools',
  'food',
  'materials',
  'mead',
  'arrows',
  'bolts',
  'missiles',
  'bombs',
  'trinket',
  'capes',
  'shields',
  'magic',
  'items',
  'misc items',
  'accessories',
  'feast',
];

/**
 * How a raw material is had, by the categories of the page its Source links
 * to, in this order: a creature drops it, a fish is caught, a deposit is
 * mined, a tree chopped, a crop farmed, a dungeon looted, a biome or a
 * structure gathered from. A trader sells it, but at a price only the
 * overrides know.
 */
const OBTAIN_BY_CATEGORY: [Exclude<Obtain['how'], 'buy'>, string[]][] = [
  ['drop', ['creatures', 'aggressive creatures', 'passive creatures', 'tameable creatures', 'bosses', 'minibosses']],
  ['fish', ['fish', 'fishing']],
  ['mine', ['ore deposits', 'resource nodes']],
  ['chop', ['trees', 'wood']],
  ['farm', ['seeds', 'farming']],
  ['loot', ['points of interest', 'dungeons', 'storage', 'objects']],
  ['gather', ['biomes', 'crafting structures']],
];

function buildItems(ctx: Ctx, recipes: GraphRecipe[]): GraphItem[] {
  const home = (id: ItemId): Place => ctx.home.get(id)!;

  // Every thing a recipe names, with the stations' extensions and the
  // stations the extensions raise.
  const used = new Set<ItemId>();
  for (const recipe of recipes) {
    used.add(recipe.product);
    if (recipe.station !== null) used.add(recipe.station);
    for (const [id] of recipe.inputs) used.add(id);
    if (recipe.fuel) used.add(recipe.fuel[0]);
  }
  const stations = ctx.stations;
  for (const recipe of recipes) if (recipe.station !== null) stations.add(recipe.station);
  for (const id of used) {
    const place = home(id);
    if (place.box !== null && place.box.maxLevel !== null && couldBeStation(place)) stations.add(id);
  }

  // Round after round until nothing new turns up, because each finds what
  // the other needs: a station brings every extension its Improvements list,
  // made yet or not; an extension's "Upgrades X" brings its station, which
  // nothing need be made at yet, and whose other extensions come with it in
  // the next round. Every extension a station names is then an item, as the
  // codec requires of a graph any reader can decode.
  const extendsOf = new Map<ItemId, ItemId>();
  // Extensions found only by their own "Upgrades", by station: an infobox
  // that predates them, as 1.0's did.
  const upgradedOnly = new Map<ItemId, ItemId[]>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of [...stations]) {
      const station = home(id);
      if (station.shape !== 'own') continue;
      for (const extension of extensionsOf(ctx, station)) {
        if (extendsOf.has(extension.id)) continue;
        extendsOf.set(extension.id, id);
        used.add(extension.id);
        grew = true;
      }
    }
    for (const id of [...used].sort(compare)) {
      if (extendsOf.has(id)) continue;
      const station = upgradedStation(ctx, home(id));
      if (!station) continue;
      extendsOf.set(id, station.id);
      upgradedOnly.set(station.id, [...(upgradedOnly.get(station.id) ?? []), id]);
      stations.add(station.id);
      used.add(station.id);
      grew = true;
    }
  }

  // An override's ID counts as applied where the thing it names made it into
  // the graph by it: not where its infobox already states that ID.
  for (const place of ctx.places) {
    const fix = ctx.overrides.internalIds[place.key];
    if (fix && place.id === fix.id && used.has(place.id) && place.box?.internalId !== fix.id) {
      apply(ctx, `internalIds: ${place.key}`, fix.reason);
    }
  }

  const planned = new Set(recipes.filter((r) => r.quality === 1 && !r.alt).map((r) => r.product));
  const items: GraphItem[] = [];
  for (const id of used) {
    const place = home(id);
    const kind = kindOf(place, stations.has(id), extendsOf.has(id));
    const item: GraphItem = { id, en: place.en, kind, maxQuality: 1 };
    if (place.page !== null) item.slug = place.page.slug;
    if (place.anchor !== null) item.anchor = place.anchor;
    if (kind === 'station') item.station = stationInfo(ctx, place, upgradedOnly.get(id) ?? []);
    const raised = extendsOf.get(id);
    if (raised !== undefined) item.extends = raised;
    if (!planned.has(id)) {
      const obtain = obtainOf(ctx, place);
      if (obtain.length > 0) item.obtain = obtain;
    }
    items.push(item);
  }

  // Quality and method follow from the items: how far each upgrades, and
  // whether what is made is built or crafted.
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const recipe of recipes) {
    const product = byId.get(recipe.product)!;
    if (!recipe.alt) product.maxQuality = Math.max(product.maxQuality, recipe.quality);
    if (recipe.alt) continue;
    const built = product.kind === 'piece' || product.kind === 'station' || product.kind === 'extension';
    recipe.method = built ? 'build' : ((recipe.station !== null && METHOD_AT[recipe.station]) || 'craft');
  }
  // A quality tab nobody could read still counts: the item goes up to it,
  // and the maths names the step it has no recipe for (`missingSteps`)
  // rather than a total that looks complete.
  for (const [place, quality] of ctx.statedQuality) {
    const item = byId.get(place.id);
    if (item) item.maxQuality = Math.max(item.maxQuality, quality);
  }

  spanishNames(ctx, byId);
  return items;
}

function kindOf(place: Place, station: boolean, extension: boolean): ItemKind {
  if (station) return 'station';
  if (extension) return 'extension';
  if (place.shape === 'virtual') return 'virtual';
  if (place.shape === 'row') return 'piece';
  const categories = place.page!.categories;
  const piece = PIECE_CATEGORIES.some((c) => categories.has(c)) && !ITEM_CATEGORIES.some((c) => categories.has(c));
  return piece ? 'piece' : 'item';
}

/**
 * A station's levels and extensions: the extensions its Improvements list,
 * those the overrides add, and those found only by their own "Upgrades",
 * in that order; its highest level as its infobox states it, unless an
 * override settles a contradiction.
 *
 * Every extension raises a station one level, so a station whose infobox
 * states no Max Level has 1 more than it has extensions. One that states a
 * maximum its extensions disagree with keeps the maximum stated, and the
 * report says so: which of the two is stale is for a person to settle.
 */
function stationInfo(ctx: Ctx, place: Place, upgradedOnly: ItemId[]): NonNullable<GraphItem['station']> {
  const listed = place.shape === 'own' ? extensionsOf(ctx, place) : [];
  for (const extension of listed) {
    const key = ctx.addedExtensions.get(extension);
    if (key !== undefined) apply(ctx, `extensions: ${key}`, ctx.overrides.extensions[key]!.reason);
  }
  const extensions = [...new Set([...listed.map((p) => p.id), ...upgradedOnly])];
  const counted = 1 + extensions.length;
  const stated = place.box?.maxLevel ?? null;

  // An entry counts where it changes the level the station would have: one
  // that says what the infobox says has nothing left to settle.
  const fix = ctx.overrides.stationMaxLevel[place.id];
  if (fix && fix.maxLevel !== (stated ?? counted)) {
    apply(ctx, `stationMaxLevel: ${place.id}`, fix.reason);
    return { maxLevel: fix.maxLevel, extensions };
  }
  if (stated === null) return { maxLevel: counted, extensions };
  if (extensions.length > 0 && stated !== counted) {
    ctx.notes.push({
      text: `Max Level ${stated}, though its ${extensions.length} extensions make ${counted} levels; the stated maximum is kept`,
      from: place.key,
    });
  }
  return { maxLevel: stated, extensions };
}

/**
 * How a raw material is had: an override's word, a trophy's creature, or its
 * Source's links by the kind of page each leads to. Links to stations are
 * left out (coal's charcoal kiln is a recipe, an alternative), as are those
 * whose kind of page says nothing.
 */
function obtainOf(ctx: Ctx, place: Place): Obtain[] {
  const fix = ctx.overrides.obtain[place.id];
  if (fix) {
    // Counted where it says more than Source does: an entry that repeats it has nothing left to settle.
    if (place.shape === 'virtual' || JSON.stringify(sourceWays(ctx, place)) !== JSON.stringify(fix.obtain)) {
      apply(ctx, `obtain: ${place.id}`, fix.reason);
    }
    // A copy: whatever decorates the graph's items later must never reach the module's own lists.
    return structuredClone(fix.obtain);
  }
  return place.shape === 'virtual' ? trophyDrop(ctx, place) : sourceWays(ctx, place);
}

/** How a raw material is had by its Source's links, by the kind of page each leads to. */
function sourceWays(ctx: Ctx, place: Place): Obtain[] {
  const ways: Extract<Obtain, { from: string[] }>[] = [];
  for (const link of place.box?.source?.links ?? []) {
    const found = findPage(ctx, link.title);
    if (!found || found.page === place.page) continue;
    // A station something is made at names a recipe, not a place to find it.
    if (found.page.own && ctx.stations.has(found.page.own.id)) continue;
    const how = OBTAIN_BY_CATEGORY.find(([, categories]) => categories.some((c) => found.page.categories.has(c)))?.[0];
    if (!how) continue;
    const way = ways.find((w) => w.how === how);
    if (!way) ways.push({ how, from: [found.page.title] });
    else if (!way.from.includes(found.page.title)) way.from.push(found.page.title);
  }
  return ways;
}

/** A trophy, dropped by the creature it is named after, where the trophies' page is its home. */
function trophyDrop(ctx: Ctx, place: Place): Obtain[] {
  const rule = ctx.overrides.trophies;
  if (!place.page || place.page.title !== rule.page) return [];
  const creature = TROPHY.exec(place.en)?.[1];
  const found = creature ? findPage(ctx, creature) : null;
  if (!found || !OBTAIN_BY_CATEGORY[0]![1].some((c) => found.page.categories.has(c))) {
    ctx.notes.push({ text: `${place.en}: no creature page to drop it`, from: place.key });
    return [];
  }
  apply(ctx, `trophies: ${rule.page}`, rule.reason);
  return [{ how: 'drop', from: [found.page.title] }];
}

/** The curated Spanish names, for the things no article's translation names. */
function spanishNames(ctx: Ctx, items: Map<ItemId, GraphItem>): void {
  ctx.overrides.spanishNames.forEach((group, i) => {
    let count = 0;
    for (const [id, es] of Object.entries(group.names)) {
      const item = items.get(id);
      if (!item) {
        ctx.notes.push({ text: `spanishNames: ${id} is not in the graph`, from: 'recipe-overrides' });
        continue;
      }
      item.es = es;
      count += 1;
    }
    if (count > 0) apply(ctx, `spanishNames[${i}]`, group.reason, count);
  });
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

function apply(ctx: Ctx, override: string, reason: string, count = 1): void {
  const entry = ctx.applied.get(override);
  if (entry) entry.count += count;
  else ctx.applied.set(override, { override, reason, count });
}

/** An override that found nothing to change: the wiki moved on, and the entry should go. */
function staleOverride(ctx: Ctx, override: string): void {
  ctx.notes.push({ text: `${override}: changed nothing`, from: 'recipe-overrides' });
}

function unresolve(ctx: Ctx, text: string, from: string): void {
  const key = `${text}\u0000${from}`;
  const entry = ctx.unresolved.get(key);
  if (entry) entry.count += 1;
  else ctx.unresolved.set(key, { text, from, count: 1 });
}

/** Notes the overrides, keyed by what they name, that changed nothing in this graph. */
function sweepOverrides(ctx: Ctx): void {
  const { overrides } = ctx;
  const named = [
    ...Object.keys(overrides.linkFixes).map((key) => `linkFixes: ${key}`),
    ...Object.keys(overrides.internalIds).map((key) => `internalIds: ${key}`),
    ...Object.keys(overrides.extensions).map((key) => `extensions: ${key}`),
    ...Object.keys(overrides.stationMaxLevel).map((key) => `stationMaxLevel: ${key}`),
    ...Object.keys(overrides.notYetAvailable).map((key) => `notYetAvailable: ${key}`),
    ...Object.keys(overrides.yields).map((key) => `yields: ${key}`),
    ...Object.keys(overrides.steps).map((key) => `steps: ${key}`),
    ...Object.keys(overrides.listStations).map((key) => `listStations: ${key}`),
    ...Object.keys(overrides.upgradeStations).map((key) => `upgradeStations: ${key}`),
    ...Object.keys(overrides.obtain).map((key) => `obtain: ${key}`),
    ...(overrides.trophies.page ? [`trophies: ${overrides.trophies.page}`] : []),
  ];
  for (const name of named) if (!ctx.applied.has(name)) staleOverride(ctx, name);
}

function reportOf(ctx: Ctx, graph: RecipeGraph): AssemblyReport {
  const planned = new Set(graph.recipes.filter((r) => r.quality === 1 && !r.alt).map((r) => r.product));
  const inputs = new Set(graph.recipes.flatMap((r) => r.inputs.map(([id]) => id)));
  const stations = new Map(graph.items.filter((i) => i.station).map((i) => [i.id, i.station!.maxLevel]));
  const ids = new Set(graph.items.map((item) => item.id));

  // A step past its station's highest level is a contradiction to settle,
  // unless the overrides say the game has no such level yet: the step is
  // the wiki's, kept as stated, and listed apart as one nobody can make.
  const levelConflicts: GraphReport['levelConflicts'] = [];
  const unavailable: AssemblyReport['unavailable'] = [];
  for (const recipe of graph.recipes) {
    const stated = recipe.station === null ? undefined : stations.get(recipe.station);
    if (stated === undefined || recipe.stationLevel <= stated) continue;
    const conflict = { station: recipe.station!, stated, required: recipe.stationLevel, from: recipe.from };
    const notYet = ctx.overrides.notYetAvailable[conflict.station];
    if (notYet) {
      unavailable.push(conflict);
      apply(ctx, `notYetAvailable: ${conflict.station}`, notYet.reason);
    } else {
      levelConflicts.push(conflict);
    }
  }
  // Last, once every override has had its chance to apply.
  sweepOverrides(ctx);

  return {
    items: graph.items.length,
    recipes: graph.recipes.length,
    products: new Set(graph.recipes.map((r) => r.product)).size,
    raw: [...inputs].filter((id) => !planned.has(id)).length,
    unresolved: [...ctx.unresolved.values()].sort(
      (a, b) => b.count - a.count || compare(a.text, b.text) || compare(a.from, b.from),
    ),
    cycles: cyclesOf(graph),
    levelConflicts,
    duplicates: ctx.duplicates,
    yieldSuspects: ctx.yieldSuspects,
    applied: [...ctx.applied.values()],
    notes: ctx.notes,
    // Only conflicts the graph shows: two pages the graph leaves out may share an ID harmlessly.
    idConflicts: ctx.idConflicts.filter((c) => ids.has(c.id) || ids.has(c.as)),
    unavailable,
    costConflicts: ctx.costConflicts,
    overruled: ctx.overruled,
    costSuspects: ctx.costSuspects,
  };
}

/**
 * The cycles the maths would meet: groups of items whose planned recipes
 * (quality 1, no alternative) end up needing one another, an item that
 * needs itself included. Tarjan's strongly connected components.
 */
function cyclesOf(graph: RecipeGraph): ItemId[][] {
  const edges = new Map<ItemId, ItemId[]>();
  for (const recipe of graph.recipes) {
    if (recipe.quality === 1 && !recipe.alt) edges.set(recipe.product, recipe.inputs.map(([id]) => id));
  }
  const index = new Map<ItemId, number>();
  const low = new Map<ItemId, number>();
  const stack: ItemId[] = [];
  const onStack = new Set<ItemId>();
  const cycles: ItemId[][] = [];

  const visit = (id: ItemId): void => {
    index.set(id, index.size);
    low.set(id, index.get(id)!);
    stack.push(id);
    onStack.add(id);
    for (const next of edges.get(id) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id)!, index.get(next)!));
      }
    }
    if (low.get(id) !== index.get(id)) return;
    const group: ItemId[] = [];
    let member: ItemId;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      group.push(member);
    } while (member !== id);
    if (group.length > 1 || (edges.get(id) ?? []).includes(id)) cycles.push(group.sort(compare));
  };
  for (const id of [...edges.keys()].sort(compare)) if (!index.has(id)) visit(id);
  return cycles.sort((a, b) => compare(a[0]!, b[0]!));
}

/* -------------------------------------------------------------------------- */
/* Version                                                                     */
/* -------------------------------------------------------------------------- */

/** The SHA-256 of the items and recipes as canonical JSON: the same content, the same version. */
function versionOf(items: GraphItem[], recipes: GraphRecipe[]): string {
  return createHash('sha256').update(canonicalJson({ items, recipes }), 'utf8').digest('hex');
}

/** JSON with every object's keys in order, so that how an object was built never changes its text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compare(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
