import type { TableBlock } from '@/lib/wiki/article-types';
import type { Linker } from '@/lib/wiki/links';
import { strings, type Lang } from '@/lib/i18n/strings';
import { LinkedText } from '../linked-text';
import { ScrollRegion } from './scroll-region';
import { tableModel, type TableColumn, type TableRowModel } from './table-model';

/** Past this, a caption is a sentence and is not set in tracked capitals (DET-07). */
const LABEL_CAPTION = 24;
/** Past this, a column heading wraps in sentence case instead of tracked capitals. */
const LABEL_HEADING = 20;

/**
 * A table from the article.
 *
 * On a wide screen it scrolls sideways inside its own box — the page itself
 * never scrolls sideways — with each column behaving like its content: short
 * values and quantities on one line, sentences wrapped at a reading width
 * (`.data-table`, tables.css), and the row headings pinned while they are
 * short enough to pin.
 *
 * On a phone every row becomes a card: its heading is the title, and each
 * cell a labelled line (`.stack-table`, shared with the guide and the chat).
 * Each cell's content sits in exactly one element, so the card's label and
 * value columns can never be fed a quantity in one column and its material
 * in the other — "10 Wood 15 Flint" used to come out as "Wood → 15" (BWR-01).
 */
export function DataTable({
  id,
  block,
  linker,
  lang,
  uiLang,
}: {
  /** Unique on the page: the caption's id is made from it. */
  id: string;
  block: TableBlock;
  linker: Linker;
  lang: Lang;
  /** Set when the article is in another language than the interface. */
  uiLang?: Lang;
}) {
  const t = strings(lang);
  const model = tableModel(block);
  if (model.columns.length === 0) return null;

  const captionId = `${id}-caption`;
  const caption = model.caption ? (
    <figcaption
      id={captionId}
      className={model.caption.length > LABEL_CAPTION ? 'mb-2 max-w-[65ch] text-sm text-ash' : 'label mb-2'}
    >
      <LinkedText text={model.caption} linker={linker} />
    </figcaption>
  ) : null;

  // One column is a list of lines under headings (Hugin's and Munin's
  // dialogue), not a table: rendered as one, it was a stack of cards with a
  // title and nothing else in them.
  if (model.columns.length === 1) {
    return (
      <figure>
        {caption}
        <div className="flex max-w-[68ch] flex-col gap-2">
          {model.rows.map((row, i) =>
            row.kind === 'group' ? (
              <p key={i} className="label mt-3 first:mt-0">
                <LinkedText text={row.text} linker={linker} />
              </p>
            ) : (
              <p key={i} className="text-base leading-relaxed text-birch/90">
                <LinkedText text={row.cells[0] ?? ''} linker={linker} lines />
              </p>
            ),
          )}
        </div>
      </figure>
    );
  }

  const width = model.columns.length;

  return (
    <figure>
      {caption}
      <ScrollRegion
        labelledBy={model.caption ? captionId : undefined}
        label={t.articleTable}
        labelLang={uiLang}
        className="stack-scroller data-scroller"
      >
        <table className="stack-table data-table" data-labels={model.shortLabels ? 'short' : undefined}>
          {model.hasHeader ? (
            <thead>
              <tr>
                {model.columns.map((column, i) => (
                  <th
                    key={i}
                    scope="col"
                    className={headClass(column, i === 0 && model.stickyFirst)}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          {/*
           * A sub-heading row ("One-handed", "10 of the following:") heads
           * the rows after it, so each group is a row group of its own.
           */}
          {rowGroups(model.rows).map((group, g) => (
            <tbody key={g}>
              {group.heading !== null ? (
                <tr data-group="">
                  <th scope="rowgroup" colSpan={width}>
                    <span>
                      <LinkedText text={group.heading} linker={linker} />
                    </span>
                  </th>
                </tr>
              ) : null}
              {group.rows.map((cells, i) => (
                <tr key={i}>
                  {cells.map((cell, j) => {
                    const column = model.columns[j]!;
                    const content = cell.trim() ? (
                      <span className="cell">
                        <LinkedText text={cell} linker={linker} lines repair="cell" />
                      </span>
                    ) : null;
                    /*
                     * The first cell is what the row is about, so it is a row
                     * header rather than data. That is also what turns it into
                     * the card's title once the table stacks on a phone.
                     */
                    return j === 0 ? (
                      <th key={j} scope="row" className={cellClass(column, model.stickyFirst)}>
                        {content}
                      </th>
                    ) : (
                      <td
                        key={j}
                        // Names its column, which labels the value once the
                        // header row is gone on a phone. No heading, no label.
                        data-label={column.label || undefined}
                        data-wide={column.wideLabel ? '' : undefined}
                        className={cellClass(column, false)}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </ScrollRegion>
    </figure>
  );
}

/** The table's rows in groups, each under the sub-heading before it (or none). */
function rowGroups(rows: TableRowModel[]): { heading: string | null; rows: string[][] }[] {
  const groups: { heading: string | null; rows: string[][] }[] = [];
  for (const row of rows) {
    if (row.kind === 'group') groups.push({ heading: row.text, rows: [] });
    else if (groups.length === 0) groups.push({ heading: null, rows: [row.cells] });
    else groups[groups.length - 1]!.rows.push(row.cells);
  }
  return groups;
}

/** A heading is set as a heading whatever its column holds: a number column's too (`.col-num` is the cells' face). */
function headClass(column: TableColumn, sticky: boolean): string {
  return [column.label.length > LABEL_HEADING ? 'head-text' : 'head-label', sticky ? 'col-sticky' : '']
    .filter(Boolean)
    .join(' ');
}

function cellClass(column: TableColumn, sticky: boolean): string | undefined {
  const kind = { number: 'col-num', short: 'col-short', text: 'col-text', long: 'col-long' }[column.kind];
  return [kind, sticky ? 'col-sticky' : ''].filter(Boolean).join(' ') || undefined;
}
