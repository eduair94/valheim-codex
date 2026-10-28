import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { inlineText, lineText } from './dom-text';
import { ingredientKey, isRecipeLabel, isWholeRecipe, parseRecipeCell } from './recipe';
import { isTabber, tabberPanels } from './tabber';
import { cleanText } from './text';

/**
 * Every recipe a page states, read from its HTML at ingest.
 *
 * The reading document (article.ts) is built for reading, and on the way it
 * lets go of what a crafting planner needs:
 *
 *   - the links. A recipe cell is `<a href="/wiki/Bronze_nails">Bronze
 *     nails</a> x80`, and the link is what names the material exactly: by
 *     text, "Mead base: Poison resistance" or "Cooked deer meat" find no
 *     article, while their links reach one through the wiki's redirects;
 *   - every infobox but the first. A mead's page also states its base, a
 *     meat's page its cooked form, an armor set's page every piece, each in
 *     an infobox of its own;
 *   - the yield, `<b>Crafts 20</b>` before the list, without which a Karve's
 *     80 nails cost 80 bronze instead of 4.
 *
 * So the extractor reads the same HTML again, for recipes only, and keeps
 * what the wiki wrote, as written: link titles as the links name them,
 * stations as text, quantities per level. Nothing is resolved, corrected or
 * defaulted here; that is the recipe graph's job, once every page has been
 * read and the redirects are known. A cell that cannot be read is kept as a
 * note, never guessed at, so the graph's report can show it.
 *
 * What it reads:
 *
 *   - each `aside.portable-infobox`: its title, internal ID and Source, and
 *     per quality tab ("1".."4") the crafting level, the yield and the
 *     materials; a station's Max Level and Improvements; an extension's
 *     "Upgrades X";
 *   - the tables that are the only record of what something costs: on a
 *     list page, which has no infobox of its own, the tables of building
 *     pieces (Wood Structures, Banners, Chairs…), about 185 of which have no
 *     article; on a station's page, its table of extensions, the only place
 *     the Artisan press's recipe is stated;
 *   - the food table's station, station level and multiplier, which state a
 *     cauldron level the foods' own infoboxes leave out.
 *
 * What it leaves out: tables of things that are carried rather than built.
 * Each of those things has an article that states its recipe (the Crafting
 * page's inventory recipes, the feasts, the trinkets), except the six colored
 * fireworks of the Fireworks page. That table names no station, and beside
 * their materials it gives the basic firework's price in coins at Hildir's;
 * read as rows of building pieces, it would say what the wiki does not. The
 * six are the graph's to state, in its overrides, which can say where they
 * are made.
 */

type Api = cheerio.CheerioAPI;

/**
 * A link as the wiki wrote it, from its `href`: `/wiki/Smith%27s_anvil` is
 * "Smith's anvil", `/wiki/Deer_Meat#Cooked` is "Deer Meat" with the fragment
 * "Cooked". `text` is what the link shows, which can be another name
 * altogether ("Ancient skulls" for Giant remains).
 */
export type RawLink = { title: string; fragment: string | null; text: string };

/** One material: its name as the cell writes it, how many, and where it links. */
export type RawEntry = { text: string; qty: number; link: RawLink | null };

/**
 * One quality level's recipe: the cost of the step to this level alone (an
 * Iron Sword's level 2 is 1 Wood, 10 Iron and 2 Leather scraps, not the sum
 * so far), the crafting level it needs, and how many one craft makes when
 * the wiki says. A null yield means the wiki said nothing; it is not 1.
 */
export type RawLevel = {
  quality: number;
  stationLevel: number | null;
  yield: number | null;
  entries: RawEntry[];
};

