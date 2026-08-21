import { cookies } from 'next/headers';
import { BrowseAxes } from '@/components/wiki/browse-axes';
import { getDb } from '@/lib/db/client';
import { listCategories, listFacetValues } from '@/lib/db/wiki-repo';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { mainCategories, mainStations, orderedBiomes } from '@/lib/wiki/browse-groups';

export const dynamic = 'force-dynamic';

/** Effectively no cut: the browse tab is where the whole list belongs. */
const ALL = Number.MAX_SAFE_INTEGER;

/**
 * Browsing, for when you do not know what you are looking for.
 *
 * The same three axes the front page opens with, at full length. The front page
 * shows their head; this is the rest of them, so following "see all" lands
 * somewhere recognisable rather than on a differently-shaped page.
 */
export default async function BrowsePage() {
  const db = await getDb();
  const [categories, biomes, stations, cookieStore] = await Promise.all([
    listCategories(db, 5),
    listFacetValues(db, 'biome'),
    listFacetValues(db, 'station'),
    cookies(),
  ]);
  const lang = parseLang(cookieStore.get(LANG_COOKIE)?.value);

  return (
    <BrowseAxes
      lang={lang}
      data={{
        biomes: orderedBiomes(biomes),
        categories: mainCategories(categories, ALL),
        stations: mainStations(stations, ALL),
      }}
    />
  );
}
