import type * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import type { NoticeKind } from './article-types';
import { inlineText, lineText } from './dom-text';

type Api = cheerio.CheerioAPI;

/**
 * Reads an HTML table the way a browser lays it out.
 *
 * Reading cells by position, which is what this replaced, is only right for
 * tables without spans, and the wiki's best tables are full of them:
 *
 *   - a `rowspan=2` header over a second header row ("Average per Tree" over
 *     G1, G2, Y1, Y2) lost the second row, leaving four blank column labels;
 *   - a `colspan=2` "Total" cell pushed the totals one column left, under
 *     "Name", and left "Materials" empty;
 *   - rows of `th` cells after the header were silently skipped, so a
 *     planting table listed only the biomes a tree does *not* grow in;
 *   - an icon column, empty once its image is gone, became the row heading
 *     of every card on a phone: a blank title bar per row.
 *
 * So the table is first expanded into the grid of slots the browser draws,
 * and everything else — headers, rows, which columns are worth keeping — is
 * decided on that grid.
 */

export type TableGrid = {
  caption: string;
  /** One label per column; stacked header rows are joined with ' › '. Empty when the table has no header. */
  headers: string[];
  /** Rectangular rows. Cells keep their line breaks as `\n`. */
  rows: string[][];
  /** Indices into `rows` of full-width group headings; their text sits in cell 0. */
  groupRows: number[];
};

type Cell = {
  el: Element;
  isHeader: boolean;
  row: number;
  col: number;
  rowspan: number;
  colspan: number;
  /** Body reading: one line per `<br>` or block. */
  text: string;
  /** Header reading: one line. */
  label: string;
  /** Names of the items pictured, for a cell that is only pictures. */
  pictured: string[];
};

/** No real table is wider; a typo like `colspan=200` must not allocate a huge grid. */
const MAX_COLUMNS = 40;

/** Separates the levels of a stacked header: "Average per Tree › G1". */
export const HEADER_SEPARATOR = ' › ';

/** A cell value that is a quantity, not a label. */
const NUMERIC = /^[-+]?[\d.,]+\s*%?$/;

/** The first cell of a row that sums up the rows above it. */
const SUMMARY = /^(total|sum|overall|average)\b/i;

function span(value: string | undefined, max: number): number {
  // parseInt rather than Number: the wiki has `colspan="2""` in at least one
  // table, and the browser reads that as 2.
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, Math.max(1, max));
}

/** The table's own rows, in order, never those of a table nested in a cell. */
function ownRows($: Api, table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of $(table).children().toArray() as Element[]) {
    const tag = child.tagName?.toLowerCase();
    if (tag === 'tr') rows.push(child);
    else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      rows.push(...($(child).children('tr').toArray() as Element[]));
    }
  }
  return rows;
}

const isTable = (el: Element): boolean => el.tagName?.toLowerCase() === 'table';

/**
 * What the pictures in a cell show, by their alt text or the title of the link
 * around them: the wiki's item icons are alt-texted with the item's name.
 */
function picturedNames($: Api, cell: Element): string[] {
  const names = ($(cell).find('img').toArray() as Element[]).map((img) => {
    const alt = img.attribs['alt'] ?? '';
    const title = $(img).closest('a').attr('title') ?? '';
    return (alt || title).replace(/\.(png|jpe?g|gif|webp|svg)$/i, '').replace(/\s+/g, ' ').trim();
  });
  return [...new Set(names.filter(Boolean))];
}

/**
 * Tables sitting in this table's cells.
 *
 * The wiki uses an outer table as layout — two columns, "Level 1-50" and
 * "Level 51-100", each holding the real table. Reading the outer table's rows
 * deeply used to splice both inner tables into it under the wrong headers;
 * they are read as tables of their own instead, and the outer cells skip them.
 */
export function nestedTables($: Api, table: Element): Element[] {
  return ($(table).find('table').toArray() as Element[]).filter(
    (inner) => $(inner).parents('table').first().get(0) === table,
  );
}

