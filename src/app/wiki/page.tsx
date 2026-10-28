import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { SEARCH_HREF } from '@/components/shell/nav-model';
import { IntentPrefetch } from '@/components/wiki/article/intent-prefetch';
import { BrowseAxes } from '@/components/wiki/browse-axes';
import { FeaturedGuideCard } from '@/components/wiki/featured-guide-card';
import { SearchView } from '@/components/wiki/search-view';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings, type Lang } from '@/lib/i18n/strings';
import { getBrowseAxes } from '@/lib/wiki/data';

export const dynamic = 'force-dynamic';

async function readerLang(): Promise<Lang> {
  return parseLang((await cookies()).get(LANG_COOKIE)?.value);
}

/*
 * In the reader's language, like the page. Only the title and description:
 * the link preview fills its own title and description from these, and the
 * rest of it (the site's name, the locale) is the layout's, which follows the
 * page's language too (`siteOpenGraph`); a crawler sends no language cookie
 * and gets the Spanish page. `?q=` result pages are this page with a query,
 * so they share its address.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = strings(await readerLang());
  return {
    title: t.wikiHomeMetaTitle,
    description: t.wikiHomeMetaDescription,
    alternates: { canonical: SEARCH_HREF },
  };
}

/**
 * How much of each axis the front page shows.
 *
 * Enough to be a real choice and few enough that the whole page is a short
 * scroll on a phone. Eight of each, because the grid is two columns on a phone
 * and four from a tablet up, and eight fills every row of both; six stations
 * left a row half empty from 1024px. The biomes are not cut — there are eight
 * of them and they are the spine of the game.
 */
const HOME_TILES = { categories: 8, stations: 8 };

/**
 * The wiki's front page: who this is, the search, and the ways in.
 *
 * The heading is the product's name. On a phone the nav is a bottom bar with
 * no name on it, so without one the first screen never said whose app this
 * was; on a desktop it is also the page's only `h1`. The search keeps the
 * search column's width, and the browsing axes below it take the full width.
 *
 * The ways in are rendered here, on the server, and handed to the search to
 * place: it shows them until something is typed. They are links and
 * pictures, so the browser gets them as HTML, once, rather than the code
 * that draws them; the search used to draw them itself, which sent both.
 */
export default async function WikiHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [lang, params] = await Promise.all([readerLang(), searchParams]);
  const t = strings(lang);
  const { total, biomes, categories, stations } = await getBrowseAxes(lang);
  // As `useSearchParams().get('q')` reads it: the first, when there are several.
  const q = params.q;
  const serverQuery = (Array.isArray(q) ? q[0] : q) ?? '';

  return (
    <>
      <header className="mb-5 max-w-2xl sm:mb-6">
        <h1 className="display text-2xl leading-tight text-birch sm:text-4xl">{t.appName}</h1>
        <p className="mt-2 text-ash">{t.wikiHomeLede}</p>
      </header>
      <SearchView
        lang={lang}
        serverQuery={serverQuery}
        browse={
          // The tiles and the guide's card fetch their page once the reader
          // points at, touches or tabs to one, as on the browse page.
          <IntentPrefetch as="div">
            <p className="mb-5 font-mono text-xs text-ash">{t.wikiSearchEmpty.replace('{n}', String(total))}</p>
            <FeaturedGuideCard lang={lang} />
            <BrowseAxes lang={lang} data={{ biomes, categories, stations }} tiles={HOME_TILES} overflow="link" />
          </IntentPrefetch>
        }
      />
    </>
  );
}