export type RawInfobox = {
  /** The infobox's own title: "Mead base: Poison resistance" on Poison Resistance Mead. */
  title: string;
  /**
   * Null for the page's own infobox; otherwise the label of the tab that
   * shows this one on the page ("Mead base", "Cooked", "Unbaked", "Helmet").
   * An infobox in no tab is named by its place on the page ("2"). Unique on
   * the page, so page and tab identify an infobox even when its title is
   * the page's own (the Anti-Sting Concoction's mead base is titled
   * "Anti-Sting Concoction").
   */
  tab: string | null;
  /** The game's ID, `SwordIron`; null when the cell names several or none. */
  internalId: string | null;
  /** Where it comes from: the station, or a creature, deposit, trader or place. */
  source: { text: string; links: RawLink[] } | null;
  /** Quality tabs "1".."N", or one level when untabbed; only levels that name a material. */
  levels: RawLevel[];
  /** A station's highest level. */
  maxLevel: number | null;
  /** A station's extensions, in the order the wiki lists them. */
  improvements: RawLink[];
  /** An extension: the station it raises ("Upgrades Forge"). */
  upgrades: RawLink | null;
  /**
   * Cells, or lines of them, that could not be read; the graph's report
   * shows them. One from a quality tab starts with its number ("Quality 4:
   * Wood x3, Iron x30"): a level nobody could read is still a level the wiki
   * states, and without its number the item would look one level short.
   */
  notes: string[];
};

/**
 * A row of a table that states what a thing costs, under the heading the
 * table sits in: a building piece on a list page ("Floors and stairs"), or
 * an extension in its station's table ("Upgrades", where the wiki's
 * redirect for the Artisan press points). `notes` are what its materials
 * cell says that is not a material, as on an infobox.
 */
export type RawListRow = { name: string; entries: RawEntry[]; anchor: string | null; notes: string[] };

/**
 * A food in the food table: its station as written, the station's level,
 * and how many one craft makes.
 */
export type RawFoodRow = {
  item: RawLink;
  station: string | null;
  stationLevel: number | null;
  multiplier: number | null;
};

export type PageRecipes = { infoboxes: RawInfobox[]; listRows: RawListRow[]; foodRows: RawFoodRow[] };

/**
 * Reads the recipes a page states.
 *
 * `page` gives the page's title. It decides which of several infoboxes is
 * the page's own: on a meat or a mead it is the first, titled like the page;
 * on an armor set none is, because the page describes a set and every
 * infobox is a piece. And it names the page a self-link points at: the
 * Cooked egg is made from `<strong class="mw-selflink selflink">Egg</strong>`,
 * the Egg page's own name with no `href`.
 *
 * It is required so that a caller cannot leave it out by accident: the
 * ingest has the title of every page it reads. `null` says there is none,
 * as for a piece of HTML in a test. The first infobox is then taken for the
 * page's own, which is right on every page of the wiki but the 16 armor
 * sets, and a self-link links nowhere.
 */
export function extractRecipes(html: string, page: { title: string } | null): PageRecipes {
  const $ = cheerio.load(html);
  const doc: Doc = { $, title: page?.title ?? null };
  const asides = ($('aside.portable-infobox').toArray() as Element[]).filter(
    (aside) => $(aside).parents('aside.portable-infobox').length === 0,
  );
  const infoboxes = readInfoboxes(doc, asides);

  return {
    infoboxes,
    listRows: readListRows(doc, asides.length === 0 ? null : infoboxes),
    foodRows: readFoodRows(doc),
  };
}

/** The page being read: its document, and its title when the caller gave it. */
type Doc = { $: Api; title: string | null };

/* -------------------------------------------------------------------------- */
/* Infoboxes                                                                   */
/* -------------------------------------------------------------------------- */

/** A labelled value in an infobox, and the quality tab it sits in, if any. */
type Row = { label: string; value: Element; quality: number | null };

function readInfoboxes(doc: Doc, asides: Element[]): RawInfobox[] {
  const { $ } = doc;
  const titles = asides.map((aside) => cleanText($(aside).find('.pi-title').first().text()));
  const own = ownInfobox(titles, doc.title);
  const taken = new Set<string>();

  return asides.map((aside, i) => {
    const rows = boxRows($, aside);
    const notes: string[] = [];
    const { levels, stated } = readLevels(doc, rows, notes);
    return {
      title: titles[i] ?? '',
      tab: i === own ? null : uniqueTab(pageTab($, aside) ?? String(i + 1), taken),
      internalId: readInternalId(rows, stated, notes),
      source: readSource(doc, rows),
      levels,
      maxLevel: readMaxLevel(rows, notes),
      improvements: readImprovements(doc, rows, notes),
      upgrades: readUpgrades(doc, rows, notes),
      notes,
    };
  });
}

