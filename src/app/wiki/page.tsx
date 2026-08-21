import { cookies } from 'next/headers';
import { SearchView } from '@/components/wiki/search-view';
import { getDb } from '@/lib/db/client';
import { countArticles, listCategories, listFacetValues } from '@/lib/db/wiki-repo';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { mainCategories, mainStations, orderedBiomes } from '@/lib/wiki/browse-groups';

export const dynamic = 'force-dynamic';

/**
 * How much of each axis the front page shows.
 *
 * Enough to be a real choice and few enough to stay above the fold on a phone
 * together with the search field. The biomes are not cut — there are nine of
 * them and they are the spine of the game.
 */
const HOME_CATEGORIES = 8;
const HOME_STATIONS = 6;

export default async function WikiSearchPage() {
  const db = await getDb();
  const [total, categories, biomes, stations, cookieStore] = await Promise.all([
    countArticles(db),
    listCategories(db, 5),
    listFacetValues(db, 'biome'),
    listFacetValues(db, 'station'),
    cookies(),
  ]);
  const lang = parseLang(cookieStore.get(LANG_COOKIE)?.value);

  return (
    <SearchView
      lang={lang}
      totalArticles={total}
      axes={{
        biomes: orderedBiomes(biomes),
        categories: mainCategories(categories, HOME_CATEGORIES),
        stations: mainStations(stations, HOME_STATIONS),
      }}
    />
  );
}
