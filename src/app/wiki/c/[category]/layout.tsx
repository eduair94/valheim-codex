import { cache } from 'react';
import { cookies } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import type { Metadata } from 'next';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings } from '@/lib/i18n/strings';
import { categoryFromParam, categoryHref, resolveCategorySegment, type CategorySegment } from '@/lib/routes';
import { categoryExists, heldCategories } from './known-categories';

/**
 * Decides, before the page renders, whether the address names a category.
 *
 * The route has no loading boundary, so nothing is sent until the page has
 * rendered, and a `notFound()` or a `permanentRedirect()`, here or in the
 * page, is a real 404 or 308. When it had one, a response that had started
 * streaming had already said 200: an unknown category the page found then was
 * a "not found" page served as a success, which crawlers file as a soft 404
 * and the service worker kept as a saved page. The answer is still given
 * here, where a loading boundary that came back could not reach it (a layout
 * is not inside its own segment's boundary) — as the article route does.
 *
 * - The `all` sentinel passes: its facets are in the query, which only the
 *   page receives, so a facet that matches nothing is the page's to answer,
 *   with a real 404 as well.
 * - A category spelled another way (`resolveCategorySegment`) is sent to
 *   the one it stands for. The redirect cannot keep the query, which a
 *   layout is not given either: a broken compare link lands on the list,
 *   which is also the address every view of a category names as canonical.
 * - Anything else that names no category is a 404.
 *
 * Kept cheap, since it runs before every category page and every prefetch
 * of one: the names come from a list held in memory (`heldCategories`), and
 * only a name missing from it costs one indexed count.
 */
export default async function CategoryRouteLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  const segment = await segmentFor(categoryFromParam(category));
  if (segment.kind === 'moved') permanentRedirect(categoryHref(segment.name));
  if (segment.kind === 'missing') notFound();
  return children;
}

/**
 * The tab title of a missing category. A layout's metadata still applies
 * when it sends the request to the not-found page; the page's own does not.
 * The param arrives decoded here, unlike the layout's (`categoryFromParam`).
 */
export async function generateMetadata({ params }: { params: Promise<{ category: string }> }): Promise<Metadata> {
  const { category } = await params;
  if ((await segmentFor(category)).kind !== 'missing') return {};
  const t = strings(parseLang((await cookies()).get(LANG_COOKIE)?.value));
  return { title: `${t.shellNotFoundTitle} — ${t.appName}` };
}

/**
 * Shared by the layout and its metadata: one lookup per request. `moved` and
 * `missing` are final; `unlisted` is settled by the database.
 */
const segmentFor = cache(async (name: string): Promise<Exclude<CategorySegment, { kind: 'unlisted' }>> => {
  let categories: ReadonlySet<string>;
  try {
    categories = await heldCategories();
  } catch {
    // Nothing to ask: the page decides, as it did before this check existed.
    return { kind: 'category' };
  }
  const segment = resolveCategorySegment(name, categories);
  if (segment.kind !== 'unlisted') return segment;
  try {
    return (await categoryExists(name)) ? { kind: 'category' } : { kind: 'missing' };
  } catch {
    return { kind: 'category' };
  }
});