/** The header text above the cell that holds `inner`, to caption a nested table with. */
export function nestedTableLabel($: Api, table: Element, inner: Element): string {
  const holder = $(inner).closest('td, th').get(0) as Element | undefined;
  if (!holder) return '';
  const index = $(holder).index();
  const first = ownRows($, table)[0];
  if (!first || $(holder).parent().get(0) === first) return '';
  const label = ($(first).children('th, td').toArray() as Element[])[index];
  return label?.tagName?.toLowerCase() === 'th' ? inlineText(label) : '';
}

const isBold = (el: Element): boolean => ['b', 'strong'].includes(el.tagName?.toLowerCase() ?? '');

/**
 * Whether the first row of a table without `th` cells is its header.
 *
 * Such a row has to look set apart from the rows below it, the way the
 * wiki's plain tables set theirs: every cell bold ("Type | Drops | Notes"),
 * mostly capitals ("NAME | SOURCE | CRAFT LEVEL"), no digits over rows that
 * have them ("Armor | Health Lost" over "10 | 30"), or a row of levels
 * ("Quality | 1 | 2 | 3"). Each of the 13 such tables in a 416-page sample of
 * the wiki has a header, and each shows one of these; a first row that shows
 * none is read as data.
 */
function looksLikeHeader(cells: Cell[], below: Cell[][]): boolean {
  const filled = cells.filter((cell) => cell.label);
  if (filled.length === 0 || filled.some((cell) => cell.label.length > 80)) return false;

  const bold = filled.every((cell) => inlineText(cell.el, { skip: (el) => isBold(el) || isTable(el) }) === '');

  const worded = filled.map((cell) => cell.text.split('\n')[0] ?? '').filter((line) => /\p{L}/u.test(line));
  const capitals = worded.filter((line) => line === line.toUpperCase()).length * 2 > worded.length;

  const digits = (cell: Cell): boolean => /\d/.test(cell.text);
  const rows = below.filter((row) => row.some((cell) => cell.text));
  const numbersBelow =
    !filled.some(digits) && rows.length > 0 && rows.filter((row) => row.some(digits)).length * 2 >= rows.length;

  const steps = cells.slice(1).map((cell) => cell.label);
  const start = Number(steps[0]);
  const levels =
    steps.length >= 2 && (start === 0 || start === 1) && steps.every((label, i) => label === String(start + i));

  return bold || capitals || numbersBelow || levels;
}

/**
 * Expands a `<table>` into a rectangular grid of text.
 *
 * Returns null for a table with no body rows: a header on its own says
 * nothing a reader can use.
 */
