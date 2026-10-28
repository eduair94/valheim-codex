/**
 * Copy for home, browse, category lists and the compare view.
 *
 * Merged into `STRINGS` by `../strings.ts`. Keys added here override a base
 * key of the same name, so an area can reword its own existing copy without
 * touching the base table. Both languages must carry the same keys; the unit
 * test in `tests/unit/strings.test.ts` fails the build otherwise.
 *
 * `{n}` and `{name}` are filled in by the components; counts go through
 * `countLabel` (components/wiki/lists/format.ts), which picks the singular.
 * The count nouns themselves, the browsing axes' names and the guide card's
 * words are in `../browse-copy.ts`: those components also render inside the
 * search, in the browser, where this table must not go.
 */
export const WIKI_COPY = {
  es: {
    // The first column of a comparison: "Nombre", not "Objeto", since it also
    // lists creatures, places and benches, none of which is an object.
    wikiItem: 'Nombre',

    wikiHomeLede: 'La wiki de Valheim, para consultar a mitad de partida.',
    wikiHomeMetaTitle: 'Valheim Codex — buscá en la wiki de Valheim',
    wikiHomeMetaDescription:
      'Buscá un objeto, criatura o bioma de Valheim, o explorá la wiki por biomas, categorías y estaciones de crafteo.',

    wikiBrowseLede: 'Todos los biomas, categorías y estaciones de crafteo, para cuando no sabés qué buscás.',
    wikiBrowseMetaTitle: 'Explorar — Valheim Codex',
    wikiBrowseMetaDescription:
      'Todos los biomas, categorías y estaciones de crafteo de la wiki de Valheim, para navegar sin saber qué buscás.',

    // The kicker over a list's title: which of the three ways in it is.
    wikiAxisCategory: 'Categoría',
    wikiAxisBiome: 'Bioma',
    wikiAxisStation: 'Estación de crafteo',
    wikiAxisType: 'Tipo',
    wikiViewLabel: 'Vista',
    wikiCategoryMetaDescription: '{name}: {n} de la wiki de Valheim, con la fuente original a la vista.',
    wikiListLoading: 'Cargando la lista…',

    // A comparison only has the articles that carry stats, which is fewer
    // than the list: the count says why the number dropped.
    wikiCompareCount: '{n} con stats',
    wikiCompareMetaDescription: 'Comparación de {name}: {n} con stats, lado a lado, de la wiki de Valheim.',
    wikiCompareRegion: 'Comparación: {name}',
    wikiCompareSortBy: 'Ordenar por',
    wikiCompareOrder: 'Orden',
    // The sort direction button's name; spelled out, since an arrow is read
    // aloud as "flecha".
    wikiCompareLowFirst: 'menor primero',
    wikiCompareHighFirst: 'mayor primero',
    wikiCompareAtoZ: 'de la A a la Z',
    wikiCompareZtoA: 'de la Z a la A',
    wikiCompareShownTab: 'nivel máx. {n}',
    wikiCompareNoValue: 'sin dato',
    wikiCompareNoStats: 'Estos artículos no comparten stats para comparar. La lista los tiene a todos.',
  },
  en: {
    wikiItem: 'Name',

    wikiHomeLede: 'The Valheim wiki, for looking things up mid-game.',
    wikiHomeMetaTitle: 'Valheim Codex — search the Valheim wiki',
    wikiHomeMetaDescription:
      'Find a Valheim item, creature or biome, or browse the wiki by biome, category and crafting station.',

    wikiBrowseLede: 'Every biome, category and crafting station, for when you do not know what you are looking for.',
    wikiBrowseMetaTitle: 'Browse — Valheim Codex',
    wikiBrowseMetaDescription:
      'Every biome, category and crafting station of the Valheim wiki, for browsing without knowing what you are after.',

    wikiAxisCategory: 'Category',
    wikiAxisBiome: 'Biome',
    wikiAxisStation: 'Crafting station',
    wikiAxisType: 'Type',
    wikiViewLabel: 'View',
    wikiCategoryMetaDescription: '{name}: {n} from the Valheim wiki, with the original source in view.',
    wikiListLoading: 'Loading the list…',

    wikiCompareCount: '{n} with stats',
    wikiCompareMetaDescription: '{name} compared: {n} with stats, side by side, from the Valheim wiki.',
    wikiCompareRegion: 'Comparison: {name}',
    wikiCompareSortBy: 'Sort by',
    wikiCompareOrder: 'Order',
    wikiCompareLowFirst: 'lowest first',
    wikiCompareHighFirst: 'highest first',
    wikiCompareAtoZ: 'A to Z',
    wikiCompareZtoA: 'Z to A',
    wikiCompareShownTab: 'max level {n}',
    wikiCompareNoValue: 'no value',
    wikiCompareNoStats: 'These articles share no stats to compare. The list has all of them.',
  },
} as const;
