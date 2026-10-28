import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { NotFoundView } from '@/components/shell/not-found-view';
import { WikiFrame } from '@/components/shell/wiki-frame';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings } from '@/lib/i18n/strings';

export async function generateMetadata(): Promise<Metadata> {
  const t = strings(parseLang((await cookies()).get(LANG_COOKIE)?.value));
  return { title: `${t.shellNotFoundTitle} — ${t.appName}` };
}

/**
 * Every address that matches no route at all, `/wiki/brwse` included.
 *
 * Next renders this inside the root layout only, outside the wiki layout, so
 * it draws the reader's frame itself: without it the page had no nav, no
 * search and no way back.
 */
export default async function NotFound() {
  const lang = parseLang((await cookies()).get(LANG_COOKIE)?.value);
  return (
    <WikiFrame>
      <NotFoundView lang={lang} />
    </WikiFrame>
  );
}
