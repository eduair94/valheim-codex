/**
 * Copy for the browsing components that render on both sides of the
 * server/client boundary: the guide card, the browsing axes and the tile
 * counts are Server Components on the browse page and part of the search, a
 * Client Component, on the wiki's front page.
 *
 * Such a component can neither read the table from `LangProvider` (a hook,
 * which a Server Component cannot call) nor import `strings.ts` (the whole
 * table, both languages, would ship with the search). So its words live here,
 * few enough to ship in both languages, and `strings.ts` merges them into the
 * table like any area's copy: everything else still reads them as `t.<key>`.
 *
 * Both languages must carry the same keys; `tests/unit/strings.test.ts` fails
 * otherwise. `{n}` is filled in by `countLabel`
 * (components/wiki/lists/format.ts), which picks the singular.
 */
export const BROWSE_COPY = {
  es: {
    wikiCategories: 'Categorías',
    wikiBiomes: 'Biomas',
    wikiBiomesHint: 'En el orden en que el juego te los va abriendo.',
    wikiStations: 'Estaciones de crafteo',
    wikiSeeAll: 'Ver todo',
    wikiGuideTitle: 'Guía 100%',
    wikiGuideTeaser: 'Los 7 jefes, bioma por bioma, con checklist.',
    wikiCountOne: '{n} artículo',
    wikiCountMany: '{n} artículos',
  },
  en: {
    wikiCategories: 'Categories',
    wikiBiomes: 'Biomes',
    wikiBiomesHint: 'In the order the game opens them up to you.',
    wikiStations: 'Crafting stations',
    wikiSeeAll: 'See all',
    wikiGuideTitle: '100% Guide',
    wikiGuideTeaser: 'All 7 bosses, biome by biome, with a checklist.',
    wikiCountOne: '{n} article',
    wikiCountMany: '{n} articles',
  },
} as const;
