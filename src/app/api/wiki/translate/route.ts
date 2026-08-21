import { getSession } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { getArticleBySlug, getTranslation, saveTranslation } from '@/lib/db/wiki-repo';
import { translateArticle } from '@/lib/wiki/translate';

export const runtime = 'nodejs';

/**
 * A Spanish version of an article, translated once and then served from cache.
 *
 * Reading a translation is public, like the rest of the reader. Creating one
 * is not: it spends model tokens on the operator's account, which is the same
 * exposure the password exists to contain on the chat. So an anonymous visitor
 * gets whatever has already been translated and English otherwise, and a
 * signed-in reader browsing in Spanish warms the cache for everyone.
 *
 * The cost of the whole feature is therefore bounded by the articles people
 * actually open, once each, rather than by traffic.
 */

/** Languages worth translating into. English is the source and needs no entry. */
const SUPPORTED = new Set(['es']);

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const slug = params.get('slug')?.slice(0, 200) ?? '';
  const lang = params.get('lang')?.slice(0, 8) ?? '';

  if (!slug || !SUPPORTED.has(lang)) {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  const db = await getDb();
  const article = await getArticleBySlug(db, slug);
  if (!article) return Response.json({ error: 'not_found' }, { status: 404 });

  const cached = await getTranslation(db, article.pageKey, lang);

  /*
   * A stale translation is still served rather than withheld. The article
   * changed since it was translated, so some of it is now out of date — but a
   * mostly-current Spanish article beats an English one for a reader who does
   * not read English, and the re-translation happens on the next signed-in
   * visit.
   */
  if (cached && !cached.stale) {
    return Response.json(
      { title: cached.title, doc: cached.doc, cached: true },
      { headers: { 'Cache-Control': 'public, max-age=300, s-maxage=86400' } },
    );
  }

  const session = await getSession();
  if (!session) {
    if (cached) {
      return Response.json({ title: cached.title, doc: cached.doc, cached: true, stale: true });
    }
    // Not an error the reader should see as a failure: the page simply stays
    // in English, which is what it was already showing.
    return Response.json({ error: 'translation_requires_session' }, { status: 403 });
  }

  const { doc, title, model, failed } = await translateArticle(article.doc, article.title, lang);

  // Nothing came back translated: storing that would cache a copy of the
  // English article under a Spanish key and never retry it.
  if (model === 'none' || failed > 0) {
    console.warn(`[translate] ${slug}: ${failed} strings failed via ${model}; not caching`);
    return Response.json({ error: 'translation_failed', model }, { status: 503 });
  }

  await saveTranslation(db, {
    pageKey: article.pageKey,
    lang,
    title,
    doc,
    model,
    sourceUpdatedAt: article.updatedAt,
  });

  return Response.json({ title, doc, cached: false, model });
}
