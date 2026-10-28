'use client';

import { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useStrings } from '@/components/shell/lang-context';
import type { CompareRow, CompareTable } from '@/lib/db/wiki-repo';
import type { Lang } from '@/lib/i18n/strings';
import { articleHref } from '@/lib/routes';
import {
  BY_NAME,
  columnKind,
  dataLines,
  headingWidth,
  isMissing,
  isShortHeading,
  nextSort,
  sortRows,
  type ColumnKind,
  type SortState,
} from './compare-model';
import { SegmentedLinks, type Segment } from './segmented-links';
import { WikiImage } from './wiki-image';

/**
 * The comparison table, with its level switcher and, on a phone, its sort bar.
 *
 * One semantic table at every width. It used to become a stack of cards
 * below 640px: the header row, and every sort button in it, was hidden, and
 * each item turned into a twelve-line card — Weapons was 86,000px, a hundred
 * screens, and "which of these is better" could not be answered because no
 * two items were ever side by side. Now a phone gets the same table, scrolled
 * sideways under a pinned name column, plus a sort bar above it: pick a stat,
 * and the rows reorder and that stat appears right under each name, in the
 * pinned column, so the ranking reads top to bottom without scrolling
 * sideways at all. Every other column is still a swipe away.
 *
 * On a desktop the box takes the width the page leaves to the right, the
 * header row and the names stay pinned while the rest scrolls under them, and
 * the box is never taller than the screen, so both of its scrollbars can be
 * reached (compare.css).
 */