/**
 * Which infobox is the page's own, or -1 when none is.
 *
 * A page with one infobox is about what it describes, whatever its title
 * says. With several, the page's own is the one titled like the page, a
 * bracketed qualifier aside ("Item stand (vertical)" on Item Stand): the
 * rule the comparison tables use (`isOwnInfobox` in wiki-repo.ts). On the
 * 67 pages of the wiki with several infoboxes that is the first on 51, and
 * none on the 16 armor sets, whose helmet is no more the set than its legs.
 */
function ownInfobox(titles: string[], pageTitle: string | null): number {
  if (titles.length <= 1 || pageTitle === null) return 0;
  const name = (text: string): string => nameKey(text.replace(/\s*\([^)]*\)/g, ''));
  return titles.findIndex((title) => name(title) === '' || name(title) === name(pageTitle));
}

/** A name as names are compared: case, spacing and the shape of an apostrophe mean nothing. */
function nameKey(text: string): string {
  return ingredientKey(text.replace(/’/g, "'"));
}

/**
 * The label of the page's tab that shows this infobox ("Mead base"), or null
 * when it is in none. An unlabelled tab is named by its place.
 */
function pageTab($: Api, aside: Element): string | null {
  const panel = $(aside).closest('.wds-tab__content');
  const tabber = panel.parent().get(0) as Element | undefined;
  if (panel.length === 0 || !tabber || !isTabber(tabber)) return null;
  const tabs = tabberPanels($, tabber);
  const index = tabs.findIndex((tab) => tab.panel === panel.get(0));
  return tabs[index]?.label || String(index + 1);
}

/** `label`, or `label (2)`, `label (3)`… if another infobox on the page already has it. */
function uniqueTab(label: string, taken: Set<string>): string {
  let tab = label;
  for (let n = 2; taken.has(tab); n += 1) tab = `${label} (${n})`;
  taken.add(tab);
  return tab;
}

/**
 * The infobox's labelled values in document order: `.pi-data` pairs and the
 * columns of horizontal groups ("Crafting Level | Repair Level" over "2 |
 * 2"), each with the quality tab it sits in. Values of an infobox nested in
 * this one are its own, not this one's.
 */
function boxRows($: Api, aside: Element): Row[] {
  const rows: Row[] = [];
  for (const el of $(aside).find('.pi-data, table.pi-horizontal-group').toArray() as Element[]) {
    if ($(el).closest('aside.portable-infobox').get(0) !== aside) continue;
    const quality = qualityOf($, el, aside);

    if (el.tagName === 'table') {
      const labels = $(el).find('th.pi-data-label').toArray() as Element[];
      const values = $(el).find('td.pi-data-value').toArray() as Element[];
      labels.forEach((label, i) => {
        const value = values[i];
        if (value) rows.push({ label: inlineText(label), value, quality });
      });
      continue;
    }

    // The description has a value and no label; nothing here reads it.
    const label = $(el).children('.pi-data-label').get(0) as Element | undefined;
    const value = $(el).children('.pi-data-value').get(0) as Element | undefined;
    if (label && value) rows.push({ label: inlineText(label), value, quality });
  }
  return rows;
}

/**
 * The quality a value belongs to: the label of the numbered tab it sits in,
 * inside this infobox. Not every tabber in an infobox is levels: the
 * Cauldron's shows its pictures ("Icon", "Appearance"), a creature's its
 * stars, and their values belong to the infobox as a whole.
 */
function qualityOf($: Api, el: Element, aside: Element): number | null {
  let panel = $(el).closest('.wds-tab__content');
  while (panel.length > 0 && panel.closest('aside.portable-infobox').get(0) === aside) {
    const tabber = panel.parent().get(0) as Element | undefined;
    if (tabber && isTabber(tabber)) {
      const label = tabberPanels($, tabber).find((tab) => tab.panel === panel.get(0))?.label ?? '';
      if (/^\d+$/.test(label)) return Number(label);
    }
    panel = panel.parent().closest('.wds-tab__content');
  }
  return null;
}

const CRAFTING_LEVEL = /^crafting level$/i;

/**
 * The recipe of each quality level.
 *
 * An item with quality tabs states one recipe per tab, each the cost of
 * that step alone; an item without states one, which is quality 1. Only a
 * level that names a material becomes one: "n/a" is no recipe, and a cell
 * of notes is a recipe nobody could read, which the notes report.
 *
 * `stated` says whether any recipe cell said anything at all, for the notes
 * on cells that only matter on things that are made.
 */
