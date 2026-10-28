import type { GraphItem, GraphRecipe, ItemId, ItemKind, Obtain, RecipeGraph, RecipeMethod } from './types';

/**
 * The recipe graph as the planner downloads it: all of it, in one payload the
 * service worker keeps for offline use.
 *
 * As objects, every item and recipe repeats every key, and the recipes repeat
 * the item ids. Here an item is a tuple, a recipe points at items by their
 * position in the list, the steps of one product share a group, and what the
 * payload can rebuild exactly is left out: an id of the form `page:<slug>`,
 * a slug that is the English name made into a slug, an icon file named after
 * the English name, a provenance that is the product's own name. The encoder
 * only leaves a field out when rebuilding it gives back the same string, so
 * the round trip is exact.
 *
 * Measured on the prototype graph from the live wiki, converted to these
 * types (656 items, 955 recipes): 42.0 KB as objects and 24.9 KB this way,
 * gzipped at level 6, which is what the server sends (zlib's default); the
 * prototype's own arrays were 26.8 KB. The planner's budget is 30 KB. With
 * 152 building pieces from the list tables added it is 29.0 KB, and that
 * graph still lacked about 33 pieces and a Spanish name on 293 of its 808
 * items: complete, it comes to about 32 KB. What brings it under is what
 * the planner downloads anyway: the title index carries the icon and the
 * Spanish name of every item with an article, 4.8 and 3.8 KB of this.
 *
 * A layout is a version (`v`). Changing what a position means, a code in the
 * tables below, or how a left-out field is rebuilt makes a new version:
 * browsers keep the payload for days and must never read a new layout with
 * old code, nor an old one with new code.
 */

/**
 * An item: `[id, en, kind, maxQuality, slug, es, icon, anchor, aliases,
 * station, extends, obtain]`, cut after the last field it has.
 *
 * - `id`: 0 when it is `page:<slug>` or `page:<slug>#<anchor>`.
 * - `slug`: 0 when it has none, 1 when it is the English name made into a
 *   slug (`slugOfName`).
 * - `icon`: `*` in place of the file name when the file is the English name
 *   with underscores, `.png` (`Iron_Sword.png`).
 * - `station`: `[maxLevel, ...extension positions]`.
 * - `extends`: the station's position; -1 for none.
 * - Any other field: 0 when absent.
 */
export type WireItem = [
  id: string | 0,
  en: string,
  kind: number,
  maxQuality: number,
  slug?: string | 0 | 1,
  es?: string | 0,
  icon?: string | 0,
  anchor?: string | 0,
  aliases?: string[] | 0,
  station?: number[] | 0,
  extendsStation?: number,
  obtain?: WireObtain[] | 0,
];

/**
 * One way a material is had: `[how, from, extra]`. For a purchase `from` is
 * the trader and `extra` the price in coins; otherwise `from` lists the
 * sources and `extra`, when present, is the tool: the position of its item,
 * or its id where the graph has no item for it.
 */
export type WireObtain = [how: number, from: string[] | string, extra?: number | string];

/**
 * One step of a product: `[quality, stationLevel, inputs, yield, fuel, alt,
 * yieldKnown]`, cut after the last field that is not its default (yield 1,
 * no fuel, no alternative number, a known yield). `inputs` and `fuel` hold
 * item positions and quantities, inputs flat: `[position, qty, position, qty]`.
 */
export type WireStep = [
  quality: number,
  stationLevel: number,
  inputs: number[],
  yieldPerCraft?: number,
  fuel?: [number, number] | 0,
  alt?: number,
  yieldKnown?: 0 | 1,
];

/**
 * Consecutive recipes that share a product, a provenance, a method and a
 * station: `[product, from, method, station, ...steps]`. An item with four
 * quality steps is one group. `from` is 0 when it is the product's English
 * name; `station` is -1 for a recipe made by hand.
 */
export type WireGroup = [product: number, from: string | 0, method: number, station: number, ...steps: WireStep[]];

export type WireGraph = { v: 1; version: string; builtAt: string; i: WireItem[]; r: WireGroup[] };

/** A payload that is not a recipe graph this code can read. */
export class GraphShapeError extends Error {
  constructor(problem: string) {
    super(`Recipe graph: ${problem}`);
    this.name = 'GraphShapeError';
  }
}

function fail(problem: string): never {
  throw new GraphShapeError(problem);
}