export function CompareView({
  lang,
  title,
  table,
  levels,
}: {
  lang: Lang;
  /** What is being compared, for the table's accessible name: "Armas". */
  title: string;
  table: CompareTable;
  /** The level switcher's segments, when the set has more than one level. */
  levels: Segment[] | null;
}) {
  const t = useStrings(lang);
  const [sort, setSort] = useState<SortState>(BY_NAME);
  // A column sorted on one level may not exist on the next.
  const active = sort.column === null || table.columns.includes(sort.column) ? sort : BY_NAME;
  const rows = useMemo(() => sortRows(table.rows, active, lang), [table.rows, active, lang]);
  const kinds = useMemo(
    () => new Map(table.columns.map((column) => [column, columnKind(table.rows.map((row) => row.values[column] ?? ''))])),
    [table],
  );
  const label = (column: string): string => table.columnLabels?.[column] ?? column;
  const empty = table.columns.length === 0 || table.rows.length === 0;

  return (
    <div className="mt-6 sm:mt-8">
      {levels || !empty ? (
        // Without levels it holds only the phone's sort bar, so from 640px
        // it is nothing, and takes no room.
        <div className={`flex flex-wrap items-center gap-x-6 gap-y-3 ${levels ? '' : 'sm:hidden'}`}>
          {levels ? <SegmentedLinks label={t.wikiLevels} segments={levels} /> : null}
          {empty ? null : (
            <PhoneSort
              lang={lang}
              sort={active}
              columns={table.columns.map((column) => ({ column, label: label(column), kind: kinds.get(column) ?? 'short' }))}
              onSort={setSort}
            />
          )}
        </div>
      ) : null}

      {empty ? (
        <p className={`max-w-[65ch] text-ash ${levels ? 'mt-6' : ''}`}>{t.wikiCompareNoStats}</p>
      ) : (
        <div className={`compare-frame mt-4 ${levels ? '' : 'sm:mt-0'}`}>
          {/*
           * Focusable because it scrolls: a keyboard has no other way to reach
           * the columns past the edge or the rows past the bottom.
           */}
          <div
            tabIndex={0}
            role="region"
            aria-label={t.wikiCompareRegion.replace('{name}', title)}
            className="compare-scroller"
          >
            <table className="compare-table">
              <thead>
                <tr>
                  <th scope="col" aria-sort={ariaSort(active, null)}>
                    <SortButton
                      label={t.wikiItem}
                      active={active.column === null}
                      desc={active.desc}
                      onClick={() => setSort(nextSort(active, null))}
                    />
                    {/* On a phone, which stat the line under each name is. */}
                    {active.column !== null ? (
                      <span aria-hidden="true" className="-mt-1 block px-3 pb-2 font-mono text-xs leading-snug text-forge sm:hidden">
                        {label(active.column)}
                      </span>
                    ) : null}
                  </th>
                  {table.columns.map((column) => (
                    <th key={column} scope="col" aria-sort={ariaSort(active, column)}>
                      <SortButton
                        label={label(column)}
                        active={active.column === column}
                        desc={active.desc}
                        onClick={() => setSort(nextSort(active, column))}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Row
                    key={row.slug}
                    row={row}
                    columns={table.columns}
                    kinds={kinds}
                    sorted={active.column}
                    lang={lang}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ariaSort(sort: SortState, column: string | null): 'ascending' | 'descending' | undefined {
  if (sort.column !== column) return undefined;
  return sort.desc ? 'descending' : 'ascending';
}

/**
 * A column heading that sorts by its column. The visible name is the
 * button's name, so a screen reader hears the column, and the order comes
 * from the header cell's `aria-sort`; the arrow is for the eye.
 */
function SortButton({
  label,
  active,
  desc,
  onClick,
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`focus-inset flex w-full items-end gap-1 px-3 py-2 text-left transition-colors pointer-coarse:min-h-11 ${
        active ? 'text-forge' : 'text-ash hover:text-birch'
      }`}
    >
      {isShortHeading(label) ? (
        // Two balanced lines at most (`headingWidth`); the tracking is part of
        // each character's width.
        <span
          className="label inline-block text-balance text-inherit"
          style={{ minWidth: `calc(${headingWidth(label)} * (1ch + 0.16em))` }}
        >
          {label}
        </span>
      ) : (
        // A long infobox label in sentence case: tracked capitals past a few
        // words are hard to read.
        <span
          className="inline-block max-w-48 font-mono text-xs leading-snug text-balance"
          style={{ minWidth: `min(${headingWidth(label)}ch, 12rem)` }}
        >
          {label}
        </span>
      )}
      <span aria-hidden="true" className={`w-3 shrink-0 font-mono text-xs leading-snug ${active ? '' : 'opacity-40'}`}>
        {active ? (desc ? '↓' : '↑') : '↕'}
      </span>
    </button>
  );
}

function Row({
  row,
  columns,
  kinds,
  sorted,
  lang,
}: {
  row: CompareRow;
  columns: string[];
  kinds: Map<string, ColumnKind>;
  sorted: string | null;
  lang: Lang;
}) {
  const t = useStrings(lang);
  // In Spanish a row's values are the translation's only when it lines up
  // with the English row for row; otherwise they are the English originals.
  const english = row.valuesTranslated === false;
  const sortedValue = sorted !== null ? row.values[sorted] : undefined;

  return (
    <tr>
      <th scope="row" className="w-36 min-w-36 text-sm font-normal sm:w-auto sm:min-w-0 sm:whitespace-nowrap">
        {/*
         * The whole cell is the link, at least 44px tall: the name alone was
         * a 19px strip to aim a thumb at.
         */}
        <Link
          href={articleHref(row.slug)}
          prefetch={false}
          className="focus-inset flex min-h-11 flex-col gap-1 px-3 py-2 leading-snug text-birch transition-colors hover:text-forge"
        >
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* The picture never parts from its name; only the badge may drop below. */}
            <span className="inline-flex items-center gap-2">
              {row.icon ? (
                // Wider than tall and `contain`, because this set mixes square
                // item sprites with landscape screenshots. Left out on a phone,
                // where the name column has room for the name only.
                <WikiImage url={row.icon} drawn={[32]} width={32} height={24} className="hidden h-6 w-8 shrink-0 object-contain sm:block" />
              ) : null}
              <span>{row.title}</span>
            </span>
            {row.shownTab ? (
              // A shield that stops at level 3, compared at level 4, shows its
              // level-3 stats; said once, here, rather than in every cell.
              <span className="inline-block rounded-sm border border-moss px-1 font-mono text-xs leading-5 whitespace-nowrap text-ash">
                {t.wikiCompareShownTab.replace('{n}', row.shownTab)}
              </span>
            ) : null}
          </span>
          {sorted !== null ? (
            <span aria-hidden="true" lang={english ? 'en' : undefined} className="block font-mono text-xs text-forge sm:hidden">
              {isMissing(sortedValue) ? '–' : dataLines(sortedValue ?? '')[0]}
            </span>
          ) : null}
        </Link>
      </th>
      {columns.map((column) => (
        <Cell
          key={column}
          value={row.values[column]}
          kind={kinds.get(column) ?? 'short'}
          english={english}
          noValue={t.wikiCompareNoValue}
        />
      ))}
    </tr>
  );
}

function Cell({
  value,
  kind,
  english,
  noValue,
}: {
  value: string | undefined;
  kind: ColumnKind;
  english: boolean;
  noValue: string;
}) {
  if (isMissing(value)) {
    // A quiet dash for the eye, words for a screen reader, which would
    // otherwise read the dash's name or skip the cell without a word.
    return (
      <td className="font-mono text-xs leading-snug text-ash">
        <span aria-hidden="true">–</span>
        <span className="sr-only">{noValue}</span>
      </td>
    );
  }
  const text = value ?? '';

  if (kind === 'text') {
    // Sentences wrap at a reading width and stop at three lines; the
    // article has the rest, one tap away in the same row. No `block` here:
    // the clamp is a display of its own (`-webkit-box`), and `block` after
    // it in the stylesheet switched the clamp off, so a Description ran to
    // ten lines and its row past 200px.
    return (
      <td lang={english ? 'en' : undefined}>
        <span className="line-clamp-3 w-56 text-sm leading-snug whitespace-pre-line text-birch/90 sm:w-72">{text}</span>
      </td>
    );
  }

  return (
    <td lang={english ? 'en' : undefined} className="font-mono text-xs leading-snug whitespace-nowrap text-birch/90 tabular-nums">
      {dataLines(text).map((line, index) => (
        <span key={index} className="block">
          {line}
        </span>
      ))}
    </td>
  );
}

/**
 * Sorting on a phone, where the column headings are mostly off screen: a
 * picker for the stat and a button for the direction, both thumb-sized.
 */
function PhoneSort({
  lang,
  sort,
  columns,
  onSort,
}: {
  lang: Lang;
  sort: SortState;
  columns: { column: string; label: string; kind: ColumnKind }[];
  onSort: (sort: SortState) => void;
}) {
  const t = useStrings(lang);
  const id = useId();
  const kind = columns.find((c) => c.column === sort.column)?.kind ?? 'short';
  const numeric = sort.column !== null && kind === 'number';
  const direction = numeric
    ? sort.desc
      ? t.wikiCompareHighFirst
      : t.wikiCompareLowFirst
    : sort.desc
      ? t.wikiCompareZtoA
      : t.wikiCompareAtoZ;

  return (
    <div className="flex w-full items-center gap-2 sm:hidden">
      <label htmlFor={id} className="label shrink-0">
        {t.wikiCompareSortBy}
      </label>
      {/*
       * 16px on touch screens: iOS zooms the page into any focused field set
       * smaller and does not zoom back out, and this picker shows only on
       * phones. The edge answers the pointer and the focus as the other
       * fields' do.
       */}
      <select
        id={id}
        value={sort.column ?? ''}
        onChange={(event) => onSort({ column: event.target.value || null, desc: false })}
        className="h-11 min-w-0 flex-1 rounded-md border border-moss bg-peat px-3 text-sm text-birch transition-colors hover:border-lichen focus:border-forge/50 pointer-coarse:text-base"
      >
        <option value="">{t.wikiItem}</option>
        {columns.map(({ column, label }) => (
          <option key={column} value={column}>
            {label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onSort({ ...sort, desc: !sort.desc })}
        aria-label={`${t.wikiCompareOrder}: ${direction}`}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-moss bg-peat font-mono text-base text-birch transition-colors hover:border-forge/50"
      >
        <span aria-hidden="true">{sort.desc ? '↓' : '↑'}</span>
      </button>
    </div>
  );
}
