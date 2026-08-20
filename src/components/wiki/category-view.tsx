'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { ArticleSummary, CompareTable } from '@/lib/db/wiki-repo';
import { strings, type Lang } from '@/lib/i18n/strings';
import { articleHref, categoryHref } from '@/lib/routes';

/**
 * A category, as a readable list or as a comparison table.
 *
 * The two views answer different questions — "what exists here" and "which of
 * these is better" — and the toggle is a link rather than local state so a
 * comparison can be shared or reopened.
 */
export type CategoryQuery = {
  biome?: string;
  station?: string;
  type?: string;
  view?: string;
  tab?: string;
};

export function CategoryView({
  lang,
  category,
  query,
  articles,
  table,
  tabs,
  activeTab,
  compare,
}: {
  lang: Lang;
  category: string;
  query: CategoryQuery;
  articles: ArticleSummary[];
  table: CompareTable | null;
  tabs: string[];
  activeTab?: string;
  compare: boolean;
}) {
  const t = strings(lang);

  /*
   * Hrefs are built as objects against the literal route rather than by string
   * concatenation, so a typo in a path or a param is a compile error instead of
   * a 404 someone finds later.
   */
  const linkTo = (patch: Partial<CategoryQuery>) =>
    categoryHref(category, { ...query, ...patch });

  if (articles.length === 0) {
    return <p className="mt-6 text-sm text-ash">{t.wikiNothingHere}</p>;
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-moss" role="group">
          <Link
            href={linkTo({ view: undefined })}
            className={`px-3 py-1.5 text-xs transition-colors ${
              compare ? 'text-ash hover:text-birch' : 'bg-forge text-bog'
            }`}
          >
            {t.wikiList}
          </Link>
          <Link
            href={linkTo({ view: 'compare' })}
            className={`px-3 py-1.5 text-xs transition-colors ${
              compare ? 'bg-forge text-bog' : 'text-ash hover:text-birch'
            }`}
          >
            {t.wikiCompare}
          </Link>
        </div>

        {compare && tabs.length > 1 ? (
          <div className="flex overflow-x-auto rounded-md border border-moss" role="group" aria-label={t.wikiLevels}>
            {tabs.map((tab) => {
              const selected = (activeTab ?? tabs[0]) === tab;
              return (
                <Link
                  key={tab}
                  href={linkTo({ tab })}
                  aria-current={selected ? 'true' : undefined}
                  className={`shrink-0 px-2.5 py-1.5 font-mono text-[0.68rem] transition-colors ${
                    selected ? 'bg-moss text-birch' : 'text-ash hover:text-birch'
                  }`}
                >
                  {/^\d+$/.test(tab) ? `${t.wikiLevel} ${tab}` : tab}
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>

      {compare && table ? (
        <CompareGrid table={table} lang={lang} />
      ) : (
        <ul className="flex flex-col gap-0.5">
          {articles.map((article) => (
            <li key={article.slug}>
              <Link
                href={articleHref(article.slug)}
                className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-peat"
              >
                {article.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={article.icon}
                    alt=""
                    width={32}
                    height={32}
                    loading="lazy"
                    className="h-8 w-8 shrink-0 rounded-sm border border-moss bg-peat object-contain p-0.5"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-moss bg-peat text-xs text-ash"
                  >
                    ᛚ
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.95rem] text-birch">{article.title}</span>
                  <span className="block truncate text-[0.72rem] text-ash">
                    {article.lead || Object.values(article.facets).filter(Boolean).join(' · ')}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The comparison table.
 *
 * Sorting is client-side because the rows are already here: a round trip to
 * reorder a hundred rows would be slower and would break offline. Numeric-
 * looking values sort numerically so "100" does not land before "20".
 */
function CompareGrid({ table, lang }: { table: CompareTable; lang: Lang }) {
  const t = strings(lang);
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);

  const rows = useMemo(() => {
    if (!sort) return table.rows;
    const { column, desc } = sort;
    return [...table.rows].sort((a, b) => {
      const av = a.values[column] ?? '';
      const bv = b.values[column] ?? '';
      const an = leadingNumber(av);
      const bn = leadingNumber(bv);
      // Blank always sinks, whichever way the column is sorted.
      if (av === '' && bv !== '') return 1;
      if (bv === '' && av !== '') return -1;
      const cmp =
        an !== null && bn !== null ? an - bn : av.localeCompare(bv, undefined, { numeric: true });
      return desc ? -cmp : cmp;
    });
  }, [table.rows, sort]);

  if (table.columns.length === 0) {
    return <p className="mt-4 text-sm text-ash">{t.wikiNothingHere}</p>;
  }

  const toggle = (column: string): void =>
    setSort((current) =>
      current?.column === column ? { column, desc: !current.desc } : { column, desc: false },
    );

  return (
    // Focusable because it scrolls: the comparison is wider than a phone by
    // design, and a keyboard has no other way to reach the columns past the
    // fold.
    <div
      tabIndex={0}
      role="region"
      aria-label={t.wikiCompare ?? 'Comparación'}
      className="overflow-x-auto rounded-md border border-moss"
    >
      <table className="w-full border-collapse text-left text-[0.8rem]">
        <thead>
          <tr className="bg-peat">
            <th
              scope="col"
              className="sticky left-0 z-10 whitespace-nowrap border-b border-moss bg-peat px-3 py-2 font-mono text-[0.68rem] uppercase tracking-wider text-ash"
            >
              {t.wikiItem}
            </th>
            {table.columns.map((column) => (
              <th key={column} scope="col" className="whitespace-nowrap border-b border-moss px-1 py-1">
                <button
                  type="button"
                  onClick={() => toggle(column)}
                  aria-label={column}
                  className={`w-full rounded-sm px-2 py-1 text-left font-mono text-[0.68rem] uppercase tracking-wider transition-colors ${
                    sort?.column === column ? 'text-forge' : 'text-ash hover:text-birch'
                  }`}
                >
                  {column}
                  <span aria-hidden="true" className="ml-1">
                    {sort?.column === column ? (sort.desc ? '▾' : '▴') : ''}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.slug} className="odd:bg-peat/30">
              <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-bog px-3 py-2 text-left font-medium">
                <Link
                  href={articleHref(row.slug)}
                  className="flex items-center gap-2 text-birch hover:text-forge"
                >
                  {row.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={row.icon} alt="" width={20} height={20} loading="lazy" className="h-5 w-5 object-contain" />
                  ) : null}
                  {row.title}
                </Link>
              </th>
              {table.columns.map((column) => (
                <td
                  key={column}
                  className="whitespace-nowrap border-b border-moss/50 px-3 py-2 font-mono text-birch/90"
                >
                  {row.values[column] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** First number in a value, so "55 slash" and "0.8" sort as numbers. */
function leadingNumber(value: string): number | null {
  const match = /^-?\d+(?:[.,]\d+)?/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
