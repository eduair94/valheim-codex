import type { TitleIndexEntry } from '@/lib/db/wiki-repo';
import { prepareTitleIndex, searchTitles, type PreparedTitleIndex } from '@/lib/wiki/title-search';
import type { GraphItem, ItemId, RecipeGraph } from './types';

/**
 * Finding an item of the recipe graph by name, for the planner's two fields:
 * what to add to the list, and what the reader holds.
 *
 * The same matcher as the wiki's search (`title-search.ts`), fed the graph's
 * items instead of articles, so an item answers to what an article does: its
 * Spanish name, its English one, the other names translations use, and the
 * glossary's reading of a Spanish query. Many items have no article of their
 * own (mead bases, building pieces), and the graph names all of them.
 */
export type ItemSearch = { prepared: PreparedTitleIndex; byId: ReadonlyMap<ItemId, GraphItem> };

/**
 * The items a field offers, ready to search; build it once per graph.
 *
 * - `products`: what the list can make, every item with a recipe. Coal,
 *   whose only recipes are the charcoal kiln's alternatives, is planned with
 *   the first of them (`targetStep` in `./plan.ts`).
 * - `all`: every item, for counting what the reader holds.
 */
export function prepareItemSearch(graph: RecipeGraph, filter: 'products' | 'all'): ItemSearch {
  const made = new Set(graph.recipes.map((recipe) => recipe.product));
  const items = filter === 'all' ? graph.items : graph.items.filter((item) => made.has(item.id));
  const entries: TitleIndexEntry[] = items.map((item) => ({
    s: item.id,
    t: item.en,
    c: [],
    ...(item.icon ? { i: item.icon } : {}),
    ...(item.es ? { e: item.es } : {}),
    ...(item.aliases?.length ? { a: item.aliases } : {}),
  }));
  return { prepared: prepareTitleIndex(entries), byId: new Map(items.map((item) => [item.id, item])) };
}

/** The best matches first, at most `limit`; nothing for a blank query. */
export function searchItems(search: ItemSearch, query: string, limit = 8): GraphItem[] {
  return searchTitles(search.prepared, query, limit).flatMap(({ entry }) => {
    const item = search.byId.get(entry.s);
    return item ? [item] : [];
  });
}
