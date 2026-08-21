import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { SearchView } from '@/components/wiki/search-view';
import { getDb } from '@/lib/db/client';
import { countArticles, listCategories, listFacetValues } from '@/lib/db/wiki-repo';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { mainCategories, mainStations, orderedBiomes } from '@/lib/wiki/browse-groups';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Buscar — Valheim Codex',
  description: 'Buscá un objeto, criatura o bioma de Valheim, o explorá la wiki por biomas, categorías y estaciones de crafteo.',
};

/**
 * How much of each axis the front page shows.
 *
 * Enough to be a real choice and few enough that the whole page is a short
 * scroll on a phone. The biomes are not cut — there are eight of them and they
 * are the spine of the game.
 */
const HOME_TILES = { categories: 8, stations: 6 };

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
      tiles={HOME_TILES}
      axes={{
        biomes: orderedBiomes(biomes),
        categories: mainCategories(categories),
        stations: mainStations(stations),
      }}
    />
  );
}