/**
 * The codes kinds, methods and ways of obtaining travel as. Records, so a
 * value added to the types without a code fails to compile. Part of the
 * layout: add new codes after the last, never renumber one.
 */
const KIND_CODES: Record<ItemKind, number> = { item: 0, piece: 1, station: 2, extension: 3, virtual: 4 };
const METHOD_CODES: Record<RecipeMethod, number> = {
  craft: 0,
  build: 1,
  smelt: 2,
  cook: 3,
  bake: 4,
  brew: 5,
  ferment: 6,
  refine: 7,
  mill: 8,
  spin: 9,
  kiln: 10,
  prepare: 11,
};
const OBTAIN_CODES: Record<Obtain['how'], number> = { drop: 0, mine: 1, chop: 2, gather: 3, fish: 4, loot: 5, farm: 6, buy: 7 };

/**
 * A name's code, for the encoder. Only the table's own names: a kind called
 * `toString` must fail, not travel as a function.
 */
function codeOf<T extends string>(codes: Record<T, number>, name: T, problem: string): number {
  if (!Object.hasOwn(codes, name)) fail(problem);
  return codes[name];
}

/** A code table read the other way round, for the decoder. */
function byCode<T extends string>(codes: Record<T, number>): T[] {
  const names: T[] = [];
  for (const [name, code] of Object.entries(codes) as [T, number][]) names[code] = name;
  return names;
}
const KINDS = byCode(KIND_CODES);
const METHODS = byCode(METHOD_CODES);
const HOWS = byCode(OBTAIN_CODES);

/** No item: a recipe made by hand, an item that extends no station. */
const NONE = -1;
/** An icon whose file is named after the item, with the file name left out. */
const NAMED_FILE = '*';
/** Where an icon path keeps its file name: after the last slash before the query. */
const ICON_FILE = /^([^?]*\/)([^/?]+)(\?.*)?$/;

/**
 * `Iron Sword` → `iron-sword`, the way the site makes slugs from titles.
 *
 * A copy rather than an import of `slugify`, because it is part of this
 * layout: a payload cached before a deploy that changed the site's slugs
 * must still decode to the slugs it was encoded with.
 */
function slugOfName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** The id a page or a place on a page stands for, where the wiki gives no internal ID. */
function pageId(slug: string, anchor: string | undefined): ItemId {
  return anchor === undefined ? `page:${slug}` : `page:${slug}#${anchor}`;
}

/** The icon file an item named `en` usually has: `Iron Sword` → `Iron_Sword.png`. */
function iconFileOf(en: string): string {
  return `${en.replaceAll(' ', '_')}.png`;
}

/** Drops trailing fields that hold their default, so a tuple ends at its last real field. */
function cut<T extends unknown[]>(tuple: T, defaults: readonly unknown[], keep: number): T {
  while (tuple.length > keep && tuple[tuple.length - 1] === defaults[tuple.length - 1]) tuple.pop();
  return tuple;
}
const ITEM_DEFAULTS = [null, null, null, null, 0, 0, 0, 0, 0, 0, NONE, 0];
const STEP_DEFAULTS = [null, null, null, 1, 0, NONE, 1];

/**
 * The graph as compact arrays.
 *
 * Throws `GraphShapeError` for a graph it cannot write exactly or that
 * `decodeGraph` would refuse: two items with one id, a recipe naming an item
 * the graph lacks, a kind or method with no code, a level or quality that is
 * not a whole number, a quantity that is NaN or negative, a name that is not
 * text. Every value is checked as the decoder checks it, because the route
 * lets caches keep the payload for days: a graph no reader could decode
 * must fail here, while the server can still answer that it has none. (A
 * NaN from a cell the wiki left as "nil" is a null once stored.) The
 * structure, which the types give and storage keeps, is not checked again.
 */
