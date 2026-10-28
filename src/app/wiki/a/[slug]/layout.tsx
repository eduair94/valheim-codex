import { notFound, permanentRedirect } from 'next/navigation';
import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { getDb } from '@/lib/db/client';
import { cachedSlugs } from '@/lib/db/link-index';
import { articleExists } from '@/lib/db/wiki-repo';
import { getArticlePage } from '@/lib/wiki/data';
import { isSlug, slugify } from '@/lib/wiki/slug';
import { articleHref } from '@/lib/routes';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings, type Lang } from '@/lib/i18n/strings';

/**
 * Decides, before the page renders, whether the address is an article — and
 * whether it can be shown.
 *
 * The route has no loading boundary (`loading.tsx`). One sent the article
 * inside a hidden element that was shown only once all of it had arrived, so
 * the page painted later than without it; a tap is answered by the shell's
 * progress bar (`NavProgress`) instead. Without one, nothing is sent until
 * the page has rendered, so whatever decides the status, here or in the
 * page, is the response's real status.
 *
 * It is still decided here, where it would hold if a loading boundary came
 * back: once a response has started streaming its status is fixed at 200,
 * and a layout is not inside its own segment's boundary.
 *
 * - The article is loaded here (`getArticlePage`); the page and its metadata
 *   then read it from React's per-request cache, so it is still one load per
 *   request. A database that cannot be reached, for an article the data cache
 *   does not hold, is therefore a real 500.
 * - An address `slugify` could not have produced (`Iron_Sword`, `IRON-SWORD`,
 *   `Iron Sword`) is sent to the slug it stands for when that is an article,
 *   the way the ingest names them (BWR-16): a real 308.
 * - Anything else that names no article is a real 404.
 *
 * What can still go wrong after this point is the render itself, a bug: the
 * wiki's error page, with a 500.
 *
 * From the data cache the load is a memory read; an article nobody has
 * opened in the last hour costs its database round trips first.
 */
export default async function ArticleRouteLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const [{ slug }, lang] = await Promise.all([params, readLang()]);
  if (await getArticlePage(slug, lang)) return children;

  // The segment can arrive still percent-encoded ("Iron%20Sword").
  const canonical = slugify(decoded(slug));
  if (canonical !== slug && (await isArticle(canonical))) permanentRedirect(articleHref(canonical));
  notFound();
}

/**
 * The tab title of a missing article. A layout's metadata still applies when
 * it sends the request to the not-found page; the page's own never runs then.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const [{ slug }, lang] = await Promise.all([params, readLang()]);
  if (await getArticlePage(slug, lang)) return {};
  const t = strings(lang);
  return { title: `${t.shellNotFoundTitle} — ${t.appName}` };
}

async function readLang(): Promise<Lang> {
  return parseLang((await cookies()).get(LANG_COOKIE)?.value);
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Whether a canonical slug names an article, without loading it: the link
 * index's slug set, which the process holds in memory for the pages'
 * cross-links (`cachedSlugs`), or one index lookup (`articleExists`) for an
 * article newer than it. Only asked for an address about to be redirected.
 */
async function isArticle(slug: string): Promise<boolean> {
  if (!isSlug(slug)) return false;
  try {
    const db = await getDb();
    if ((await cachedSlugs(db)).has(slug)) return true;
    return await articleExists(db, slug);
  } catch {
    // Nothing to ask: send the reader on, and let the article's own load
    // answer for itself there.
    return true;
  }
}