function readLevels(doc: Doc, rows: Row[], notes: string[]): { levels: RawLevel[]; stated: boolean } {
  const recipeRows = rows.filter((row) => isRecipeLabel(row.label));
  const tabbed = recipeRows.some((row) => row.quality !== null);
  const levels: RawLevel[] = [];
  let stated = false;

  for (const row of recipeRows) {
    const cell = readCell(doc, row.value);
    if (cell.entries.length > 0 || cell.notes.length > 0 || cell.yield !== null) stated = true;
    notes.push(...cell.notes.map((note) => inQuality(row.quality, note)));
    if (cell.entries.length === 0) continue;

    // A recipe outside the tabs of an item that has them, or a second one
    // for the same level: which step it costs is anybody's guess, so it is
    // reported rather than given to a level.
    const quality = row.quality ?? (tabbed ? null : 1);
    if (quality === null || levels.some((level) => level.quality === quality)) {
      notes.push(inQuality(row.quality, cell.text));
      continue;
    }
    levels.push({
      quality,
      stationLevel: stationLevel(rows, quality, tabbed, notes),
      yield: cell.yield,
      entries: cell.entries,
    });
  }

  levels.sort((a, b) => a.quality - b.quality);
  return { levels, stated };
}

/**
 * A note as the report shows it: from a quality tab, it starts with the
 * tab's number. A tab whose recipe nobody could read is still a level the
 * wiki states, and the number is what tells the graph so; without it a
 * sword whose fourth tab is unreadable looks like a sword with three levels.
 */
function inQuality(quality: number | null, note: string): string {
  return quality === null ? note : `Quality ${quality}: ${note}`;
}

/**
 * The crafting level a quality needs: its tab's own "Crafting Level", or on
 * an item without tabs the one it states. "nil" (the Sparkler, the
 * console-only shields) says there is none. Some foods put the level in
 * Source instead ("Cauldron (level 3)"); Source is kept as written for the
 * graph to read.
 */
function stationLevel(rows: Row[], quality: number, tabbed: boolean, notes: string[]): number | null {
  const row =
    rows.find((r) => CRAFTING_LEVEL.test(r.label) && r.quality === quality) ??
    (tabbed ? undefined : rows.find((r) => CRAFTING_LEVEL.test(r.label) && r.quality === null));
  if (!row) return null;
  const text = lineText(row.value);
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^(nil|n\/?a|none|-+|—|–)?$/i.test(text)) notes.push(inQuality(row.quality, `Crafting Level: ${text}`));
  return null;
}

/**
 * The game's internal ID, when the cell names exactly one.
 *
 * Some cells name several: a Yuleklapp's three sizes, a deposit whole and
 * broken, a creature's variants. None of them is the infobox's one ID, so
 * there is none, and on something that is made that is worth a note.
 */
function readInternalId(rows: Row[], stated: boolean, notes: string[]): string | null {
  const row = rows.find((r) => /^internal id$/i.test(r.label));
  if (!row) return null;
  const text = lineText(row.value);
  if (/^[\w.-]+$/.test(text)) return text;
  if (stated && text) notes.push(`Internal ID: ${text}`);
  return null;
}

function readSource(doc: Doc, rows: Row[]): RawInfobox['source'] {
  const row = rows.find((r) => /^source$/i.test(r.label));
  if (!row) return null;
  const links: RawLink[] = [];
  for (const link of linksIn(doc, row.value)) {
    if (!links.some((l) => l.title === link.title && l.fragment === link.fragment)) links.push(link);
  }
  return { text: lineText(row.value), links };
}

function readMaxLevel(rows: Row[], notes: string[]): number | null {
  const row = rows.find((r) => /^max(imum)? level$/i.test(r.label));
  if (!row) return null;
  const text = lineText(row.value);
  if (/^\d+$/.test(text)) return Number(text);
  notes.push(`Max Level: ${text}`);
  return null;
}

/** A station's extensions, each a link; a line that links nowhere is a note. */
function readImprovements(doc: Doc, rows: Row[], notes: string[]): RawLink[] {
  const row = rows.find((r) => /^improvements?$/i.test(r.label));
  if (!row) return [];
  const lines = cellLines(doc, row.value);
  for (const line of lines) if (line.links.length === 0) notes.push(`Improvements: ${line.text}`);
  return lines.flatMap((line) => line.links);
}