export function encodeGraph(graph: RecipeGraph): WireGraph {
  if (graph.v !== 1) fail(`shape version ${JSON.stringify(graph.v)}, this code writes 1`);
  const positions = new Map<ItemId, number>();
  graph.items.forEach((item, i) => {
    const id = text(item.id, `the id of item ${i}`);
    if (positions.has(id)) fail(`two items are ${id}`);
    positions.set(id, i);
  });

  const groups: WireGroup[] = [];
  let open: { recipe: GraphRecipe; group: WireGroup } | null = null;
  for (const recipe of graph.recipes) {
    const step = encodeStep(recipe, positions);
    if (
      open &&
      open.recipe.product === recipe.product &&
      open.recipe.from === recipe.from &&
      open.recipe.method === recipe.method &&
      open.recipe.station === recipe.station
    ) {
      open.group.push(step);
      continue;
    }
    const product = positionOf(positions, recipe.product, 'a recipe');
    const from = text(recipe.from, `the provenance of ${recipe.product}`);
    const group: WireGroup = [
      product,
      from === graph.items[product]!.en ? 0 : from,
      codeOf(METHOD_CODES, recipe.method, `${recipe.product} is made by an unknown method ${recipe.method}`),
      recipe.station === null ? NONE : positionOf(positions, recipe.station, `the station of ${recipe.product}`),
      step,
    ];
    groups.push(group);
    open = { recipe, group };
  }

  return {
    v: 1,
    version: text(graph.version, 'the version'),
    builtAt: text(graph.builtAt, 'the build time'),
    i: graph.items.map((item) => encodeItem(item, positions)),
    r: groups,
  };
}

type Positions = ReadonlyMap<ItemId, number>;

/** Where an item sits in the list: how the payload points at it. */
function positionOf(positions: Positions, id: ItemId, where: string): number {
  const position = positions.get(id);
  if (position === undefined) fail(`${where} names ${id}, which is not an item`);
  return position;
}

function encodeItem(item: GraphItem, positions: Positions): WireItem {
  const en = text(item.en, `the name of ${item.id}`);

  let slug: string | 0 | 1 = 0;
  if (item.slug !== undefined) {
    const value = text(item.slug, `the slug of ${item.id}`);
    slug = value === slugOfName(en) ? 1 : value;
  }

  let icon: string | 0 = 0;
  if (item.icon !== undefined) {
    const path = text(item.icon, `the icon of ${item.id}`);
    const parts = ICON_FILE.exec(path);
    // A path whose file is literally `*` would read back as a named file. No
    // wiki image is called that, so it is refused rather than mangled.
    if (parts?.[2] === NAMED_FILE) fail(`${item.id} has an icon with no file name`);
    icon = parts && parts[2] === iconFileOf(en) ? `${parts[1]}${NAMED_FILE}${parts[3] ?? ''}` : path;
  }

  const tuple: WireItem = [
    item.slug !== undefined && item.id === pageId(item.slug, item.anchor) ? 0 : item.id,
    en,
    codeOf(KIND_CODES, item.kind, `${item.id} is of an unknown kind ${item.kind}`),
    count(item.maxQuality, `the quality of ${item.id}`),
    slug,
    item.es === undefined ? 0 : text(item.es, `the Spanish name of ${item.id}`),
    icon,
    item.anchor === undefined ? 0 : text(item.anchor, `the anchor of ${item.id}`),
    item.aliases === undefined ? 0 : list(item.aliases, `the aliases of ${item.id}`).map((a) => text(a, `an alias of ${item.id}`)),
    item.station === undefined
      ? 0
      : [
          count(item.station.maxLevel, `the levels of ${item.id}`),
          ...item.station.extensions.map((id) => positionOf(positions, id, `an extension of ${item.id}`)),
        ],
    item.extends === undefined ? NONE : positionOf(positions, item.extends, `the station ${item.id} extends`),
    item.obtain === undefined ? 0 : item.obtain.map((way) => encodeObtain(way, item.id, positions)),
  ];
  return cut(tuple, ITEM_DEFAULTS, 4);
}

function encodeObtain(way: Obtain, owner: ItemId, positions: Positions): WireObtain {
  const how = codeOf(OBTAIN_CODES, way.how, `${owner} is had in an unknown way ${way.how}`);
  if (way.how === 'buy') return [how, text(way.from, `the trader of ${owner}`), count(way.coins, `the price of ${owner}`)];
  const sources = list(way.from, `where ${owner} comes from`).map((s) => text(s, `a source of ${owner}`));
  if (way.how === 'drop' || way.tool === undefined) return [how, sources];
  // A tool the graph has no item for still travels, by its id: it is a hint
  // for the reader, and nothing is computed from it.
  const tool = text(way.tool, `the tool for ${owner}`);
  return [how, sources, positions.get(tool) ?? tool];
}

