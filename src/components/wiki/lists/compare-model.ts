import type { CompareTable } from '@/lib/db/wiki-repo';
import type { Lang } from '@/lib/i18n/strings';

/**
 * The comparison table's decisions — how a column sorts, how its cells are
 * set — kept apart from the markup so they can be tested on their own.
 */

/**
 * The table with each row's values cut to the columns it shows: what the
 * server hands the table in the browser.
 *
 * A row arrives with every label of its item's infobox — Description,
 * Internal ID, Usage, Crafting Materials — and only the shared ones become
 * columns. Passed whole, the rest went to every reader in the page's payload
 * and was never drawn: 56 KB of the 146 KB Weapons comparison.
 */
export function shownColumnsOnly(table: CompareTable): CompareTable {
  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      values: Object.fromEntries(
        table.columns.flatMap((column): [string, string][] => {
          // Own keys only: a column named like an object method is not one.
          const value = Object.hasOwn(row.values, column) ? row.values[column] : undefined;
          return value === undefined ? [] : [[column, value]];
        }),
      ),
    })),
  };
}

/** First number in a value, so "55 slash" and "0.8" sort as numbers. */
export function leadingNumber(value: string): number | null {
  const match = /^-?\d+(?:[.,]\d+)?/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** A value that is not there: the row has no such stat. */
export function isMissing(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

/** A value's lines: the ingest keeps one recipe entry or resistance per line. */
export function valueLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * A data value's lines as a cell shows them: one per line of the value, and
 * one per alternative where the wiki strings them together with semicolons —
 * "21 (0 skill); 31.5 (100 skill)" is two numbers, and on one line it made
 * the column twice as wide as either.
 */
export function dataLines(value: string): string[] {
  return valueLines(value).flatMap((line) =>
    line
      .split(/;\s+/)
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

/**
 * How a column's cells are set.
 *
 *   - `number`: mostly numbers ("55", "21 (0 skill); 31.5 (100 skill)").
 *     Monospace, tabular figures, one line, so digits line up down the column.
 *   - `short`: a few words ("Sword", "Yes"). One line.
 *   - `text`: sentences ("For a slight blood offering…"). Every cell used to
 *     be one line, which made a Description column 2,000px wide and pushed
 *     every other column off screen; these wrap, in the body face, at a
 *     reading width.
 */
export type ColumnKind = 'number' | 'short' | 'text';

/** Past this many characters a word-ish value stops fitting one line of a column. */
const SHORT = 32;
/** Past this even a numeric value is prose with a number in front ("10 per hit, but only…"). */
const LONG = 48;

export function columnKind(values: readonly string[]): ColumnKind {
  const present = values.filter((value) => !isMissing(value));
  if (present.length === 0) return 'short';
  const numeric = present.filter((value) => leadingNumber(value) !== null).length / present.length;
  const longest = Math.max(...present.flatMap((value) => dataLines(value).map((line) => line.length)));
  if (longest > LONG || (longest > SHORT && numeric < 0.5)) return 'text';
  return numeric >= 0.5 ? 'number' : 'short';
}

/**
 * Whether a column heading fits the tracked-capitals label style. Long
 * infobox labels ("Teleportable (Can go through wood portal?)") are set in
 * sentence case instead: capitals tire the eye past a few words.
 */
export function isShortHeading(label: string): boolean {
  return label.length <= 24;
}

/**
 * How wide a column heading must stay, in characters: its longer half when
 * broken into two balanced lines, or the whole of a single word.
 *
 * Headings used to sit on one line, and in tracked capitals they set the
 * width of their column: "ADRENALINA DE BLOQUEO" was 216px over one-digit
 * values, and Weapons was 2,300px wide. Free to wrap, a table too wide for
 * its box shrinks every column to its narrowest, and a heading would break
 * at every word ("NIVEL / DE / FABRICACIÓN"); held at this width, it takes
 * two lines at most.
 */
export function headingWidth(label: string): number {
  const words = label.trim().split(/\s+/);
  if (words.length < 2) return label.trim().length;
  let best = label.length;
  for (let split = 1; split < words.length; split++) {
    const left = words.slice(0, split).join(' ').length;
    const right = words.slice(split).join(' ').length;
    best = Math.min(best, Math.max(left, right));
  }
  return best;
}

/** The order of the rows. `column: null` is by name, the order they arrive in. */
export type SortState = { column: string | null; desc: boolean };

export const BY_NAME: SortState = { column: null, desc: false };

/** A second press on the same column turns it around; a new column starts ascending. */
export function nextSort(current: SortState, column: string | null): SortState {
  return current.column === column ? { column, desc: !current.desc } : { column, desc: false };
}

/**
 * Sorts the rows by a column.
 *
 * Sorting happens in the browser because the rows are already there: a round
 * trip to reorder a hundred rows would be slower and would break offline.
 * Numbers sort as numbers ("100" after "20"), before any value that is not a
 * number; missing values always sink, whichever way the column is sorted; and
 * ties keep the order the rows came in, which is by name.
 */
export function sortRows<T extends { values: Record<string, string> }>(
  rows: readonly T[],
  sort: SortState,
  lang: Lang,
): T[] {
  if (sort.column === null) return sort.desc ? [...rows].reverse() : [...rows];
  const column = sort.column;
  const collator = new Intl.Collator(lang, { numeric: true, sensitivity: 'base' });
  const direction = sort.desc ? -1 : 1;

  return rows
    .map((row, index) => ({ row, index, value: row.values[column] }))
    .sort((a, b) => {
      const aMissing = isMissing(a.value);
      const bMissing = isMissing(b.value);
      if (aMissing || bMissing) return Number(aMissing) - Number(bMissing) || a.index - b.index;

      const av = (a.value ?? '').trim();
      const bv = (b.value ?? '').trim();
      const an = leadingNumber(av);
      const bn = leadingNumber(bv);
      if ((an === null) !== (bn === null)) return an === null ? 1 : -1;
      const order = an !== null && bn !== null ? an - bn : collator.compare(av, bv);
      return order * direction || a.index - b.index;
    })
    .map(({ row }) => row);
}
