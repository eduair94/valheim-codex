import { cookies } from 'next/headers';
import { SearchView } from '@/components/wiki/search-view';
import { getDb } from '@/lib/db/client';
import { countArticles } from '@/lib/db/wiki-repo';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';

export const dynamic = 'force-dynamic';

export default async function WikiSearchPage() {
  const db = await getDb();
  const [total, cookieStore] = await Promise.all([countArticles(db), cookies()]);
  const lang = parseLang(cookieStore.get(LANG_COOKIE)?.value);

  return <SearchView lang={lang} totalArticles={total} />;
}
