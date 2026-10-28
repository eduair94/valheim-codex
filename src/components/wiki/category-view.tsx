import { Fragment } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { BROWSE_HREF } from '@/components/shell/nav-model';
import type { ArticleSummary, CompareTable } from '@/lib/db/wiki-repo';
import { strings, type Lang } from '@/lib/i18n/strings';
import { hasTermLabel, termLabel } from '@/lib/i18n/terms';
import { categoryHref, type CategoryQuery } from '@/lib/routes';
import { IntentPrefetch } from './article/intent-prefetch';
import { CategoryList } from './lists/category-list';
import { shownColumnsOnly } from './lists/compare-model';
import { CompareView } from './lists/compare-view';
import { countLabel, filterAxis, formatCount, headingParts, type FilterParts } from './lists/format';
import { SegmentedLinks, type Segment } from './lists/segmented-links';

/** What a category page shows: its articles, or the comparison of their stats. */
export type CategoryContent =
  | { view: 'list'; articles: ArticleSummary[] }
  | {
      view: 'compare';
      table: CompareTable;
      /** The set's upgrade levels, for the switcher. */
      tabs: string[];
      /** The level on screen; with none asked for, every item's first. */
      tab: string | null;
      /**
       * How many articles the list has, when it was read: only for a table
       * with no rows, to tell a set without stats from one that is not there.
       */
      listed: number | null;
    };

/** "158 artículos", or for a comparison, which only has the articles with stats, "138 con stats". */
export function contentCount(content: CategoryContent, lang: Lang): string {
  return content.view === 'list'
    ? countLabel(content.articles.length, lang)
    : strings(lang).wikiCompareCount.replace('{n}', formatCount(content.table.rows.length, lang));
}

/**
 * What a link preview says the page holds, in the words the page uses: a list
 * counts its articles; a comparison counts the ones with stats, which are
 * fewer ("138 con stats" of 158). A comparison of a set with no stats at all
 * is described as its list, whose count it read: it used to say "Guías: 0
 * artículos" of a category with ten.
 */
export function contentDescription(content: CategoryContent, heading: string, lang: Lang): string {
  const t = strings(lang);
  if (content.view === 'compare' && content.listed === null) {
    return t.wikiCompareMetaDescription
      .replace('{name}', heading)
      .replace('{n}', formatCount(content.table.rows.length, lang));
  }
  const articles = content.view === 'list' ? content.articles.length : (content.listed ?? 0);
  return t.wikiCategoryMetaDescription.replace('{name}', heading).replace('{n}', countLabel(articles, lang));
}

/**
 * A category, as a readable list or as a comparison table.
 *
 * The two views answer different questions — "what exists here" and "which of
 * these is better" — and the toggle is a link rather than local state so a
 * comparison can be shared or reopened.
 *
 * `name` is the category as the wiki names it, decoded (`categoryFromParam`);
 * every link here encodes it once. The page used to pass its still-encoded
 * route param, and every toggle of a multi-word category pointed at
 * `%2520…`, an empty page.
 */
export function CategoryView({
  lang,
  name,
  query,
  filter,
  content,
}: {
  lang: Lang;
  name: string;
  query: CategoryQuery;
  filter: FilterParts;
  content: CategoryContent;
}) {
  const t = strings(lang);
  const parts = headingParts(filter, lang);
  const heading = parts.map((part) => part.text).join(' · ');
  // The wiki's own name, for a reader who knows the English one: a Spanish
  // heading over a link to the English wiki is otherwise hard to match up.
  const english = parts.map((part) => part.english).join(' · ');
  // Which way in this list is, over its title — "Forja" alone could be the
  // bench's own article. A list filtered several ways has no single one.
  const axis = filterAxis(filter);
  const kicker = axis
    ? { category: t.wikiAxisCategory, biome: t.wikiAxisBiome, station: t.wikiAxisStation, type: t.wikiAxisType }[axis]
    : null;

  const linkTo = (patch: Partial<CategoryQuery>): Route => categoryHref(name, { ...query, ...patch });

  /*
   * A level of the comparison: "Nivel 2" for an upgrade level, and the wiki's
   * own word for the other kinds of tab — "0★" for a creature's stars,
   * "Trofeo" for its trophy — in the reader's language where the vocabulary
   * has it. The URL keeps the wiki's label.
   */
  const activeTab = content.view === 'compare' ? content.tab : null;
  const level = (tab: string): Segment => {
    const segment = { key: tab, href: linkTo({ tab }), current: tab === activeTab };
    if (/^\d+$/.test(tab)) return { ...segment, label: `${t.wikiLevel} ${tab}` };
    // "0★" has no words to translate, so it is no language's.
    const untranslated = lang !== 'en' && !hasTermLabel('facet', tab) && /\p{L}/u.test(tab);
    return { ...segment, label: termLabel('facet', tab, lang), ...(untranslated ? { lang: 'en' } : {}) };
  };
  const views: Segment[] = [
    // Back to the list drops the level, which only means something in a comparison.
    { key: 'list', href: linkTo({ view: undefined, tab: undefined }), label: t.wikiList, current: content.view === 'list' },
    { key: 'compare', href: linkTo({ view: 'compare' }), label: t.wikiCompare, current: content.view === 'compare' },
  ];

  return (
    // The rows, the table's names and the toggles fetch their page once the
    // reader points at, touches or tabs to one; none of them does on sight.
    <IntentPrefetch as="div">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          {/* 20px of line, a 44px target: the rest of the target is the padding above and below. */}
          <Link
            href={BROWSE_HREF}
            className="-my-3 inline-flex items-center gap-1 py-3 font-mono text-xs leading-5 text-ash transition-colors hover:text-birch"
          >
            <span aria-hidden="true">←</span>
            {t.wikiBrowse}
          </Link>
          {kicker ? <p className="label mt-3 text-forge">{kicker}</p> : null}
          <h1
            className={`display text-2xl leading-tight text-balance wrap-break-word text-birch sm:text-3xl ${kicker ? 'mt-1' : 'mt-3'}`}
          >
            {parts.map((part, index) => (
              <Fragment key={part.english}>
                {index > 0 ? ' · ' : null}
                <span lang={part.untranslated ? 'en' : undefined}>{part.text}</span>
              </Fragment>
            ))}
          </h1>
          <p className="mt-2 font-mono text-xs text-ash">
            {contentCount(content, lang)}
            {lang !== 'en' && english !== heading ? (
              <>
                <span aria-hidden="true"> · </span>
                <span lang="en">{english}</span>
              </>
            ) : null}
          </p>
        </div>
        <SegmentedLinks label={t.wikiViewLabel} segments={views} />
      </header>

      {content.view === 'list' ? (
        <div className="mt-6 sm:mt-8">
          <CategoryList articles={content.articles} lang={lang} />
        </div>
      ) : (
        <CompareView
          lang={lang}
          title={heading}
          table={shownColumnsOnly(content.table)}
          levels={content.tabs.length > 1 ? content.tabs.map((tab) => level(tab)) : null}
        />
      )}
    </IntentPrefetch>
  );
}
