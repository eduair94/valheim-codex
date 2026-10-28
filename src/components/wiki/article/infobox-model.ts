import type { ArticleDoc, ArticleInfobox, InfoboxGroup, InfoboxTab } from '@/lib/wiki/article-types';
import { isRecipeLabel, parseRecipe } from '@/lib/wiki/recipe';
import { lineCuts, piecesOf } from './lines';

/**
 * Decisions about the infobox that do not need a browser: how each stat row
 * is laid out, which tabs are worth showing, and what kind of tabs they are.
 */

/**
 * Joins consecutive groups that share a heading.
 *
 * The wiki splits an infobox into a group per horizontal row, so an item's
 * stats arrive as four separate blocks all labelled "Properties". Rendering
 * them as-is repeats the heading down the page and puts every single-row group
 * in its own bordered box, which reads as noise rather than as structure.
 */
export function mergeGroups(groups: readonly InfoboxGroup[]): InfoboxGroup[] {
  const out: InfoboxGroup[] = [];
  for (const group of groups) {
    if (group.rows.length === 0) continue;
    const previous = out[out.length - 1];
    if (previous && previous.label === group.label) {
      previous.rows = [...previous.rows, ...group.rows];
      continue;
    }
    out.push({ label: group.label, rows: [...group.rows] });
  }
  return out;
}

/**
 * A stat row is either a label with its value beside it, or a label with the
 * value underneath.
 *
 * Beside, the value is monospaced and right-aligned, so digits line up down
 * the column; that only works for a short value. A sentence right-aligned in
 * a narrow column is unreadable, and a long label beside even a short value
 * used to push the value out of a clipped box altogether: "Teletransportable
 * (¿Puede pasar por un portal de madera?)" hid its "No" on every phone
 * (LM-01). So the label and the value are weighed together.
 */
export type StatLayout = 'inline' | 'stacked';

/*
 * Measured, not guessed. A stat row is about 300px of text on a 360px phone
 * and 326px in the desktop infobox column; the value may take 60% of it, and
 * a monospaced character at 13px is about 7.8px wide. So about 22 characters
 * fit beside the label on one line; a longer value ("2.46 s (0.86 + 0.70 +
 * 0.90)") wrapped right-aligned inside its 60%, which reads worse than the
 * same value set under its label.
 */

/** Past this, a value is a phrase and belongs under its label. */
const INLINE_VALUE = 22;
/** Label and value together past this would leave the label three lines deep. */
const INLINE_ROW = 60;
/** A value of a few short lines ("21 (0 skill)", "31.5 (100 skill)") still fits beside its label. */
const INLINE_LINES = 3;
const INLINE_LINE = 16;

/** A value's entries as they are displayed: one per line, older "; " joins included (`lineCuts`). */
export function valueLines(value: string): string[] {
  return piecesOf(value, lineCuts(value, 'value')).filter(Boolean);
}

export function statLayout(label: string, value: string): StatLayout {
  const lines = valueLines(value);
  if (lines.length > 1) {
    const compact = lines.length <= INLINE_LINES && lines.every((line) => line.length <= INLINE_LINE);
    return compact && label.length <= 28 ? 'inline' : 'stacked';
  }
  const text = lines[0] ?? '';
  if (text.length > INLINE_VALUE) return 'stacked';
  return label.trim().length + text.length > INLINE_ROW ? 'stacked' : 'inline';
}

/** Tabs that hold something to show. A tab with no rows is a dead control. */
export function usefulTabs(tabs: readonly InfoboxTab[]): InfoboxTab[] {
  return tabs.filter((tab) => tab.groups.some((group) => group.rows.length > 0));
}

/**
 * What a set of infobox tabs stands for.
 *
 * - `levels`: an item's upgrade levels, all numbers ("1 2 3 4").
 * - `stars`: a creature's star levels, usually with its trophy alongside
 *   ("0★ 1★ 2★ Trophy"). Labelled "upgrade levels" with a crafting-station
 *   hint, they told the reader a troll is upgraded at a forge (BWR-11).
 * - `variants`: anything else ("Raw / Cooked"), which has no hint to give.
 */
