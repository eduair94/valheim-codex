import { notFound } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import type { Metadata } from 'next';
import { ArticleView } from '@/components/wiki/article-view';
import { articleTitle, askTitle, clipText } from '@/components/wiki/article/article-meta';
import type { AskTarget } from '@/components/wiki/article/ask-link';
import { isAutomatedReader } from '@/components/wiki/article/crawler';
import { loginHref } from '@/lib/auth/access';
import { getChatPrincipal } from '@/lib/auth/principal-server';
import { getCraftView, type CraftView } from '@/lib/craft/data';
import { getArticlePage, getBrowseAxes, type ArticlePage } from '@/lib/wiki/data';
import { canRequestTranslation } from '@/lib/wiki/translate-policy';
import { articleHref, chatAboutHref } from '@/lib/routes';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings, type Lang } from '@/lib/i18n/strings';
import { siteOpenGraph } from '@/lib/site';
// The article's own styles: its text, tables and infobox, and its crafting
// card and sections. The shell's are in globals.css.
import '@/app/styles/prose.css';
import '@/app/styles/tables.css';
import '@/app/styles/craft.css';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

/** A link preview's description: about what fits in a search result. */
const DESCRIPTION_LENGTH = 160;

/** The card `opengraph-image.tsx` draws. */
const OG_SIZE = { width: 1200, height: 630 };

async function readLang(): Promise<Lang> {
  return parseLang((await cookies()).get(LANG_COOKIE)?.value);
}

/**
 * The tab title, the description and the link preview, in the reader's
 * language and pointing at this article.
 *
 * Link-preview crawlers send no language cookie, so they read the Spanish
 * default; a reader's own tab and history follow their choice (I18N-09). The
 * title is the one the page shows (`articleTitle`): an untranslated article
 * goes by its Spanish name there too, glossed like a translated one. The
 * shared site fields (type, name, locale) are the layout's; `openGraph` is
 * replaced as a whole by a page that sets it, so they come from the same
 * `siteOpenGraph`. `getArticlePage` is shared with the page through React
 * `cache()`: one load per request for both.
 *
 * The preview image is the route's own card (`opengraph-image.tsx`), named
 * here so that its alternative text can say which article it is the card of.
 * A file route can only state one alt for every article; naming the card
 * per article from the file instead (`generateImageMetadata`) moved it to a
 * new address, and every preview already shared would have lost its picture.
 * Set here, the file's own image is not added a second time, and the Twitter
 * card takes the same one.
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const [{ slug }, lang] = await Promise.all([params, readLang()]);
  const t = strings(lang);
  const page = await getArticlePage(slug, lang);
  if (!page) return { title: `${t.shellNotFoundTitle} — ${t.appName}` };

  const path = articleHref(page.article.slug);
  const title = articleTitle(page, lang);
  const description = clipText(describe(page) || t.articleMetaDescription.replace('{title}', title), DESCRIPTION_LENGTH);
  return {
    title: `${title} — ${t.appName}`,
    description,
    alternates: { canonical: path },
    openGraph: {
      ...siteOpenGraph('article', lang),
      url: path,
      title,
      description,
      images: [
        {
          url: `${path}/opengraph-image`,
          width: OG_SIZE.width,
          height: OG_SIZE.height,
          type: 'image/png',
          alt: `${title} — ${t.appName}`,
        },
      ],
    },
  };
}

/** The lead, or for the few articles without one, their first paragraph of prose. */
function describe(page: ArticlePage): string {
  if (page.doc.lead.trim()) return page.doc.lead;
  const first = page.doc.blocks.find((block) => block.kind === 'paragraph' && !block.notice);
  return first?.kind === 'paragraph' ? first.text : '';
}

export default async function ArticleRoutePage({ params }: Params) {
  const [{ slug }, lang] = await Promise.all([params, readLang()]);

  /*
   * One cached load: the article, its translation, the recipe's materials and
   * the names it links (see `getArticlePage`). The route's layout made this
   * same call before anything was sent, and sent unknown and misspelled
   * addresses away; here it is answered from React's per-request cache.
   *
   * Beside it, the item's slice of the recipe graph, for the craft card and
   * the crafting sections. It never takes the article down: `getCraftView`
   * answers null, and says so in the log, when the graph cannot be read, and
   * the page is then the article as it was, recipe rows and all.
   */
  const [page, craft] = await Promise.all([getArticlePage(slug, lang), getCraftView(slug, lang).catch(() => null)]);
  if (!page) notFound();

  // A broken cookie must never take the article down with it: it reads as
  // signed out, which only changes where "ask about this" leads.
  const [principal, requestHeaders, facet] = await Promise.all([
    getChatPrincipal().catch(() => null),
    headers(),
    stationFacet(craft, lang),
  ]);
  const t = strings(lang);

  /*
   * Asking needs a chat sign-in; reading does not. A signed-out reader is
   * sent to the sign-in page with the question kept, rather than to `/`,
   * which bounced them to the wiki home and dropped it (BC-03). The question
   * names the article as the reader sees it, with the English name the wiki
   * uses alongside.
   */
  const about = chatAboutHref(askTitle(articleTitle(page, lang), page.article.title));
  const ask: AskTarget = principal
    ? { href: about, locked: false, lockedNote: t.shellChatNeedsSignIn }
    : { href: loginHref(about), locked: true, lockedNote: t.shellChatNeedsSignIn };

  /*
   * A translation is asked for by the page itself, once it is on screen, on
   * an allowance readers share: not for a reader whose allowance is switched
   * off, and not for a crawler, which would spend everyone's on articles it
   * reads in English just as well.
   */
  const canTranslate = canRequestTranslation(principal) && !isAutomatedReader(requestHeaders.get('user-agent'));

  return (
    <ArticleView
      page={page}
      lang={lang}
      ask={ask}
      canTranslate={canTranslate}
      craft={craft}
      stationFacet={facet}
    />
  );
}

/**
 * For a station's article, the station as the category lists filter by it,
 * for "Qué se fabrica acá": the browse page's own station names, matched to
 * the article ignoring case, since the wiki titles the article "Black Forge"
 * and writes its items' Source rows "Black forge". Null for anything else, a
 * station no article names, or when the list cannot be read: the link is
 * left out rather than leading to an empty list.
 */
async function stationFacet(craft: CraftView | null, lang: Lang): Promise<string | null> {
  if (!craft?.station) return null;
  try {
    const { stations } = await getBrowseAxes(lang);
    const wanted = craft.item.en.toLowerCase();
    return stations.find((station) => station.name.toLowerCase() === wanted)?.name ?? null;
  } catch {
    return null;
  }
}