function encodeStep(recipe: GraphRecipe, positions: Positions): WireStep {
  const quality = count(recipe.quality, `a quality of ${recipe.product}`);
  const where = `${recipe.product} at quality ${quality}`;
  if (typeof recipe.yieldKnown !== 'boolean') fail(`whether the yield of ${where} is known`);
  const step: WireStep = [
    quality,
    count(recipe.stationLevel, `the station level of ${where}`),
    recipe.inputs.flatMap(([id, qty]) => [positionOf(positions, id, `an input of ${where}`), amount(qty, `an input of ${where}`)]),
    amount(recipe.yield, `the yield of ${where}`),
    recipe.fuel === undefined
      ? 0
      : [positionOf(positions, recipe.fuel[0], `the fuel of ${where}`), amount(recipe.fuel[1], `the fuel of ${where}`)],
    recipe.alt === undefined ? NONE : count(recipe.alt, `the alternative number of ${where}`),
    recipe.yieldKnown ? 1 : 0,
  ];
  return cut(step, STEP_DEFAULTS, 3);
}

/**
 * Reads a payload back into the graph, checking it on the way: whatever
 * arrives (a truncated cache entry, a payload from a newer server, a server
 * bug) either becomes a whole, consistent graph or throws `GraphShapeError`.
 * A planner computing from a half-read graph would show wrong numbers.
 */
export function decodeGraph(wire: unknown): RecipeGraph {
  if (typeof wire !== 'object' || wire === null || Array.isArray(wire)) fail('not an object');
  const payload = wire as Record<string, unknown>;
  if (payload.v !== 1) fail(`shape version ${JSON.stringify(payload.v)}, this code reads 1`);
  const version = text(payload.version, 'the version');
  const builtAt = text(payload.builtAt, 'the build time');
  const rawItems = list(payload.i, 'the items');
  const rawGroups = list(payload.r, 'the recipes');

  // Ids first: items point at each other by position (extensions, tools).
  const tuples = rawItems.map((raw, i) => tuple(raw, `item ${i}`, 4, ITEM_DEFAULTS.length));
  const ids = tuples.map((t, i) => decodeId(t, i));
  const seen = new Set<ItemId>();
  for (const id of ids) {
    if (seen.has(id)) fail(`two items are ${id}`);
    seen.add(id);
  }
  const idAt = (value: unknown, where: string): ItemId => {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= ids.length) fail(`${where} points at no item`);
    return ids[value as number]!;
  };

  const items = tuples.map((t, i) => decodeItem(t, ids[i]!, idAt));
  const recipes: GraphRecipe[] = [];
  rawGroups.forEach((raw, g) => {
    const group = tuple(raw, `recipe group ${g}`, 5, Infinity);
    const product = idAt(group[0], `recipe group ${g}`);
    const from = group[1] === 0 ? items[group[0] as number]!.en : text(group[1], `the provenance of ${product}`);
    const method = METHODS[count(group[2], `the method of ${product}`)] ?? fail(`${product} is made by an unknown method`);
    const station = group[3] === NONE ? null : idAt(group[3], `the station of ${product}`);
    for (const rawStep of group.slice(4)) {
      recipes.push(decodeStep(rawStep, { product, from, method, station }, idAt));
    }
  });

  return { v: 1, version, builtAt, items, recipes };
}

function decodeId(t: unknown[], i: number): ItemId {
  if (t[0] !== 0) return text(t[0], `the id of item ${i}`);
  // A left-out id is the page (and place on it) the item stands for.
  const slug = t[4];
  if (typeof slug !== 'string' && slug !== 1) fail(`item ${i} has neither an id nor a page`);
  const en = text(t[1], `the name of item ${i}`);
  const anchor = t[7] === undefined || t[7] === 0 ? undefined : text(t[7], `the anchor of item ${i}`);
  return pageId(slug === 1 ? slugOfName(en) : slug, anchor);
}