export type TabSetKind = 'levels' | 'stars' | 'variants';

const STAR = /★|\bstars?\b/i;

export function tabSetKind(labels: readonly string[]): TabSetKind {
  if (labels.length > 0 && labels.every((label) => /^\d+$/.test(label.trim()))) return 'levels';
  if (labels.some((label) => STAR.test(label))) return 'stars';
  return 'variants';
}

/** `0★`, `2 ★`, `1 Star`: the star count, or null when the label is not a star level. */
export function starCount(label: string): number | null {
  const match = /^(\d+)\s*(?:★|stars?)$/i.exec(label.trim());
  return match ? Number(match[1]) : null;
}

/**
 * How the article sits on a wide screen (1024px and up).
 *
 * - `single`: no infobox; the text has the whole width.
 * - `side`: the infobox is a column beside the text, kept in view while the
 *   text scrolls when it fits the window. Right when there is more text than
 *   stats: a creature, a biome, a mechanic.
 * - `spread`: the infobox comes first, its groups in three columns, and the
 *   text follows across the whole width. Right when the stats are most of
 *   the article — a sword's forty rows beside two sentences and an upgrade
 *   table left a column of empty page as tall as the screen, twice over.
 *
 * Decided from the content, on the server, so the page never changes layout
 * after it is drawn. The weights are rough heights in stat rows (~38px).
 */
export type ArticleLayout = 'single' | 'side' | 'spread';

/** A sentence of prose is about this many characters to a line at the reading measure. */
const LINE_CHARS = 85;
/** One line of prose, in stat rows. */
const LINE_UNITS = 0.7;

function proseUnits(text: string): number {
  const lines = valueLines(text).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / LINE_CHARS)), 0);
  return lines * LINE_UNITS + 0.4;
}

/** The infobox as shown on first view: the common rows and the first tab's. */
export function infoboxUnits(infobox: ArticleInfobox): number {
  const tabs = usefulTabs(infobox.tabs);
  const groups = mergeGroups([...infobox.common, ...(tabs[0]?.groups ?? [])]);
  let units = tabs.length > 1 ? 3 : 0;
  for (const group of groups) {
    units += group.label ? 1.5 : 0.5;
    for (const row of group.rows) {
      if (isRecipeLabel(row.label)) {
        units += 1 + Math.ceil(parseRecipe(row.value).length / 2) * 1.6;
      } else if (statLayout(row.label, row.value) === 'stacked') {
        units += 0.6 + proseUnits(row.value) * 0.8;
      } else {
        units += 1;
      }
    }
  }
  return units;
}

/** The text below the identity strip: lead, blocks and pictures. */
export function bodyUnits(doc: ArticleDoc): number {
  let units = doc.lead ? proseUnits(doc.lead) : 0;
  let section = '';
  for (const block of doc.blocks) {
    if (block.section && block.section !== section) {
      section = block.section;
      units += 1.5;
    }
    if (block.kind === 'paragraph') units += proseUnits(block.text);
    else if (block.kind === 'list') units += block.items.reduce((sum, item) => sum + proseUnits(item), 0);
    else units += 1.5 + block.rows.length;
  }
  if (doc.images.length > 0) units += 1 + Math.ceil(Math.min(doc.images.length, 12) / 3) * 5;
  return units;
}

/** An infobox shorter than this always fits beside the text. */
const SMALL_INFOBOX = 24;
/** The infobox spreads out once it is this much taller than the text beside it. */
const SPREAD_RATIO = 1.5;

export function articleLayout(doc: ArticleDoc, infobox: ArticleInfobox | null): ArticleLayout {
  if (!infobox) return 'single';
  const aside = infoboxUnits(infobox);
  if (aside <= SMALL_INFOBOX) return 'side';
  return aside > bodyUnits(doc) * SPREAD_RATIO ? 'spread' : 'side';
}
