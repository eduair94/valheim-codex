import { cookies } from 'next/headers';
import { BrowseAxes } from '@/components/wiki/browse-axes';
import { getDb } from '@/lib/db/client';
import { listCategories, listFacetValues } from '@/lib/db/wiki-repo';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { mainCategories, mainStations, orderedBiomes } from '@/lib/wiki/browse-groups';

export const dynamic = 'force-dynamic';

/**
 * How many groups get a picture here.
 *
 * More than the front page, because this is the page you came to in order to
 * look — but not all of them. Past a dozen the groups are things like
 * "Polearms, 5", and giving every one a tile makes the page a wall and takes
 * the meaning out of having a picture at all. The rest are listed by name
 * underneath.
 */
const BROWSE_TILES = { categories: 12, stations: 8 };

/**
 * Browsing, for when you do not know what you are looking for.
 *
 * The same three axes the front page opens with, at full length, so following
 * "see all" lands somewhere recognisable rather than on a differently-shaped
 * page.
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
      tiles={BROWSE_TILES}
      overflow="chips"
      data={{
        biomes: orderedBiomes(biomes),
        categories: mainCategories(categories),
        stations: mainStations(stations),
      }}
    />
  );
}
