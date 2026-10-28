import { getDb } from '@/lib/db/client';
import type { Db } from '@/lib/db/create-db';
import { ensureSearchIndexes, searchContent } from '@/lib/db/wiki-repo';
import { accentIndex } from '@/lib/rag/tsquery';
import { getSearchVocabularyData } from '@/lib/wiki/data';
import { createSearchLimiter, searchLimitFromEnv } from '@/lib/wiki/search-limit';
import { clientIp } from '@/lib/auth/client-ip';
import { describeError, logError, logWarn } from '@/lib/log';

export const runtime = 'nodejs';

/** Longer than any name or question anyone types; the rest is cut, not refused. */
const MAX_QUERY = 200;

/**
 * Control characters. A typed query never holds one, and Postgres refuses a
 * NUL in text outright, which used to surface as a 500.
 */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Repeated queries should be answered by the CDN rather than by the database.
 * Popular terms are heavily repeated and the corpus only changes on a
 * re-index, so a few minutes at the edge costs nothing in freshness and
 * takes the load off a metered Postgres. The language is in the URL, never a
 * cookie, so a cached answer is right for whoever gets it.
 */
const CACHEABLE = { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600' };

/** Errors are about this request; no cache should keep them. */
const UNCACHEABLE = { 'Cache-Control': 'no-store' };

/** Sixty searches a minute per address (`WIKI_SEARCH_PER_MINUTE`); see search-limit.ts. */
const limiter = createSearchLimiter(searchLimitFromEnv());

/**
 * The translations' search index, created once per process when a deploy
 * skipped the migration. Not awaited by the search that starts it: without
 * the index the search is slower, never wrong.
 */
let indexes: Promise<void> | null = null;
function ensureIndexesOnce(db: Db): void {
  indexes ??= ensureSearchIndexes(db).then(
    (created) => {
      if (created) logWarn('wiki-search', 'created article_translations_search_idx (drizzle/0007 had not run)');
    },
    (error: unknown) => {
      logWarn('wiki-search', `could not create the translation search index: ${describeError(error).message}`);
    },
  );
}

/**
 * Full-text search over article bodies.
 *
 * The companion to the client-side title search: titles are matched in the
 * browser, and this answers "the words I remember are in the article, not its
 * name". `?q=` is the query, `?lang=es|en` the language of the names and
 * snippets returned (Spanish when absent, the reader's default).
 *
 * Malformed input is a 400 with a code, not a 500: a control character in
 * the query or an unknown language. An address searching faster than anyone
 * types gets a 429 with `Retry-After`.
 */
export async function GET(request: Request): Promise<Response> {
  // Public, like the reader it serves: article text already published on a
  // public wiki, answered by one indexed query. Nothing here spends tokens.
  const params = new URL(request.url).searchParams;
  const raw = params.get('q') ?? '';
  const langParam = params.get('lang');

  if (langParam !== null && langParam !== 'es' && langParam !== 'en') {
    return Response.json({ error: 'invalid_lang' }, { status: 400, headers: UNCACHEABLE });
  }
  if (CONTROL.test(raw)) {
    return Response.json({ error: 'invalid_query' }, { status: 400, headers: UNCACHEABLE });
  }

  const query = raw.slice(0, MAX_QUERY);
  if (!query.trim()) return Response.json({ hits: [] }, { headers: CACHEABLE });
  const lang = langParam ?? 'es';

  const decision = limiter.take(clientIp(request.headers));
  if (!decision.allowed) {
    return Response.json(
      { error: 'rate_limited', retryAfter: decision.retryAfterSeconds },
      { status: 429, headers: { ...UNCACHEABLE, 'Retry-After': String(decision.retryAfterSeconds) } },
    );
  }

  try {
    const [db, words] = await Promise.all([
      getDb(),
      // Folding is an improvement, not a requirement: without the word list
      // an unaccented query still finds unaccented text.
      getSearchVocabularyData().catch((error: unknown) => {
        logError('wiki-search', error, { stage: 'vocabulary' });
        return [] as string[];
      }),
    ]);
    ensureIndexesOnce(db);
    const hits = await searchContent(db, query, 20, { lang, accents: accentIndex(words) });
    return Response.json({ hits }, { headers: CACHEABLE });
  } catch (error) {
    logError('wiki-search', error, { length: query.length, lang });
    return Response.json({ error: 'search_failed' }, { status: 500, headers: UNCACHEABLE });
  }
}