/**
 * The station an extension raises: "Usage: Upgrades <a>Forge</a>". Every
 * other Usage ("Building", "Cooking station") says what a thing is for, not
 * what it upgrades.
 */
function readUpgrades(doc: Doc, rows: Row[], notes: string[]): RawLink | null {
  const row = rows.find((r) => /^usage$/i.test(r.label) && /^upgrades\b/i.test(lineText(r.value)));
  if (!row) return null;
  const link = linksIn(doc, row.value)[0] ?? null;
  if (!link) notes.push(`Usage: ${lineText(row.value)}`);
  return link;
}

/* -------------------------------------------------------------------------- */
/* Cells and links                                                            */
/* -------------------------------------------------------------------------- */

/** A recipe cell: its materials with their links, its yield, its notes, and its text. */
type Cell = { entries: RawEntry[]; yield: number | null; notes: string[]; text: string };

/**
 * Reads a recipe cell line by line, as parseRecipeCell reads text, keeping
 * the link each material names.
 *
 * A cell whose materials are not its whole recipe (`isWholeRecipe`) is kept
 * whole as one note, with no entries: the Pots' "Pot shard x3, x4, x5" beside
 * one Charcoal resin, or the Yuleklapp's three sizes under "Small:",
 * "Medium:" and "Large:", whose materials together would be a number nobody
 * stated. A remark in brackets stays a note beside the entries.
 */
function readCell(doc: Doc, value: Element): Cell {
  const lines = cellLines(doc, value);
  const cell: Cell = { entries: [], yield: null, notes: [], text: lines.map((line) => line.text).join('\n') };

  for (const line of lines) {
    const read = parseRecipeCell(line.text);
    if (read.yield !== null) {
      // As in parseRecipeCell: a second yield that disagrees is not chosen.
      if (cell.yield !== null && cell.yield !== read.yield) {
        cell.notes.push(line.text);
        continue;
      }
      cell.yield = read.yield;
    }
    // "Small: <a>Finewood</a> x2" is a size's heading and its material, not
    // one material named "Small: Finewood".
    if (read.entries.some((entry) => isHeaded(entry.name, line.links))) {
      cell.notes.push(line.text);
      continue;
    }
    for (const entry of read.entries) {
      cell.entries.push({ text: entry.name, qty: entry.qty, link: linkFor(entry.name, line.links) });
    }
    cell.notes.push(...read.notes);
  }

  if (cell.entries.length > 0 && !isWholeRecipe(cell)) {
    return { entries: [], yield: null, notes: [cell.text], text: cell.text };
  }
  return cell;
}

/**
 * The link a material names: the one on its line whose text is its name,
 * alone or with its count when the link wraps both ("<a>Wood x2</a>").
 *
 * On the wiki every linked material is linked by its whole name, the mead
 * bases' included ("Mead base: Poison resistance"). Any other link on the
 * line names something else, or a part of the name ("<a>Bronze</a> nails",
 * "<a>Mead base</a>: <a>Poison resistance</a>"), and taken for the material
 * it would make 80 Bronze nails 80 Bronze. A material with no link is still
 * found by its name, or reported when it cannot be; one linked to the wrong
 * page is a wrong recipe nobody is told about.
 */
function linkFor(name: string, links: RawLink[]): RawLink | null {
  const key = nameKey(name);
  const names = (link: RawLink): boolean => {
    if (nameKey(link.text) === key) return true;
    const wrapped = parseRecipeCell(link.text).entries;
    return wrapped.length === 1 && nameKey(wrapped[0]!.name) === key;
  };
  return links.find(names) ?? null;
}

/**
 * Whether a material's name is a heading run into the material it heads:
 * "Small: Finewood", where a link names "Finewood" and none names "Small".
 * Each of the Yuleklapp's three sizes written that way would otherwise be
 * one more Finewood in a single recipe; as a note, the cell is reported.
 * A name with a colon of its own is linked whole, or at least before it.
 */
function isHeaded(name: string, links: RawLink[]): boolean {
  const colon = name.indexOf(':');
  if (colon === -1) return false;
  const texts = links.map((link) => nameKey(link.text));
  return (
    texts.includes(nameKey(name.slice(colon + 1))) &&
    !texts.includes(nameKey(name.slice(0, colon))) &&
    !texts.includes(nameKey(name))
  );
}

