/**
 * Copy for wiki search: the search page, title index and content search.
 *
 * Merged into `STRINGS` by `../strings.ts`. Keys added here override a base
 * key of the same name, so an area can reword its own existing copy without
 * touching the base table. Both languages must carry the same keys; the unit
 * test in `tests/unit/strings.test.ts` fails the build otherwise.
 */
export const SEARCH_COPY = {
  es: {
    // Overrides the base copy. "Probá con el nombre en inglés" was the only
    // useful advice while Spanish names were not searchable; now they are,
    // and the empty state is only shown once both searches have answered.
    wikiNoResults: 'Sin resultados. Probá con otra palabra o explorá por categorías.',
    wikiSearchEmpty: 'Escribí para buscar entre {n} artículos, en español o en inglés.',

    searchLoading: 'Buscando…',
    searchLoadingTitles: 'Buscando por nombre…',
    searchLoadingContent: 'Buscando dentro del texto…',
    searchContentFailed: 'No se pudo buscar dentro del texto.',
    searchIndexFailed: 'No se pudieron cargar los títulos: se busca solo dentro del texto.',
    searchBrowseLink: 'Explorar la wiki',
    searchByName: 'Por nombre',
    searchResultsLabel: 'Resultados de la búsqueda',
    searchResultsOne: '1 resultado',
    searchResultsMany: '{n} resultados',
  },
  en: {
    wikiNoResults: 'No results. Try another word, or browse by category.',
    wikiSearchEmpty: 'Type to search {n} articles, in English or Spanish.',

    searchLoading: 'Searching…',
    searchLoadingTitles: 'Searching by name…',
    searchLoadingContent: 'Searching the article text…',
    searchContentFailed: 'Could not search the article text.',
    searchIndexFailed: 'Titles could not be loaded: searching the article text only.',
    searchBrowseLink: 'Browse the wiki',
    searchByName: 'By name',
    searchResultsLabel: 'Search results',
    searchResultsOne: '1 result',
    searchResultsMany: '{n} results',
  },
} as const;