function decodeItem(t: unknown[], id: ItemId, idAt: (value: unknown, where: string) => ItemId): GraphItem {
  const field = (k: number): unknown => (k < t.length ? t[k] : ITEM_DEFAULTS[k]);
  const en = text(field(1), `the name of ${id}`);
  const item: GraphItem = {
    id,
    en,
    kind: KINDS[count(field(2), `the kind of ${id}`)] ?? fail(`${id} is of an unknown kind`),
    maxQuality: count(field(3), `the quality of ${id}`),
  };

  const es = field(5);
  if (es !== 0) item.es = text(es, `the Spanish name of ${id}`);
  const aliases = field(8);
  if (aliases !== 0) item.aliases = list(aliases, `the aliases of ${id}`).map((a) => text(a, `an alias of ${id}`));
  const slug = field(4);
  if (slug !== 0) item.slug = slug === 1 ? slugOfName(en) : text(slug, `the slug of ${id}`);
  const anchor = field(7);
  if (anchor !== 0) item.anchor = text(anchor, `the anchor of ${id}`);
  const icon = field(6);
  if (icon !== 0) {
    const path = text(icon, `the icon of ${id}`);
    const parts = ICON_FILE.exec(path);
    item.icon = parts?.[2] === NAMED_FILE ? `${parts[1]}${iconFileOf(en)}${parts[3] ?? ''}` : path;
  }

  const station = field(9);
  if (station !== 0) {
    const [maxLevel, ...extensions] = list(station, `the station of ${id}`);
    item.station = {
      maxLevel: count(maxLevel, `the levels of ${id}`),
      extensions: extensions.map((e) => idAt(e, `an extension of ${id}`)),
    };
  }
  const extendsStation = field(10);
  if (extendsStation !== NONE) item.extends = idAt(extendsStation, `the station ${id} extends`);
  const obtain = field(11);
  if (obtain !== 0) item.obtain = list(obtain, `how ${id} is had`).map((way) => decodeObtain(way, id, idAt));
  return item;
}

function decodeObtain(raw: unknown, owner: ItemId, idAt: (value: unknown, where: string) => ItemId): Obtain {
  const [code, from, extra] = tuple(raw, `how ${owner} is had`, 2, 3);
  const how = HOWS[count(code, `how ${owner} is had`)] ?? fail(`${owner} is had in an unknown way`);
  if (how === 'buy') return { how, from: text(from, `the trader of ${owner}`), coins: count(extra, `the price of ${owner}`) };
  const sources = list(from, `where ${owner} comes from`).map((s) => text(s, `a source of ${owner}`));
  if (extra === undefined) return { how, from: sources };
  if (how === 'drop') fail(`${owner} is dropped with a tool`);
  return { how, from: sources, tool: typeof extra === 'string' ? extra : idAt(extra, `the tool for ${owner}`) };
}

function decodeStep(
  raw: unknown,
  group: Pick<GraphRecipe, 'product' | 'from' | 'method' | 'station'>,
  idAt: (value: unknown, where: string) => ItemId,
): GraphRecipe {
  const t = tuple(raw, `a step of ${group.product}`, 3, STEP_DEFAULTS.length);
  const field = (k: number): unknown => (k < t.length ? t[k] : STEP_DEFAULTS[k]);
  const quality = count(field(0), `a quality of ${group.product}`);
  const where = `${group.product} at quality ${quality}`;

  const flat = list(field(2), `the inputs of ${where}`);
  if (flat.length % 2 !== 0) fail(`the inputs of ${where} are not pairs`);
  const inputs: [ItemId, number][] = [];
  for (let k = 0; k < flat.length; k += 2) inputs.push([idAt(flat[k], `an input of ${where}`), amount(flat[k + 1], `an input of ${where}`)]);

  const known = field(6);
  if (known !== 0 && known !== 1) fail(`whether the yield of ${where} is known`);
  const recipe: GraphRecipe = {
    product: group.product,
    quality,
    station: group.station,
    stationLevel: count(field(1), `the station level of ${where}`),
    yield: amount(field(3), `the yield of ${where}`),
    yieldKnown: known === 1,
    inputs,
    method: group.method,
    from: group.from,
  };
  const alt = field(5);
  if (alt !== NONE) recipe.alt = count(alt, `the alternative number of ${where}`);
  const fuel = field(4);
  if (fuel !== 0) {
    const [fuelItem, perCraft] = tuple(fuel, `the fuel of ${where}`, 2, 2);
    recipe.fuel = [idAt(fuelItem, `the fuel of ${where}`), amount(perCraft, `the fuel of ${where}`)];
  }
  return recipe;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} is not text`);
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail(`${what} is not a list`);
  return value;
}

/** A list of a known length: a tuple from this layout, or from a newer one this code must not misread. */
function tuple(value: unknown, what: string, min: number, max: number): unknown[] {
  const t = list(value, what);
  if (t.length < min || t.length > max) fail(`${what} has ${t.length} fields`);
  return t;
}

/** A whole number from 0 up: a level, a quality, a code, a price. */
function count(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(`${what} is not a whole number`);
  return value as number;
}

/** A quantity: any finite number from 0 up. */
function amount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${what} is not a quantity`);
  return value;
}
