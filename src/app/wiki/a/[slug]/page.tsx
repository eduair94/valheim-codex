import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { ArticleView } from '@/components/wiki/article-view';
import { AskButton } from '@/components/wiki/ask-button';
import { getDb } from '@/lib/db/client';
import { getArticleBySlug } from '@/lib/db/wiki-repo';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';

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

  return (
    <>
      <ArticleView
        title={article.title}
        url={article.url}
        categories={article.categories}
        doc={article.doc}
        lang={lang}
      />

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
