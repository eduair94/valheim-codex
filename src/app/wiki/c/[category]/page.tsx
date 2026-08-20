import Link from 'next/link';
import { cookies } from 'next/headers';
import { CategoryView } from '@/components/wiki/category-view';
import { getDb } from '@/lib/db/client';
import { buildCompareTable, listArticles, listCompareTabs, type BrowseFilter } from '@/lib/db/wiki-repo';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings } from '@/lib/i18n/strings';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ category: string }>;
  searchParams: Promise<{ biome?: string; station?: string; type?: string; view?: string; tab?: string }>;
};

export default async function CategoryPage({ params, searchParams }: Props) {
  const [{ category }, query, cookieStore] = await Promise.all([params, searchParams, cookies()]);
  const lang = parseLang(cookieStore.get(LANG_COOKIE)?.value);
  const t = strings(lang);

  // `all` is the sentinel a facet link uses when it is not narrowing by
  // category, so the route keeps one shape instead of two.
  const decoded = decodeURIComponent(category);
  const filter: BrowseFilter = {
    ...(decoded !== 'all' ? { category: decoded } : {}),
    ...(query.biome ? { biome: query.biome } : {}),
    ...(query.station ? { station: query.station } : {}),
    ...(query.type ? { type: query.type } : {}),
  };

  const db = await getDb();
  const compare = query.view === 'compare';

  const [articles, table, tabs] = await Promise.all([
    listArticles(db, filter),
    compare ? buildCompareTable(db, filter, { tab: query.tab }) : Promise.resolve(null),
    compare ? listCompareTabs(db, filter) : Promise.resolve([]),
  ]);

  const heading = [decoded !== 'all' ? decoded : null, query.biome, query.station, query.type]
    .filter(Boolean)
    .join(' · ');

  return (
    <div>
      <header className="mb-4">
        <Link
          href="/wiki/browse"
          className="font-mono text-[0.7rem] text-ash transition-colors hover:text-birch"
        >
          ← {t.wikiBrowse}
        </Link>
        <h1 className="display mt-1 text-base text-birch">{heading || t.wikiBrowse}</h1>
        <p className="mt-0.5 font-mono text-[0.7rem] text-ash">
          {articles.length} {t.wikiArticles}
        </p>
      </header>

      <CategoryView
        lang={lang}
        category={category}
        query={query}
        articles={articles}
        table={table}
        tabs={tabs}
        activeTab={query.tab}
        compare={compare}
      />
    </div>
  );
}
