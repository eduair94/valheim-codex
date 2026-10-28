import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { GuideContent } from '@/components/wiki/guide/guide-content';
import { prepareGuide } from '@/components/wiki/guide/guide-request';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings, type Lang } from '@/lib/i18n/strings';
import { siteOpenGraph } from '@/lib/site';
// The guide's own styles, and the phone cards its tables share (tables.css). The shell's are in globals.css.
import '@/app/styles/tables.css';
import '@/app/styles/guide.css';

async function readerLang(): Promise<Lang> {
  return parseLang((await cookies()).get(LANG_COOKIE)?.value);
}

/*
 * In the reader's language, like the page. The link preview is still Spanish:
 * a crawler sends no language cookie, and `opengraph-image.tsx` alongside is
 * drawn once.
 *
 * `openGraph` starts from `siteOpenGraph` because a page's `openGraph`
 * replaces the layout's rather than merging into it — leaving out `siteName`
 * and `type` here would drop them from the guide's preview.
 */
export async function generateMetadata(): Promise<Metadata> {
  const lang = await readerLang();
  const t = strings(lang);
  return {
    title: t.guideMetaTitle,
    description: t.guideMetaDescription,
    openGraph: {
      ...siteOpenGraph('article', lang),
      title: t.guideMetaTitle,
      description: t.guideMetaDescription,
      url: '/wiki/guide',
    },
    twitter: {
      card: 'summary_large_image',
      title: t.guideMetaTitle,
      description: t.guideMetaDescription,
    },
  };
}

/**
 * The completion guide.
 *
 * Every other page under `/wiki` reads its content from Postgres — this one
 * doesn't, because there is no wiki page titled "how do I finish the game".
 * The guide is hand-written and lives in the repo instead of the DB
 * (`guide-data.tsx`), in Spanish and in English. The database is read only to
 * point each item name at its article, through the link index in the shared
 * data cache, and the guide renders without it, without waiting, if the
 * database is slow or down (`prepareGuide`).
 */
export default async function GuidePage() {
  const lang = await readerLang();
  await prepareGuide(lang);
  return <GuideContent lang={lang} />;
}