export function readTableGrid($: Api, table: Element): TableGrid | null {
  const trs = ownRows($, table);
  if (trs.length === 0) return null;

  /* 1. Place every cell on the grid, the way the browser does. */
  const slots: (Cell | undefined)[][] = trs.map(() => []);
  const starting: Cell[][] = trs.map(() => []);

  trs.forEach((tr, r) => {
    let c = 0;
    for (const el of $(tr).children('th, td').toArray() as Element[]) {
      while (slots[r]![c]) c += 1;
      if (c >= MAX_COLUMNS) break;

      const rowspan = span(el.attribs['rowspan'], trs.length - r);
      const colspan = span(el.attribs['colspan'], MAX_COLUMNS - c);
      const text = lineText(el, { skip: isTable });
      const cell: Cell = {
        el,
        isHeader: el.tagName?.toLowerCase() === 'th',
        row: r,
        col: c,
        rowspan,
        colspan,
        text,
        label: inlineText(el, { skip: isTable }),
        pictured: text ? [] : picturedNames($, el),
      };
      for (let dr = 0; dr < rowspan; dr += 1) {
        for (let dc = 0; dc < colspan; dc += 1) slots[r + dr]![c + dc] = cell;
      }
      starting[r]!.push(cell);
      c += colspan;
    }
  });

  const width = Math.max(0, ...slots.map((row) => row.length));
  if (width === 0) return null;

  const allHeader = (r: number): boolean =>
    starting[r]!.length > 0 && starting[r]!.every((cell) => cell.isHeader);
  const fullWidth = (r: number): Cell | null => {
    const cells = starting[r]!;
    const only = cells[0];
    return cells.length === 1 && only && only.colspan >= width && width > 1 ? only : null;
  };
  /** Labels of the cells that start in row `r`, by column. */
  const rowLabels = (r: number): string[] =>
    Array.from({ length: width }, (_, c) => {
      const cell = slots[r]![c];
      return cell && cell.row === r && cell.col === c ? cell.label : '';
    });

  const captionEl = $(table).children('caption').get(0);
  let caption = captionEl ? inlineText(captionEl) : '';
  let first = 0;

  /*
   * 2. A lone full-width `th` above everything else is the table's title
   * ("Creature Feeding Habit"), not a label for every column.
   */
  const title = trs.length > 1 ? fullWidth(0) : null;
  if (title?.isHeader) {
    caption = caption ? `${caption} — ${title.label}` : title.label;
    first = 1;
  }

  /*
   * 3. Header rows: the first all-`th` row, plus each following all-`th` row
   * that is a further level of it — one that a header cell above reaches
   * down into (`rowspan`), or one that labels the parts of a header cell
   * above that spans columns (G1, G2, Y1, Y2 under "Average per Tree") and
   * says nothing under the columns that were not split. Any other `th` row
   * is data: "Black Forest | Yes" under "Meadows | Yes" is the second biome,
   * and "Meadows | 1 | 2" under "Biome | Comfort" (two columns) is the first.
   * Read as one more level of header, every `th` row under a spanning cell
   * was, until no row was left and the table vanished.
   */
  let headerRows: number[] = [];
  const splitsAbove = (r: number): boolean => {
    let split = false;
    for (const cell of starting[r]!) {
      const above = slots[r - 1]![cell.col];
      if (above && above.colspan > 1 && headerRows.includes(above.row)) {
        if (cell.col > above.col) split = true;
      } else if (cell.label) {
        return false;
      }
    }
    return split;
  };
  if (first < trs.length && allHeader(first)) {
    headerRows.push(first);
    for (let r = first + 1; r < trs.length && allHeader(r); r += 1) {
      // "One-handed" across the whole table is a group heading, whatever spans sit above it.
      if (fullWidth(r)) break;
      const spannedInto = slots[r]!.some((cell) => cell && cell.row < r && headerRows.includes(cell.row));
      if (!spannedInto && !splitsAbove(r)) break;
      headerRows.push(r);
    }
    // A header never takes every row: rows a tall first cell reaches down
    // into are data under that first row when nothing follows them.
    if (headerRows.at(-1) === trs.length - 1) headerRows = [first];
  }

  /*
   * 4. `th` rows after a data row. One that repeats a header row is a long
   * table re-stating its columns, and is skipped. One shaped like a plain
   * one-row header — as many cells, no spans — means that first row was
   * never a header: the planting tables mark each biome a tree grows in with
   * `th`, so "Meadows | Yes" is a biome like the "Plains | Yes" below it.
   * Nothing else says anything about the top of the table: a "Total" row
   * closes it, and a header with spans or several rows is a header.
   */
  const signatures = headerRows.map(rowLabels);
  const repeatsHeader = (r: number): boolean =>
    signatures.some((signature) => rowLabels(r).every((label, i) => label === signature[i]));
  const plain = (cells: Cell[]): boolean => cells.every((cell) => cell.colspan === 1 && cell.rowspan === 1);
  const lone = headerRows.length === 1 ? starting[headerRows[0]!]! : null;
  if (lone && plain(lone)) {
    let seenData = false;
    for (let r = headerRows[0]! + 1; r < trs.length; r += 1) {
      const cells = starting[r]!;
      if (cells.length === 0) continue;
      if (!allHeader(r)) {
        seenData = true;
        continue;
      }
      if (!seenData || repeatsHeader(r) || SUMMARY.test(cells[0]!.label)) continue;
      if (cells.length === lone.length && plain(cells)) {
        headerRows = [];
        break;
      }
    }
  }

  /*
   * 5. A table with no `th` at all may state its header as a first row of
   * ordinary cells ("Creature | Required love points | …"), or have none and
   * start with data ("Boar | Meadows | Carrot"). Promoting data would pair
   * every value with the wrong label — the index would say that a wolf's
   * "Meadows" is "Mountain" — so the row is promoted only when it looks set
   * apart from the rows below (see looksLikeHeader), and never when it reads
   * as a key and its value.
   */
  const hasTh = starting.some((cells) => cells.some((cell) => cell.isHeader));
  if (headerRows.length === 0 && !hasTh && trs.length - first >= 2) {
    const labels = rowLabels(first);
    const keyValue = width === 2 && NUMERIC.test(labels[1] ?? '');
    if (!keyValue && looksLikeHeader(starting[first]!, starting.slice(first + 1))) headerRows = [first];
  }

  const bodyStart = headerRows.length > 0 ? headerRows.at(-1)! + 1 : first;
  const headerLabels = Array.from({ length: width }, (_, c) => {
    const labels: string[] = [];
    for (const r of headerRows) {
      const label = slots[r]![c]?.label ?? '';
      if (label && labels.at(-1) !== label) labels.push(label);
    }
    return labels.join(HEADER_SEPARATOR);
  });

  /*
   * 6. Body rows. Each cell that covers the row, with the text it shows
   * there. A cell that is only a list of pictures shows the names of what it
   * pictures — the Weapons table lists every axe as an icon and nothing else
   * — unless the row already says those names. A lone icon is the row's own
   * picture: its alt text is either the name beside it or a file name ("Crow
   * 0S" on the deer), and in both cases the column is better dropped.
   */
  type BodyRow = { group: Cell | null; cells: Cell[]; texts: Map<Cell, string> };
  const body: BodyRow[] = [];
  for (let r = bodyStart; r < trs.length; r += 1) {
    if (headerRows.length > 0 && allHeader(r) && repeatsHeader(r)) continue;
    const cells = [...new Set(slots[r]!.filter((cell): cell is Cell => Boolean(cell)))];
    const said = cells.map((cell) => cell.text.toLowerCase()).join('\n');
    const texts = new Map<Cell, string>();
    for (const cell of cells) {
      const pictured =
        cell.pictured.length > 1 ? cell.pictured.filter((name) => !said.includes(name.toLowerCase())) : [];
      texts.set(cell, cell.text || pictured.join('\n'));
    }
    if (![...texts.values()].some(Boolean)) continue;
    // In a one-column table every row spans it, so only a `th` there is a
    // heading: Hugin's lines, each under the event that prompts it.
    const group = fullWidth(r) ?? (width === 1 && allHeader(r) ? starting[r]![0]! : null);
    body.push({ group: group && group.rowspan === 1 ? group : null, cells, texts });
  }
  // A table of nothing but full-width rows is a list of notes, not groups.
  if (body.every((row) => row.group)) for (const row of body) row.group = null;
  if (body.length === 0) return null;

  /*
   * 7. Columns worth keeping: those where some row has text that starts in
   * that column and stays in it. Judging by spanning cells too would keep an
   * icon column alive just because a "Total" cell starts there and runs on
   * into "Name" — and every card would keep its blank title.
   */
  const keep = new Array<boolean>(width).fill(false);
  for (const row of body) {
    if (row.group) continue;
    for (const cell of row.cells) if (cell.colspan === 1 && row.texts.get(cell)) keep[cell.col] = true;
  }
  // A spanning cell over columns that are empty everywhere else keeps its
  // first column rather than vanishing with them.
  for (const row of body) {
    if (row.group) continue;
    for (const cell of row.cells) {
      if (cell.colspan > 1 && row.texts.get(cell) && !keep.slice(cell.col, cell.col + cell.colspan).some(Boolean)) {
        keep[cell.col] = true;
      }
    }
  }
  const kept = keep.flatMap((k, c) => (k ? [c] : []));
  if (kept.length === 0) return null;

  /* 8. Assemble, moving a spanning cell's text to the first column it still covers. */
  const rows: string[][] = [];
  const groupRows: number[] = [];
  for (const row of body) {
    const out = new Array<string>(kept.length).fill('');
    if (row.group) {
      out[0] = row.group.text;
      groupRows.push(rows.length);
      rows.push(out);
      continue;
    }
    for (const cell of row.cells) {
      const text = row.texts.get(cell);
      const target = kept.findIndex((c) => c >= cell.col && c < cell.col + cell.colspan);
      if (text && target !== -1) out[target] = text;
    }
    if (out.some(Boolean)) rows.push(out);
  }
  if (rows.length === groupRows.length) return null;

  /*
   * 9. A blank row heading under a filled one means "same as above": the
   * spawn table names a biome once and leaves it blank for the next five
   * places in it. Each row gets its heading — a card on a phone, or a row in
   * the index, is read without the one above it. Only when the table starts
   * with a heading, so a table whose first column is simply sparse is left as
   * it is.
   */
  const dataRows = rows.filter((_, i) => !groupRows.includes(i));
  if (dataRows[0]?.[0]) {
    let previous = '';
    rows.forEach((row, i) => {
      if (groupRows.includes(i)) {
        previous = '';
        return;
      }
      if (!row[0] && previous) row[0] = previous;
      previous = row[0] ?? '';
    });
  }

  const headers = kept.map((c) => headerLabels[c] ?? '');
  return {
    caption,
    // A header whose every kept label is blank says nothing; leave it out
    // rather than have a renderer draw an empty bar.
    headers: headers.some(Boolean) ? headers : [],
    rows,
    groupRows,
  };
}