/** Links, and the self-links MediaWiki writes for a link to the page it is on. */
const LINKS = 'a, .mw-selflink';

/**
 * Marks the start of a link in a line of text: its index between two
 * private-use characters, which no page of the wiki contains.
 */
const MARK_OPEN = String.fromCharCode(0xe000);
const MARK_CLOSE = String.fromCharCode(0xe001);
const LINK_MARK = new RegExp(`${MARK_OPEN}([0-9]+)${MARK_CLOSE}`, 'g');

/**
 * A cell's lines, as the reader shows them (one per `<br>`, list item or
 * block; see dom-text.ts), each with the links that start on it.
 *
 * Read by marking each link's start in a copy of the cell and then reading
 * the copy's lines, so the lines are the same ones every other reader of
 * the page gets.
 */
function cellLines(doc: Doc, value: Element): { text: string; links: RawLink[] }[] {
  const { $ } = doc;
  const copy = $(value).clone();
  const links: RawLink[] = [];
  for (const el of copy.find(LINKS).toArray() as Element[]) {
    const link = readLink(doc, el);
    if (!link) continue;
    $(el).prepend(`${MARK_OPEN}${links.length}${MARK_CLOSE}`);
    links.push(link);
  }
  const el = copy.get(0) as Element | undefined;
  if (!el) return [];

  return lineText(el)
    .split('\n')
    .map((line) => ({
      text: cleanText(line.replace(LINK_MARK, '')),
      links: [...line.matchAll(LINK_MARK)]
        .map((mark) => links[Number(mark[1])])
        .filter((link) => link !== undefined),
    }))
    .filter((line) => line.text);
}

/** Every link in an element, in order. */
function linksIn(doc: Doc, el: Element): RawLink[] {
  return (doc.$(el).find(LINKS).toArray() as Element[]).flatMap((a) => readLink(doc, a) ?? []);
}

/** Namespaces whose pages are not things: files, categories, templates, talk. */
const NAMESPACE =
  /^(file|image|media|category|special|template|help|user|talk|mediawiki|module|forum|message wall|user blog|blog|board|thread|project|valheim wiki)(\s+talk)?:/i;

