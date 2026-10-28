import { cache } from 'react';
import { cookies } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import type { Metadata } from 'next';
import { BROWSE_HREF } from '@/components/shell/nav-model';
import { CategoryView, contentDescription, type CategoryContent } from '@/components/wiki/category-view';
import { headingParts, type FilterParts } from '@/components/wiki/lists/format';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings, type Lang } from '@/lib/i18n/strings';
import {
  ALL_CATEGORIES,
  categoryFromParam,
  categoryHref,
  facetQuery,
  isPlausibleName,
  parseCategoryQuery,
  type CategoryQuery,
} from '@/lib/routes';
import { getCategoryListing, getCompareView } from '@/lib/wiki/data';
// The compare view's table (`?view=compare`); the list needs only the shell's styles, in globals.css.
import '@/app/styles/compare.css';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ category: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function readerLang(): Promise<Lang> {
  return parseLang((await cookies()).get(LANG_COOKIE)?.value);
}

/**
 * The request, read once: the category named by the path (decoded: see
 * `categoryFromParam`), the query, and whether the two can name anything.
 *
 * `missing`: a value no name can have (control characters, absurd lengths),
 * which is answered "not found" without a query. `everything`: the `all`
 * sentinel with no facet to narrow it, which is the browse page.
 *
 * Whether the category exists was settled by the layout; what is answered
 * here is the query. The route has no loading boundary, so nothing is sent
 * before the page has rendered, and a query that names nothing is a real 404
 * (with `noindex`, as every 404 has). No link in the app leads to such a
 * query.
 */
function readRequest(name: string, raw: Record<string, string | string[] | undefined>) {
  const { query, invalid } = parseCategoryQuery(raw);
  const filter: FilterParts = {
    ...(name !== ALL_CATEGORIES ? { category: name } : {}),
    ...facetQuery(query),
  };
  return {
    name,
    query,
    filter,
    missing: invalid || !isPlausibleName(name),
    everything: Object.keys(filter).length === 0,
  };
}

/**
 * What the page shows for a filter, or null when nothing matches.
 *
 * Shared by the page and its metadata through React's `cache()`, keyed by
 * strings because it compares object arguments by identity. A comparison
 * reads only the table — not the article list it does not show — and the list
 * only when the table is empty, to tell a set with no stats (which still has
 * its list) from a filter that matches nothing (not found).
 */
const loadContent = cache(async (name: string, queryKey: string, lang: Lang): Promise<CategoryContent | null> => {
  const query = JSON.parse(queryKey) as CategoryQuery;
  const filter = {
    ...(name !== ALL_CATEGORIES ? { category: name } : {}),
    ...facetQuery(query),
  };

  if (query.view === 'compare') {
    const compare = await getCompareView(filter, query.tab, lang);
    const listed = compare.table.rows.length === 0 ? (await getCategoryListing(filter, lang)).articles.length : null;
    if (listed === 0) return null;
    // An unknown `?tab=` reads as no level, which shows each item's first.
    const tab = query.tab && compare.tabs.includes(query.tab) ? query.tab : (compare.tabs[0] ?? null);
    return { view: 'compare', table: compare.table, tabs: compare.tabs, tab, listed };
  }

  const listing = await getCategoryListing(filter, lang);
  return listing.articles.length > 0 ? { view: 'list', articles: listing.articles } : null;
});

/*
 * In the reader's language: the title the tab, the history and a screen
 * reader's page announcement use. The link preview takes its title and
 * description from these too. The canonical address is the list's: a
 * comparison or a level is the same set of articles, shown another way.
 *
 * The param arrives decoded here, and is used as it is; the page decodes its
 * own (`categoryFromParam`). Decoding this one again crashed on a category
 * such as `100%`, and read a broken link's `Points%20of%20interest` as the
 * real category.
 */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ category }, raw, lang] = await Promise.all([params, searchParams, readerLang()]);
  const t = strings(lang);
  const request = readRequest(category, raw);
  const notFoundTitle: Metadata = { title: `${t.shellNotFoundTitle} — ${t.appName}` };
  if (request.missing) return notFoundTitle;
  if (request.everything) return { title: t.wikiBrowseMetaTitle };

  const content = await loadContent(request.name, JSON.stringify(request.query), lang);
  if (!content) return notFoundTitle;

  const heading = headingParts(request.filter, lang)
    .map((part) => part.text)
    .join(' · ');
  return {
    title: `${heading} — ${t.appName}`,
    description: contentDescription(content, heading, lang),
    alternates: { canonical: categoryHref(request.name, facetQuery(request.query)) },
  };
}

/**
 * A category's articles, or every article matching a facet filter
 * (`/wiki/c/all?biome=Meadows`), as a list or as a comparison.
 *
 * Anything that matches nothing is "not found" rather than an empty page with
 * a title made of whatever was typed: a category that does not exist, from
 * the layout; a facet value nobody links to, from here. Both are real 404s.
 * Every link in the app leads to a set with articles in it.
 */
export default async function CategoryPage({ params, searchParams }: Props) {
  const [{ category }, raw, lang] = await Promise.all([params, searchParams, readerLang()]);
  const request = readRequest(categoryFromParam(category), raw);
  if (request.missing) notFound();
  // Every article, unfiltered, is what the browse page is for. The proxy sends
  // such an address there before anything renders (`permanentWikiRedirect`);
  // this is for whatever reaches the page another way, and is a real 308 too.
  // No link leads here.
  if (request.everything) permanentRedirect(BROWSE_HREF);

  const content = await loadContent(request.name, JSON.stringify(request.query), lang);
  if (!content) notFound();

  return (
    <CategoryView lang={lang} name={request.name} query={request.query} filter={request.filter} content={content} />
  );
}
