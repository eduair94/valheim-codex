import type { MetadataRoute } from 'next';
import { CRAFT_PLANNER_LIVE } from '@/lib/craft/feature';
import { getDb } from '@/lib/db/client';
import { getTitleIndex, listCategories } from '@/lib/db/wiki-repo';
import { logError } from '@/lib/log';
import { articleHref, categoryHref } from '@/lib/routes';
import { SITE_URL } from '@/lib/site';
import { isMaintenanceCategory } from '@/lib/wiki/browse-groups';

/**
 * Every page of the reader: its sections, each category and each article.
 *
 * Rendered per request, never at build time. The Docker build has no
 * database to read, so a prerendered sitemap would either fail the build or
 * bake in an empty list.
 *
 * URLs go through the same href builders as the app's links, which also
 * percent-encode them: Next writes `<loc>` without XML-escaping, and a
 * category such as "Stacks & Piles" would otherwise break the document.
 *
 * Not the wiki's bookkeeping categories ("Stubs", "Candidates for deletion",
 * "Pages with broken file links"), which every list a reader sees already
 * leaves out: nothing on the site links to them, and this would have been
 * the one place asking search engines to index them under the site's name.
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const sections: MetadataRoute.Sitemap = ['/wiki', '/wiki/browse', ...(CRAFT_PLANNER_LIVE ? ['/wiki/craft'] : []), '/wiki/guide'].map((path) => ({
    url: `${SITE_URL}${path}`,
  }));

  try {
    const db = await getDb();
    const [articles, categories] = await Promise.all([getTitleIndex(db), listCategories(db, 1)]);
    return [
      ...sections,
      ...categories
        .filter((category) => !isMaintenanceCategory(category.name))
        .map((category) => ({ url: `${SITE_URL}${categoryHref(category.name)}` })),
      ...articles.map((article) => ({ url: `${SITE_URL}${articleHref(article.s)}` })),
    ];
  } catch (error) {
    // A crawler is better served by the sections than by an error page.
    logError('sitemap', error);
    return sections;
  }
}
