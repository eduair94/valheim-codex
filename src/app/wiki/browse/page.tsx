import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { BROWSE_HREF } from '@/components/shell/nav-model';
import { IntentPrefetch } from '@/components/wiki/article/intent-prefetch';
import { BrowseAxes } from '@/components/wiki/browse-axes';
import { FeaturedGuideCard } from '@/components/wiki/featured-guide-card';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings, type Lang } from '@/lib/i18n/strings';
import { getBrowseAxes } from '@/lib/wiki/data';

export const dynamic = 'force-dynamic';

async function readerLang(): Promise<Lang> {
  return parseLang((await cookies()).get(LANG_COOKIE)?.value);
}

/* In the reader's language; the link preview takes its text from these. */
export async function generateMetadata(): Promise<Metadata> {
  const t = strings(await readerLang());
  return {
    title: t.wikiBrowseMetaTitle,
    description: t.wikiBrowseMetaDescription,
    alternates: { canonical: BROWSE_HREF },
  };
}

/**
 * How many groups get a picture here.
 *
 * More than the front page, because this is the page you came to in order to
 * look — but not all of them. Past a dozen the groups are things like
 * "Polearms, 5", and giving every one a tile makes the page a wall and takes
 * the meaning out of having a picture at all. The rest are listed by name
 * underneath. Twelve and eight fill every row at two columns and at four.
 */
const BROWSE_TILES = { categories: 12, stations: 8 };

/**
 * Browsing, for when you do not know what you are looking for.
 *
 * The same three axes the front page opens with, at full length, so following
 * "see all" lands somewhere recognisable rather than on a differently-shaped
 * page.
 */
export default async function BrowsePage() {
  const lang = await readerLang();
  const t = strings(lang);
  const { biomes, categories, stations } = await getBrowseAxes(lang);

  return (
    // The tiles, the names under them and the guide's card fetch their page
    // once the reader points at, touches or tabs to one.
    <IntentPrefetch as="div">
      <header className="mb-6 sm:mb-8">
        <h1 className="display text-2xl leading-tight text-birch sm:text-3xl">{t.wikiBrowse}</h1>
        <p className="mt-2 max-w-[65ch] text-ash">{t.wikiBrowseLede}</p>
      </header>
      <FeaturedGuideCard lang={lang} />
      <BrowseAxes lang={lang} tiles={BROWSE_TILES} overflow="chips" data={{ biomes, categories, stations }} />
    </IntentPrefetch>
  );
}
