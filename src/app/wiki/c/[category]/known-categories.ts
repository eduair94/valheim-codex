import 'server-only';

import { getDb } from '@/lib/db/client';
import { countMatchingArticles } from '@/lib/db/wiki-repo';
import { heldCategoryNames } from '@/lib/wiki/data';

/**
 * The wiki's categories, for the category route's layout to check an address
 * against before the page streams (layout.tsx).
 *
 * The layout runs before every category page and every prefetch of one, so
 * the list comes from memory: the category names the data layer already holds
 * for ten minutes to check filters from URLs (`heldCategoryNames`), the way
 * the article route holds its slugs — a memo per process, not a cache with
 * invalidation to get wrong. A failed read is not held, so the next request
 * asks again.
 */
export function heldCategories(): Promise<ReadonlySet<string>> {
  return heldCategoryNames();
}

/**
 * Whether some article has the category, asked of the database: for a name
 * the held list does not have, which is a typo or a category added since the
 * list was read. One indexed count, and only for an address no link makes.
 */
export async function categoryExists(name: string): Promise<boolean> {
  return (await countMatchingArticles(await getDb(), { category: name })) > 0;
}
