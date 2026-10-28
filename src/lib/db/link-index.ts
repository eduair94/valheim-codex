import type { Db } from './create-db';
import { getLinkIndex } from './wiki-repo';
import { buildLinker, type Linker, type LinkTarget } from '@/lib/wiki/links';

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

type Entry = {
  at: number;
  index: Promise<LinkTarget[]>;
  /** Compiled from this entry's index, once, the first time a page asks. */
  linker?: Promise<{ index: LinkTarget[]; linker: Linker }>;
  /** Every slug in this entry's index, collected once. */
  slugs?: Promise<ReadonlySet<string>>;
};

const held = new Map<string, Entry>();

function entryFor(db: Db, lang: string, now: number): Entry {
  const entry = held.get(lang);
  if (entry && now - entry.at < TTL_MS) return entry;

  const index = getLinkIndex(db, lang).catch((error: unknown) => {
    // A failed load must not be served for ten minutes.
    held.delete(lang);
    throw error;
  });
  const fresh: Entry = { at: now, index };
  held.set(lang, fresh);
  return fresh;
}

export function cachedLinkIndex(db: Db, lang: string, now = Date.now()): Promise<LinkTarget[]> {
  return entryFor(db, lang, now).index;
}

/**
 * The index and its compiled linker, built once per load of the index.
 *
 * Compiling is the expensive half: one regular expression over about 1,800
 * names, which cost 12 ms on a short article and 180 ms on the longest when
 * it ran on every request. The pattern is the same for every page in a
 * language, so it is compiled when the index is loaded and reused until the
 * index is; a page's own article is applied at lookup time, not baked in.
 */
export function cachedLinker(
  db: Db,
  lang: string,
  now = Date.now(),
): Promise<{ index: LinkTarget[]; linker: Linker }> {
  const entry = entryFor(db, lang, now);
  entry.linker ??= entry.index.then((index) => ({ index, linker: buildLinker(index) }));
  return entry.linker;
}

/**
 * Every article's slug, as of the last load of the index: what lets a page
 * tell an article from an address nobody wrote without asking the database.
 *
 * Any language's index names every article once (the translated names are
 * extra entries), so the English one serves for all of them, and it is the
 * one the article route already holds. A slug missing from it is not proof
 * the article is missing — it may be newer than the index — only that the
 * database has to be asked.
 */
export function cachedSlugs(db: Db, now = Date.now()): Promise<ReadonlySet<string>> {
  const entry = entryFor(db, 'en', now);
  entry.slugs ??= entry.index.then((index) => new Set(index.map((target) => target.slug)));
  return entry.slugs;
}