/* -------------------------------------------------------------------------- */
/* Notice banners                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A Fandom notice banner: "This article is a work in progress", "This page
 * is a candidate for deletion", "This article is about removed content".
 *
 * They are styled one-row tables with no class, so no selector catches them,
 * and read as data they became a two-column table with invented headers at
 * the top of 33 articles — which also pushed the real opening paragraph out
 * of the lead slot, leaving those articles with no summary at all.
 *
 * Some are about editing the wiki and mean nothing to a player (kind
 * `maintenance`: drop them). The rest say something true about the game — the
 * thing cannot be obtained, was removed, is paid for or is not out yet — and
 * stay, as text.
 */
export type Notice = { kind: NoticeKind | 'maintenance'; text: string };

const NOTICE_OPENING = /^This (article|page|section)\b/i;

const NOTICE_KINDS: { pattern: RegExp; kind: NoticeKind | 'maintenance' }[] = [
  { pattern: /work in progress|\bstub\b|candidate for deletion|disambiguation|clean-?up/i, kind: 'maintenance' },
  { pattern: /\bunfinished\b/i, kind: 'unfinished' },
  { pattern: /\bremoved\b/i, kind: 'removed' },
  { pattern: /\bDLC\b/, kind: 'dlc' },
  { pattern: /\b(upcoming|planned)\b/i, kind: 'upcoming' },
];

export function readNotice($: Api, table: Element): Notice | null {
  const rows = ownRows($, table);
  if (rows.length !== 1) return null;
  const cells = $(rows[0]!).children('th, td').toArray() as Element[];
  if (cells.length === 0 || cells.length > 2) return null;

  // The banner is an icon cell and a text cell; the text is the last one.
  const lines = lineText(cells.at(-1)!).split('\n').filter(Boolean);
  const heading = lines[0] ?? '';
  if (!NOTICE_OPENING.test(heading)) return null;

  const kind = NOTICE_KINDS.find((k) => k.pattern.test(heading))?.kind ?? 'other';
  // The heading has no full stop of its own (the banner sets it in bold), so
  // without one a renderer that joins the lines reads "…removed content This
  // page describes…".
  const opening = /[.!?:]$/.test(heading) ? heading : `${heading}.`;
  return { kind, text: [opening, ...lines.slice(1)].join('\n') };
}
