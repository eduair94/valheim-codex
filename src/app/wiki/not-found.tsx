import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { NotFoundView } from '@/components/shell/not-found-view';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings } from '@/lib/i18n/strings';

/**
 * The tab title of every wiki 404. For a 404 Next uses the layouts' metadata
 * and this module's, never the page's: a filter that matches nothing
 * (`/wiki/c/all?biome=Junk`) is the category page's own `notFound()`, and the
 * category layout has no title for `all`, so it went out as the bare app name.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = strings(parseLang((await cookies()).get(LANG_COOKIE)?.value));
  return { title: `${t.shellNotFoundTitle} — ${t.appName}` };
}

/**
 * A reader page that called `notFound()`, such as an article slug that is not
 * in the index. Rendered inside the wiki layout, so the nav is already there.
 */
export default async function WikiNotFound() {
  const lang = parseLang((await cookies()).get(LANG_COOKIE)?.value);
  return <NotFoundView lang={lang} />;
}
