import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { ArticleView } from '@/components/wiki/article-view';
import { AskButton } from '@/components/wiki/ask-button';
import { TranslateOnView } from '@/components/wiki/translate-on-view';
import { getDb } from '@/lib/db/client';
import { getArticleBySlug, getTranslation } from '@/lib/db/wiki-repo';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings } from '@/lib/i18n/strings';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticleBySlug(await getDb(), slug);
  if (!article) return { title: 'Valheim Codex' };
  return {
    title: `${article.title} — Valheim Codex`,
    description: article.doc.lead.slice(0, 160) || undefined,
  };
}

export default async function ArticlePage({ params }: Params) {
  const { slug } = await params;
  const db = await getDb();
  const article = await getArticleBySlug(db, slug);
  if (!article) notFound();

  const lang = parseLang((await cookies()).get(LANG_COOKIE)?.value);
  const t = strings(lang);

  /*
   * The translation is resolved here rather than fetched by the browser, so a
   * Spanish reader gets Spanish in the first response — no flash of English,
   * and it works with JavaScript off. The client component below only exists
   * to create a translation that does not exist yet.
   *
   * English is the source language and needs no lookup.
   */
  const translation = lang === 'es' ? await getTranslation(db, article.pageKey, lang) : null;

  const title = translation?.title ?? article.title;
  const doc = translation
    ? {
        ...article.doc,
        lead: translation.doc.lead,
        blocks: translation.doc.blocks,
        infobox: translation.doc.infobox,
      }
    : article.doc;

  return (
    <>
      <ArticleView
        title={title}
        url={article.url}
        categories={article.categories}
        doc={doc}
        lang={lang}
      />

      {/*
       * Said plainly rather than hidden. This text was translated by a model
       * from an English wiki, and a reader deciding whether to trust a
       * crafting cost deserves to know that before they mine the iron.
       */}
      {translation ? (
        <p className="mt-4 text-[0.8rem] text-ash">
          {t.wikiTranslated}
          {translation.stale ? ` · ${t.wikiTranslationStale}` : ''}
        </p>
      ) : null}

      {lang === 'es' && !translation ? <TranslateOnView slug={slug} lang={lang} /> : null}

      {/*
       * Clears the floating ask button, which is fixed and would otherwise
       * cover the last rows of the infobox for good. It hides while scrolling
       * down, so the overlap is only visible once the reader stops — which is
       * exactly when they are trying to read what is under it.
       */}
      <div aria-hidden="true" className="h-28 sm:h-16" />

      <AskButton title={article.title} lang={lang} />
    </>
  );
}