/** `/wiki/Title#Fragment`, on this wiki, with a query when the page does not exist yet. */
const WIKI_HREF = /^(?:https?:\/\/valheim\.fandom\.com)?\/wiki\/([^?#]+)(?:\?[^#]*)?(?:#(.*))?$/i;

/**
 * A link to a page of this wiki, read from its `href`: the title as the link
 * names it, with underscores as spaces and escapes decoded. The link's text
 * is often another name for the same thing ("Bronze nails" for Bronze
 * Nails, "Ancient skulls" for Giant remains), and the target is what the
 * wiki means. A picture's link points at the picture, and is not one.
 *
 * A self-link has no `href`; it is the page's own title, when that is known.
 */
function readLink(doc: Doc, el: Element): RawLink | null {
  const { $ } = doc;
  const text = cleanText(inlineText(el));
  if ($(el).hasClass('mw-selflink')) return doc.title ? { title: doc.title, fragment: null, text } : null;

  const match = WIKI_HREF.exec(el.attribs['href'] ?? '');
  if (!match || $(el).find('img').length > 0) return null;
  const title = decodeTitle(match[1] ?? '');
  if (!title || NAMESPACE.test(title)) return null;
  return { title, fragment: decodeTitle(match[2] ?? '') || null, text };
}

/** `Smith%27s_anvil` → "Smith's anvil". A broken escape is kept as written rather than thrown on. */
function decodeTitle(part: string): string {
  let text = part;
  try {
    text = decodeURIComponent(part);
  } catch {
    // Not valid percent-encoding: the wiki's own text is the best there is.
  }
  return text.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

/** No real table is wider; a typo like `colspan=200` must not allocate a huge grid. */
const MAX_COLUMNS = 40;

/**
 * Columns only a placed piece has: its size, how it stands, what it
 * stores, what rain does to it, its `piece_` ID. A table of materials
 * without any lists things carried rather than built, and every one on the
 * wiki has an article of its own: the Crafting page's inventory recipes, the
 * Odin Set, the feasts, the trinkets.
 */
const PIECE_COLUMN = /^(size|durability|support|loss|comfort|storage|damaged by rain\??|internal id)$/i;

/**
 * A table's header labels and its body rows as cells by column, laid out the
 * way the browser draws them: a cell spanning rows or columns fills every
 * slot it covers, so the materials of a row are under "Materials" even when
 * a cell to their left spans two rows. The same placement as the reader's
 * tables (`readTableGrid` in table.ts), keeping the cells rather than their
 * text, since the links are in the cells.
 *
 * The header is the first row of nothing but `th`; null when there is none.
 */
function tableCells($: Api, table: Element): { header: string[]; rows: (Element | undefined)[][] } | null {
  const trs = ($(table).children('tr, thead, tbody, tfoot').toArray() as Element[]).flatMap((child) =>
    child.tagName === 'tr' ? [child] : ($(child).children('tr').toArray() as Element[]),
  );
  const span = (value: string | undefined, max: number): number => {
    const n = Number.parseInt(value ?? '', 10);
    return Number.isFinite(n) && n >= 1 ? Math.min(n, Math.max(1, max)) : 1;
  };

  const slots: (Element | undefined)[][] = trs.map(() => []);
  trs.forEach((tr, r) => {
    let c = 0;
    for (const cell of $(tr).children('th, td').toArray() as Element[]) {
      while (slots[r]![c]) c += 1;
      if (c >= MAX_COLUMNS) break;
      const rowspan = span(cell.attribs['rowspan'], trs.length - r);
      const colspan = span(cell.attribs['colspan'], MAX_COLUMNS - c);
      for (let dr = 0; dr < rowspan; dr += 1) {
        for (let dc = 0; dc < colspan; dc += 1) slots[r + dr]![c + dc] = cell;
      }
      c += colspan;
    }
  });

  const allHeader = (tr: Element): boolean => {
    const cells = $(tr).children('th, td').toArray() as Element[];
    return cells.length > 0 && cells.every((cell) => cell.tagName === 'th');
  };
  const headerRow = trs.findIndex(allHeader);
  if (headerRow === -1) return null;

  return {
    header: Array.from(slots[headerRow]!, (cell) => (cell ? cleanText(inlineText(cell)) : '')),
    rows: slots.filter((_, r) => r > headerRow && !allHeader(trs[r]!)),
  };
}

/** The last row of a table, summing the others: "Total (Forge included)". */
const TOTAL = /^total\b/i;

/** A table of things and their materials: its header, the heading it sits under, and its rows. */
type ListTable = { header: string[]; anchor: string | null; rows: { name: string; materials: Element }[] };

/**
 * The rows of the tables that are the only record of what a thing costs:
 * "Wood floor 1x1" for 1 Wood, under "Floors and stairs".
 *
 * On a list page (no infobox, `infoboxes` null) they are the tables of
 * building pieces, told by their columns: something only a piece has
 * (PIECE_COLUMN). A page with an infobox is about one thing, and its tables
 * of materials are about others that state their own recipes (what a
 * material goes into, an armor set's total), with one exception: a
 * station's table of extensions. The Artisan press has no page, and the
 * wiki's redirect for it points at that table ("Artisan press" → "Artisan
 * Table#Upgrades"). It is told by its rows, which name the station's
 * Improvements; the extensions that have a page of their own are stated
 * there too, and the graph prefers that.
 */
function readListRows(doc: Doc, infoboxes: RawInfobox[] | null): RawListRow[] {
  const improvements = infoboxes?.find((box) => box.tab === null)?.improvements ?? [];
  if (infoboxes !== null && improvements.length === 0) return [];
  const extensions = new Set(improvements.flatMap((link) => [nameKey(link.title), nameKey(link.text)]));
  const qualifies = (table: ListTable): boolean =>
    infoboxes === null
      ? table.header.some((label) => PIECE_COLUMN.test(label))
      : table.rows.some((row) => extensions.has(nameKey(row.name)));

  return listTables(doc)
    .filter(qualifies)
    .flatMap((table) =>
      table.rows.flatMap((row) => {
        const cell = readCell(doc, row.materials);
        // A row whose materials cell says nothing states no recipe.
        if (cell.entries.length === 0 && cell.notes.length === 0) return [];
        return [{ name: row.name, entries: cell.entries, anchor: table.anchor, notes: cell.notes }];
      }),
    );
}

/**
 * The page's tables of things and their materials, each row a name and its
 * materials cell. The name is the first column that is neither the picture
 * nor the materials. A row that sums the others is no thing of its own.
 */
function listTables(doc: Doc): ListTable[] {
  const { $ } = doc;
  const tables: ListTable[] = [];
  for (const table of $('table').toArray() as Element[]) {
    const grid = tableCells($, table);
    if (!grid) continue;
    const materials = grid.header.findIndex((label) => isRecipeLabel(label));
    const name = grid.header.findIndex((label, i) => i !== materials && !/^(icon|image|picture)$/i.test(label));
    if (materials === -1 || name === -1) continue;

    const rows: ListTable['rows'] = [];
    for (const cells of grid.rows) {
      const nameCell = cells[name];
      const materialsCell = cells[materials];
      const text = nameCell ? cleanText(inlineText(nameCell)) : '';
      if (text && materialsCell && !TOTAL.test(text)) rows.push({ name: text, materials: materialsCell });
    }
    tables.push({ header: grid.header, anchor: sectionOf($, table), rows });
  }
  return tables;
}

/**
 * The heading a table sits under: the nearest one before it, looking past
 * the wrappers it may be inside. Its words, as the page shows them, without
 * the edit link.
 */
function sectionOf($: Api, el: Element): string | null {
  for (let node: Element | null = el; node && node.type === 'tag'; node = node.parent as Element | null) {
    for (let prev = node.prev; prev; prev = prev.prev) {
      if (prev.type !== 'tag') continue;
      const tag = prev as Element;
      const heading = /^h[2-6]$/i.test(tag.tagName)
        ? tag
        : $(tag).hasClass('mw-heading')
          ? ($(tag).children('h2, h3, h4, h5, h6').get(0) as Element | undefined)
          : undefined;
      if (!heading) continue;
      const headline = $(heading).find('.mw-headline').first();
      const text = cleanText(
        headline.length > 0 ? headline.text() : $(heading).clone().find('.mw-editsection').remove().end().text(),
      );
      if (text) return text;
    }
  }
  return null;
}

/**
 * The food table's rows: each food's station as written ("Cauldron",
 * "Cooking station", "Food preparation table + Stone Oven"), the station's
 * level from "Cauldron (5)", and the multiplier, which is how many one craft
 * makes. A station in brackets alone, "(Meadows)", is where a raw food is
 * found, not a station.
 */
function readFoodRows(doc: Doc): RawFoodRow[] {
  const { $ } = doc;
  const out: RawFoodRow[] = [];
  for (const table of $('table').toArray() as Element[]) {
    // Most pages have dozens of tables and none of them is this one; the
    // header cells say so before any grid is laid out.
    const isFood = $(table)
      .find('th')
      .toArray()
      .some((th) => /^crafting multiplier$/i.test(cleanText($(th).text())));
    const grid = isFood ? tableCells($, table) : null;
    if (!grid) continue;
    const station = grid.header.findIndex((label) => /^crafting station$/i.test(label));
    const multiplier = grid.header.findIndex((label) => /^crafting multiplier$/i.test(label));
    if (station === -1 || multiplier === -1) continue;
    const name = Math.max(0, grid.header.findIndex((label) => /^name$/i.test(label)));

    for (const cells of grid.rows) {
      // A food with no link has no page, and so no infobox for this row to correct.
      const nameCell = cells[name];
      const item = nameCell ? (linksIn(doc, nameCell)[0] ?? null) : null;
      if (!item) continue;

      const stationCell = cells[station];
      const lines = stationCell ? lineText(stationCell).split('\n') : [];
      const foundIn = lines.length > 0 && lines.every((line) => /^\(.*\)$/.test(line));
      const text = foundIn ? '' : lines.join(' ');
      const level = /\s*\((?:level\s*)?(\d+)\)$/i.exec(text);
      const multiplierCell = cells[multiplier];
      const count = multiplierCell ? /^[x×]?\s*(\d+)$/i.exec(cleanText(inlineText(multiplierCell))) : null;

      out.push({
        item,
        station: (level ? text.slice(0, level.index) : text).trim() || null,
        stationLevel: level ? Number(level[1]) : null,
        multiplier: count ? Number(count[1]) : null,
      });
    }
  }
  return out;
}
