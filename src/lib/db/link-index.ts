import type { Db } from './create-db';
import { getLinkIndex } from './wiki-repo';
import type { LinkTarget } from '@/lib/wiki/links';

/**
 * The link index, held in memory for a while.
 *
 * Every article page needs the whole list of names to find the ones it
 * mentions, and the list is the same for every page: a thousand titles that
 * change only when the wiki is re-indexed or an article is translated for the
 * first time. Reading it from a metered database on every view would make the
 * cross-links the most expensive thing on the page. Ten minutes is short
 * enough that a fresh translation's Spanish title starts linking the same
 * afternoon, and long enough that a reader clicking through five articles
 * pays for the list once.
 *
 * Per process, deliberately: the page is dynamic and this is a memo, not a
 * cache with invalidation semantics to get wrong.
 */
const TTL_MS = 10 * 60 * 1000;

const held = new Map<string, { at: number; index: Promise<LinkTarget[]> }>();

export function cachedLinkIndex(db: Db, lang: string, now = Date.now()): Promise<LinkTarget[]> {
  const entry = held.get(lang);
  if (entry && now - entry.at < TTL_MS) return entry.index;

  const index = getLinkIndex(db, lang).catch((error: unknown) => {
    // A failed load must not be served for ten minutes.
    held.delete(lang);
    throw error;
  });
  held.set(lang, { at: now, index });
  return index;
}
