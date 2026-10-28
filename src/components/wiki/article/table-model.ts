import type { TableBlock } from '@/lib/wiki/article-types';
import { lineCuts, piecesOf } from './lines';

/**
 * What an article table needs decided before it is drawn.
 *
 * The stored table is a grid of strings; how each column should behave is a
 * property of what is in it, and only the whole column says so. A column of
 * quantities wants tabular figures on one line, so the digits line up; a
 * column of sentences wants to wrap at a reading width, because forced onto
 * one line it became a 2,000px strip that hid every other column (DET-02).
 * The first column is the row's name; pinned while the rest scrolls it keeps
 * the row identifiable, but only while it is short — a pinned column wider
 * than its scroller covers every other column at every scroll position
 * (LD-01).
 *
 * Two document shapes reach this (see `article-types.ts`): rows the current
 * parser built, and older rows that still carry empty icon columns, invented
 * "Column N" headings and unmarked sub-heading rows. Both come out the same.
 */

/** How a column's cells behave on a wide screen. */
export type ColumnKind =
  /** Quantities: monospaced, tabular figures, never broken. */
  | 'number'
  /** Names and short values: kept on one line. */
  | 'short'
  /** Phrases: may wrap, at their natural width. */
  | 'text'
  /** Sentences: wrap at a reading width, between a floor and a ceiling. */
  | 'long';

export type TableColumn = {
  /** The column's heading, or '' when the table states none. */
  label: string;
  kind: ColumnKind;
  /**
   * The heading is too long for the label column of a phone card, where it
   * would wrap into a tall narrow stack beside its value. Such a field puts
   * its label on a line of its own instead.
   */
  wideLabel: boolean;
};

export type TableRowModel =
  /** A full-width sub-heading ("10 of the following:"). */
  | { kind: 'group'; text: string }
  /** One cell per kept column; cell 0 is the row's heading. */
  | { kind: 'row'; cells: string[] };

export type TableModel = {
  caption: string;
  /** Kept columns, in order. Column 0 heads each row. */
  columns: TableColumn[];
  /** Whether the table states column headings at all. */
  hasHeader: boolean;
  rows: TableRowModel[];
  /** The row headings are short enough to pin while the table scrolls sideways. */
  stickyFirst: boolean;
  /**
   * Every value label is a word or a number ("1", "Total"), so a phone card
   * can give its labels a narrow column and its values the rest.
   */
  shortLabels: boolean;
};

/** "Column 3": a heading an older parser made up for a table that had none. */
const INVENTED_HEADING = /^column\s+\d+$/i;

/**
 * A quantity rather than a word: `55`, `0.8`, `-5%`, `3x`, `20-29`, `1.84 s`,
 * `2.4 m`. A short unit is allowed after the digits; anything with letters
 * beyond that is text, and wraps like text.
 */
const QUANTITY = /^[-+~≈<>]?\d[\d.,]*(?:\s*[-–]\s*\d[\d.,]*)?\s*(?:%|x|×|s|m|kg|m\/s|°)?$/i;

/**
 * Past this many characters a heading wraps in the label column of a phone
 * card: 40% of a 360px card is about 120px, thirteen tracked capitals.
 */
const WIDE_LABEL = 13;

/** Longest line a column may have and still be kept on one line. */
const SHORT_LINE = 20;

/** Longest line a column may have and still wrap at its natural width. */
const TEXT_LINE = 40;

/** Longest row heading that may be pinned (LD-01: about 32 characters). */
const STICKY_LINE = 32;

/** Labels no longer than this fit a narrow label column on a phone card. */
const SHORT_LABEL = 8;

/** A cell's lines as they are displayed, breaks an older ingest lost included (`lineCuts`). */
function lines(cell: string): string[] {
  return piecesOf(cell, lineCuts(cell, 'cell')).filter(Boolean);
}

function longestLine(cells: string[]): number {
  let longest = 0;
  for (const cell of cells) for (const line of lines(cell)) longest = Math.max(longest, line.length);
  return longest;
}

/** A row that is a sub-heading: text in its first cell and nothing after it. */
function isGroupRow(row: string[], index: number, marked: ReadonlySet<number> | null): boolean {
  if (marked) return marked.has(index);
  // Older rows carry no marks. Only the unmistakable case is taken: a lone
  // first cell that announces what follows ("50% chance to drop 1 of:").
  // A lone name ("Swamp") may be a row whose values are simply unknown.
  const [first = '', ...rest] = row;
  return first.trim().endsWith(':') && rest.every((cell) => !cell.trim());
}

function kindOf(cells: string[]): ColumnKind {
  const filled = cells.map((cell) => cell.trim()).filter(Boolean);
  if (filled.length > 0 && filled.every((cell) => lines(cell).every((line) => QUANTITY.test(line)))) {
    return 'number';
  }
  const longest = longestLine(filled);
  if (longest <= SHORT_LINE) return 'short';
  if (longest <= TEXT_LINE) return 'text';
  return 'long';
}

export function tableModel(block: TableBlock): TableModel {
  const width = Math.max(block.headers.length, ...block.rows.map((row) => row.length), 0);
  const marked = block.groupRows ? new Set(block.groupRows) : null;

  const headings = Array.from({ length: width }, (_, i) => {
    const heading = (block.headers[i] ?? '').trim();
    return INVENTED_HEADING.test(heading) ? '' : heading;
  });

  const grid = block.rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
  const groups = grid.map((row, i) => isGroupRow(row, i, marked));
  const dataRows = grid.filter((_, i) => !groups[i]);

  // A column with no text in any row is an image-only column the ingest
  // could not read (an icon), or the ragged edge of the source table. Either
  // way it shows nothing but an empty label on a phone card.
  const kept = headings
    .map((_, i) => i)
    .filter((i) => dataRows.some((row) => (row[i] ?? '').trim() !== ''));

  const columns: TableColumn[] = kept.map((i) => {
    const label = headings[i] ?? '';
    return {
      label,
      kind: kindOf(dataRows.map((row) => row[i] ?? '')),
      wideLabel: label.length > WIDE_LABEL,
    };
  });

  const rows: TableRowModel[] = grid.map((row, i) =>
    groups[i]
      ? { kind: 'group', text: (row[0] ?? '').trim() }
      : { kind: 'row', cells: kept.map((c) => row[c] ?? '') },
  );

  const firstColumn = kept[0];
  const stickyFirst =
    kept.length > 1 &&
    firstColumn !== undefined &&
    longestLine(dataRows.map((row) => row[firstColumn] ?? '')) <= STICKY_LINE;

  const hasHeader = columns.some((column) => column.label !== '');
  return {
    caption: block.caption.trim(),
    columns,
    hasHeader,
    rows,
    stickyFirst,
    shortLabels: hasHeader && columns.slice(1).every((column) => column.label.length <= SHORT_LABEL),
  };
}
