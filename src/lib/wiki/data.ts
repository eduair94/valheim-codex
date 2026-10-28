import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { getDb } from '@/lib/db/client';
import { cachedLinker, cachedSlugs } from '@/lib/db/link-index';
import {
  articleExists,
  buildCompareTable,
  countArticles,
  countMatchingArticles,
  getArticleBySlug,
  getIngredientTargets,
  getLinkIndex,
  getSearchIndex,
  getSearchVocabulary,
  getTitleIndex,
  listArticles,
  listBiomeEvidence,
  listCategories,
  listCompareTabs,
  listFacetValues,
  listFilterValues,
  type ArticleSummary,
  type BrowseFilter,
  type CategorySummary,
  type CompareTable,
  type IngredientTarget,
  type StoredArticle,
  type StoredTranslation,
  type TitleIndexEntry,
} from '@/lib/db/wiki-repo';
import { termLabel, type TermKind } from '@/lib/i18n/terms';
import type { Lang } from '@/lib/i18n/strings';
import type { ArticleDoc, ArticleImage } from './article-types';
import { articleBiome, mainCategories, mainStations, orderedBiomes, type Biome } from './browse-groups';
import { collectArticleLinks, type Linker, type LinkTarget } from './links';
import { pairRecipeSources, recipeLookups } from './recipe';
import { isSlug } from './slug';
import { TRANSLATION_MAX_FAILURES } from './translate-policy';
import { readCachedTranslation } from './translate-store';

/**
 * The wiki's data, cached, for the pages that render it.
 *
 * The corpus changes when the wiki is re-indexed or an article is translated,
 * and otherwise not at all; every reader of a page in a language sees the same
 * data. Read from the metered database on every view, though, it cost one to
 * three round trips per page — 40 to 250 ms of a 400 ms response. Each loader
 * here is therefore cached twice:
 *
 *   - `unstable_cache`, across requests and processes, keyed by its arguments
 *     (the language included wherever the output depends on it), tagged
 *     `corpus` — and `article:<slug>` for one article's page — and refreshed
 *     at most an hour after it was filled;
 *   - React `cache()`, so a page and its `generateMetadata` asking for the
 *     same thing in one request share a single call.
 *
 * Everything returned survives a JSON round trip, because that is how the
 * data cache stores it: dates are ISO strings and lookups are plain records.
 *
 * No cached function here calls another. Inside an `unstable_cache` callback
 * Next skips an inner `unstable_cache`'s read and runs it every time (as it
 * would a fetch), so a shared part — the biome ladder — is resolved by the
 * exported loaders and handed to the cached ones as an argument.
 *
 * The keys come from URLs, so a key is only ever made from something that
 * exists, and checked before the cache is asked:
 *
 *   - a slug must be in the slug list held in memory for ten minutes
 *     (`cachedSlugs`), or else in the database (`articleExists`);
 *   - every value of a filter must be one some article has (the values are
 *     held the same way, `heldFilterValues`); a value the list does not know
 *     yet is answered straight from the database;
 *   - and an answer about nothing — an unknown slug, a filter that matches
 *     nothing, a `?tab=` no item has — is never stored (`NotStored`).
 *
 * The check comes first because the cache cannot forget on its own: an entry
 * is never evicted, and a stale one whose refill finds nothing keeps its old
 * value. A deleted or renamed article, or a category the wiki emptied, was
 * served from such an entry for as long as the server ran; now it stops
 * answering once the held list is reloaded, within ten minutes (a biome rung,
 * whose list is the cached ladder, within the hour). One case is left: a
 * combination of filters whose values all still exist but no longer meet —
 * only a typed address makes one today — keeps its last entry.
 *
 * Invalidation: nothing revalidates `corpus` today. The ingest runs as a
 * command on another machine and cannot reach this server's cache, so what a
 * re-ingest changes appears as each entry refills, within an hour of when it
 * was filled (`REVALIDATE`), and what it removes within the ten minutes above.
 * The translation endpoint expires one article's page after saving
 * (`revalidateTag(articleTag(slug), { expire: 0 })`), so the reader who asked
 * for the translation sees it on the next load.
 */

/** Tag on every loader here: an ingest invalidates all of it. */
export const CORPUS_TAG = 'corpus';

/** Tag on one article's page payload: a new or refreshed translation invalidates it. */
export function articleTag(slug: string): string {
  return `article:${slug}`;
}

/** Seconds before a cached entry is refilled even if nothing invalidated it. */
const REVALIDATE = 3600;

/* -------------------------------------------------------------------------- */
/* Browse axes: home and /wiki/browse                                          */
/* -------------------------------------------------------------------------- */

/** A browse tile or chip: the English `name` for the URL, `label` for display. */
export type AxisItem = CategorySummary & { label: string };

export type BrowseData = {
  /** Every article, for "Escribí para buscar entre {n} artículos". */
  total: number;
  /** In the order the game opens them up, every article that names one. */
  biomes: AxisItem[];
  /** Largest first, recipe lists left out (they are the stations axis). */
  categories: AxisItem[];
  /** Largest first, each bench once with its levels counted under it. */
  stations: AxisItem[];
};

function labelled(kind: TermKind, items: CategorySummary[], lang: Lang): AxisItem[] {
  return items.map((item) => ({ ...item, label: termLabel(kind, item.name, lang) }));
}

/** The axes as the data cache keeps them: everything but the biome ladder, which has an entry of its own. */
type StoredAxes = Omit<BrowseData, 'biomes'> & {
  /** Each biome's own picture, where the biome facet has one: `[biome, icon]`. */
  biomePictures: [string, string | null][];
};

/**
 * The three ways in, with counts and pictures.
 *
 * Used by the wiki home (`/wiki`) and the browse tab (`/wiki/browse`), which
 * show the same axes at different lengths. Categories need at least five
 * articles to be an axis entry at all.
 */
export const getBrowseAxes = cache(async (lang: Lang): Promise<BrowseData> => {
  const [axes, members] = await Promise.all([storedAxes(lang), loadBiomeMembers()]);

  // The tile's picture is still the biome's own article where it has one;
  // the count is every article on the rung.
  const pictures = new Map(axes.biomePictures);
  const ladder = orderedBiomes(
    Object.entries(members).map(([name, held]) => ({
      name,
      count: held.slugs.length,
      icon: pictures.get(name) ?? held.icon,
    })),
  );

  return { total: axes.total, biomes: labelled('biome', ladder, lang), categories: axes.categories, stations: axes.stations };
});

const storedAxes = unstable_cache(
  async (language: Lang): Promise<StoredAxes> => {
    const db = await getDb();
    const [total, categories, stations, biomeFacets] = await Promise.all([
      countArticles(db),
      listCategories(db, 5),
      listFacetValues(db, 'station'),
      listFacetValues(db, 'biome'),
    ]);
    return {
      total,
      categories: labelled('category', mainCategories(categories), language),
      stations: labelled('station', mainStations(stations), language),
      biomePictures: orderedBiomes(biomeFacets).map((biome) => [biome.name, biome.icon]),
    };
  },
  ['wiki-browse-axes'],
  { tags: [CORPUS_TAG], revalidate: REVALIDATE },
);

/** The articles on each rung of the biome ladder, and a picture to stand for it. */
type BiomeMembers = Partial<Record<Biome, { slugs: string[]; icon: string | null }>>;

/**
 * Which biome each article belongs to (`articleBiome`), for the biome tiles
 * and the biome filter. The facet alone covers 78 articles; the infobox's
 * Location and Source rows bring it to about 180.
 *
 * Asked for by the exported loaders only, never from inside a cached
 * function. In there, Next bypasses this entry: the 200 KB read of every
 * infobox ran again on every refill of the axes, of a biome list and of a
 * biome comparison (twice for that), instead of once an hour.
 */
const loadBiomeMembers = unstable_cache(
  async (): Promise<BiomeMembers> => {
    const evidence = await listBiomeEvidence(await getDb());
    const members: BiomeMembers = {};
    for (const row of evidence) {
      const biome = articleBiome(row);
      if (!biome) continue;
      const held = (members[biome] ??= { slugs: [], icon: null });
      held.slugs.push(row.slug);
      held.icon ??= row.icon;
    }
    return members;
  },
  ['wiki-biome-members'],
  { tags: [CORPUS_TAG], revalidate: REVALIDATE },
);

/* -------------------------------------------------------------------------- */
/* What the cache keeps                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A result the data cache must not keep. Thrown from inside the cached
 * function — `unstable_cache` stores what resolves and nothing that rejects —
 * and turned back into the result just outside it (`unlessNotStored`).
 *
 * The cache key is the loader's arguments, and those come from the URL: an
 * article that does not exist, a filter value nobody links to. Stored, each
 * would be a file in the server's cache for an hour, one per URL a crawler or
 * a typo asked for, with nothing to evict it; and an unknown slug would stay
 * "not found" for that hour after a command-line ingest (which cannot clear
 * tags) added the article.
 */
class NotStored<T> extends Error {
  constructor(readonly result: T) {
    super('not stored');
    this.name = 'NotStored';
  }
}

async function unlessNotStored<T>(load: Promise<T>): Promise<T> {
  try {
    return await load;
  } catch (thrown) {
    if (thrown instanceof NotStored) return thrown.result as T;
    throw thrown;
  }
}

/** Longer than any category, biome, station or type the wiki has; a longer value is not one. */
const MAX_FILTER_VALUE = 120;

/** The same filter always makes the same key, whatever order its keys arrived in. */
function normalizedFilter(filter: BrowseFilter): BrowseFilter {
  const out: BrowseFilter = {};
  for (const key of ['category', 'biome', 'station', 'type'] as const) {
    if (filter[key]) out[key] = filter[key];
  }
  return out;
}

/**
 * A filter as a cache argument: normalised and serialised.
 *
 * A string because React's `cache()` compares object arguments by identity:
 * the page and its `generateMetadata` each build their own filter object, so
 * an object argument was two calls, and on a cold cache two sets of queries.
 * Null for a filter no article can match (a value longer than any name).
 */
function filterKey(filter: BrowseFilter): string | null {
  const normal = normalizedFilter(filter);
  if (Object.values(normal).some((value) => value.length > MAX_FILTER_VALUE)) return null;
  return JSON.stringify(normal);
}

/** How long the filter values are held before they are read again: as long as the slug list is. */
const FILTER_VALUES_TTL_MS = 10 * 60 * 1000;

type HeldFilterValues = { categories: ReadonlySet<string>; stations: ReadonlySet<string>; types: ReadonlySet<string> };

let filterValues: { at: number; values: Promise<HeldFilterValues> } | null = null;

/**
 * Every category, bench and type some article has, held in memory for ten
 * minutes: what a filter from a URL is checked against before it may name a
 * cache entry, and the categories the category route's layout knows
 * (`heldCategoryNames`). Per process, like the link index — a memo, not a
 * cache with invalidation to get wrong — and a failed read is not held.
 */
function heldFilterValues(now = Date.now()): Promise<HeldFilterValues> {
  if (filterValues && now - filterValues.at < FILTER_VALUES_TTL_MS) return filterValues.values;
  const values = getDb()
    .then(listFilterValues)
    .then((found) => ({
      categories: new Set(found.categories),
      stations: new Set(found.stations),
      types: new Set(found.types),
    }));
  const entry = { at: now, values };
  filterValues = entry;
  values.catch(() => {
    if (filterValues === entry) filterValues = null;
  });
  return values;
}

/**
 * Every category some article has, from the values held above: what the
 * category route's layout checks an address against before the page streams
 * (src/app/wiki/c/[category]/known-categories.ts). One list for both, read
 * once per ten minutes, rather than the same query held twice.
 *
 * Rejects when the list cannot be read, and the failure is not held, so the
 * next request asks again; the caller decides what an outage means for it.
 */
export async function heldCategoryNames(): Promise<ReadonlySet<string>> {
  return (await heldFilterValues()).categories;
}

/**
 * Whether every value of a filter (its biome aside) is one some article has.
 *
 * True when the list cannot be read: the cache then answers, as it did before
 * there was a list, and an outage costs the check rather than every cached
 * listing.
 */
async function knownValues(filter: BrowseFilter): Promise<boolean> {
  if (!filter.category && !filter.station && !filter.type) return true;
  let values: HeldFilterValues;
  try {
    values = await heldFilterValues();
  } catch {
    return true;
  }
  return (
    (!filter.category || values.categories.has(filter.category)) &&
    (!filter.station || values.stations.has(filter.station)) &&
    (!filter.type || values.types.has(filter.type))
  );
}

/**
 * A filter from a URL, as the queries take it, and whether it may name a
 * cache entry.
 *
 * `none`: it names a biome that is no rung of the ladder, so nothing can
 * match and nothing is asked. Otherwise the biome, which no single column
 * holds, has become the list of articles on its rung (`only`, as JSON: it is
 * part of the cache key, so a rung whose members change gets a fresh entry by
 * itself), and `known` says whether every other value is one some article
 * has. A filter that is not known is answered straight from the database and
 * never stored: a typo should not be able to add an entry, and a value newer
 * than the held list is still found.
 */
type Scope = { none: true } | { none: false; only: string | null; known: boolean };

const scopeFor = cache(async (key: string): Promise<Scope> => {
  const { biome, ...rest } = JSON.parse(key) as BrowseFilter;
  let only: string | null = null;
  if (biome) {
    const members = await loadBiomeMembers();
    // Own keys only: "?biome=constructor" is not a rung.
    const rung = Object.hasOwn(members, biome) ? members[biome as Biome] : undefined;
    if (!rung || rung.slugs.length === 0) return { none: true };
    only = JSON.stringify(rung.slugs);
  }
  return { none: false, only, known: await knownValues(rest) };
});

/**
 * The filter and options the queries take, from a key and its rung's
 * articles: the biome is the `only` list, never the raw facet, which names
 * the biome of 78 articles where the ladder finds about 180.
 */
function queryArgs(key: string, only: string | null): { filter: BrowseFilter; options: { only?: string[] } } {
  const filter = JSON.parse(key) as BrowseFilter;
  delete filter.biome;
  return { filter, options: only !== null ? { only: JSON.parse(only) as string[] } : {} };
}

/* -------------------------------------------------------------------------- */
/* Category list and compare view: /wiki/c/[category]                          */
/* -------------------------------------------------------------------------- */

/** A list row's lead is one line on screen; past this it is bytes nobody sees. */
const LEAD_LENGTH = 180;

/** Cuts at a word boundary, with an ellipsis, so a clipped lead never ends mid-word. */
function clip(text: string, max = LEAD_LENGTH): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

export type CategoryListing = {
  articles: ArticleSummary[];
  /** Display names of the filter, in the language asked for: the page heading. */
  heading: { category?: string; biome?: string; station?: string; type?: string };
};

/** The display name of each part of a filter: "Armas", "Praderas", "Forja". */
function headingFor(filter: BrowseFilter, lang: Lang): CategoryListing['heading'] {
  const heading: CategoryListing['heading'] = {};
  if (filter.category) heading.category = termLabel('category', filter.category, lang);
  if (filter.biome) heading.biome = termLabel('biome', filter.biome, lang);
  if (filter.station) heading.station = termLabel('station', filter.station, lang);
  if (filter.type) heading.type = termLabel('type', filter.type, lang);
  return heading;
}

/**
 * A category's articles, or every article matching a facet filter.
 *
 * Used by the list view of `/wiki/c/[category]`. In Spanish each row carries
 * the stored translation's title (without its English gloss) and lead, with
 * the English title in `englishTitle`, and the list is sorted by the name
 * shown. `translated: false` marks a row whose lead is still English.
 *
 * A filter that matches nothing is answered but not cached (`NotStored`).
 */
export function getCategoryListing(filter: BrowseFilter, lang: Lang): Promise<CategoryListing> {
  const key = filterKey(filter);
  if (key === null) return Promise.resolve({ articles: [], heading: headingFor(filter, lang) });
  return listingFor(key, lang);
}

const listingFor = cache(async (key: string, lang: Lang): Promise<CategoryListing> => {
  const scope = await scopeFor(key);
  if (scope.none) return { articles: [], heading: headingFor(JSON.parse(key) as BrowseFilter, lang) };
  return unlessNotStored((scope.known ? storedListing : readListing)(key, scope.only, lang));
});

/** A listing, from the database. Throws `NotStored` around an empty one. */
async function readListing(key: string, only: string | null, language: Lang): Promise<CategoryListing> {
  const { filter, options } = queryArgs(key, only);
  const articles = await listArticles(await getDb(), filter, 500, { lang: language, ...options });
  const listing: CategoryListing = {
    articles: articles.map((a) => ({ ...a, lead: clip(a.lead) })),
    heading: headingFor(JSON.parse(key) as BrowseFilter, language),
  };
  if (articles.length === 0) throw new NotStored(listing);
  return listing;
}

const storedListing = unstable_cache(readListing, ['wiki-category-listing'], {
  tags: [CORPUS_TAG],
  revalidate: REVALIDATE,
});

export type CompareView = {
  table: CompareTable;
  /** Upgrade levels present in the set, for the level switcher. */
  tabs: string[];
  heading: CategoryListing['heading'];
};

/**
 * The comparison table and its level switcher, in one call.
 *
 * Used by the compare view of `/wiki/c/[category]` (`?view=compare&tab=`).
 * The article list is not loaded alongside it: the count is
 * `table.rows.length`. Column keys stay English; `table.columnLabels` holds
 * the names to show, and rows whose stats come from a lower level than the
 * one asked for say which in `shownTab`.
 *
 * `tab` counts only when some item in the set has that level; any other
 * value reads as no level at all, so `?tab=` cannot mint a cache entry per
 * value typed. A filter that matches nothing is answered but not cached.
 */
export async function getCompareView(filter: BrowseFilter, tab: string | undefined, lang: Lang): Promise<CompareView> {
  const key = filterKey(filter);
  const heading = headingFor(filter, lang);
  if (key === null) return { table: { columns: [], rows: [] }, tabs: [], heading };

  const set = await compareSetFor(key);
  if (set.articles === 0) return { table: { columns: [], rows: [] }, tabs: [], heading };
  const table = await tableFor(key, tab !== undefined && set.tabs.includes(tab) ? tab : null, lang);
  return { table, tabs: set.tabs, heading };
}

type CompareSet = { articles: number; tabs: string[] };

/**
 * Whether a filter matches anything, and the levels its items have: what
 * `getCompareView` checks `?tab=` against. Small, and cached per filter once
 * the filter is known to be a real one.
 */
const compareSetFor = cache(async (key: string): Promise<CompareSet> => {
  const scope = await scopeFor(key);
  if (scope.none) return { articles: 0, tabs: [] };
  return unlessNotStored((scope.known ? storedCompareSet : readCompareSet)(key, scope.only));
});

/** The compare set, from the database. Throws `NotStored` around an empty one. */
async function readCompareSet(key: string, only: string | null): Promise<CompareSet> {
  const db = await getDb();
  const { filter, options } = queryArgs(key, only);
  const [articles, tabs] = await Promise.all([
    countMatchingArticles(db, filter, options),
    listCompareTabs(db, filter, options),
  ]);
  if (articles === 0) throw new NotStored({ articles, tabs });
  return { articles, tabs };
}

const storedCompareSet = unstable_cache(readCompareSet, ['wiki-compare-set'], {
  tags: [CORPUS_TAG],
  revalidate: REVALIDATE,
});

/** The table for a filter known to match, at a level known to exist (or none). */
const tableFor = cache(async (key: string, tab: string | null, lang: Lang): Promise<CompareTable> => {
  const scope = await scopeFor(key);
  if (scope.none) return { columns: [], rows: [] };
  return (scope.known ? storedTable : readTable)(key, scope.only, tab, lang);
});

/** The table, from the database. */
async function readTable(key: string, only: string | null, tab: string | null, language: Lang): Promise<CompareTable> {
  const { filter, options } = queryArgs(key, only);
  return buildCompareTable(await getDb(), filter, {
    ...(tab !== null ? { tab } : {}),
    lang: language,
    ...options,
  });
}

const storedTable = unstable_cache(readTable, ['wiki-compare-table'], {
  tags: [CORPUS_TAG],
  revalidate: REVALIDATE,
});

/* -------------------------------------------------------------------------- */
/* Article page: /wiki/a/[slug]                                                */
/* -------------------------------------------------------------------------- */

/** An article as stored, with its date as a string so it survives the cache. */
export type ArticleData = Omit<StoredArticle, 'updatedAt'> & { updatedAt: string };

export type ArticlePage = {
  /** The English article as stored: the source of URLs, categories and the recipe keys. */
  article: ArticleData;
  /**
   * The stored translation in the language asked for, when there is one.
   * `stale`: the English article changed after it was translated. `partial`:
   * some strings are still in English (it is shown once at least half is
   * translated). `retryable`: a translation request could still finish it,
   * i.e. some of the missing strings have not failed too often.
   */
  translation: { title: string; stale: boolean; partial: boolean; retryable: boolean } | null;
  /**
   * The stored title: the translation's, else the English one. The article
   * page derives its heading from it (`articleTitle` in article-meta.ts).
   */
  title: string;
  /** The document to show: the translation's text over the English facets and images. */
  doc: ArticleDoc;
  /** Recipe materials resolved to their articles, keyed by `ingredientKey`. */
  ingredientTargets: Record<string, IngredientTarget>;
  /** Each translated recipe row paired with the English it came from. */
  recipeSources: Record<string, string>;
  /** The other articles this one names, for `ArticleView`'s `links`. */
  links: LinkTarget[];
};

/**
 * Everything the article page renders, in at most two database waves.
 *
 * Used by `/wiki/a/[slug]` and its `generateMetadata` (which share the call
 * through React `cache()`). The first wave reads the article and, in any
 * other language than English, its translation with the translation's
 * progress and captions — each once, side by side — alongside the link index
 * (held in memory, with its pattern compiled once — see `cachedLinker`); the
 * second resolves the recipe's ingredients, which depend on the article. The
 * links are worked out here too, so a cached page costs no regex over the
 * whole index.
 *
 * Null for an unknown article, and that answer is never cached. A slug that
 * `slugify` could not have produced is refused without a query; one the slug
 * list held in memory does not have is looked up once (`articleExists`), and
 * when there is no such article the cache is not asked at all — so an
 * address nobody wrote costs one index lookup, an article a command-line
 * ingest adds is found on the next request, and one it deleted or renamed
 * stops being served from the cache once the list is reloaded (ten minutes).
 */
export const getArticlePage = cache(async (slug: string, lang: Lang): Promise<ArticlePage | null> => {
  if (!isSlug(slug) || !(await mayBeArticle(slug))) return null;
  return unlessNotStored(
    unstable_cache(readArticlePage, ['wiki-article-page'], {
      tags: [CORPUS_TAG, articleTag(slug)],
      revalidate: REVALIDATE,
    })(slug, lang),
  );
});

/**
 * Whether a slug may name an article, asked before the cache is: in the slug
 * list held in memory, or else in the database.
 *
 * True when the check itself fails: the cache then answers as it did before
 * the check existed, and an outage costs the check rather than every cached
 * page.
 */
async function mayBeArticle(slug: string): Promise<boolean> {
  try {
    const db = await getDb();
    if ((await cachedSlugs(db)).has(slug)) return true;
    return await articleExists(db, slug);
  } catch {
    return true;
  }
}

/** The page payload, from the database. Throws `NotStored` around an unknown article. */
async function readArticlePage(slug: string, language: Lang): Promise<ArticlePage | null> {
  const db = await getDb();
  const [article, compiled, stored] = await Promise.all([
    getArticleBySlug(db, slug),
    cachedLinker(db, language),
    // The translation, its progress and its captions, in one read. Progress
    // and captions live with the translation memory, which may be missing on
    // a database that never ran drizzle/0009; the store answers without them
    // then.
    language === 'en' ? null : readCachedTranslation(db, slug, language, { maxFailures: TRANSLATION_MAX_FAILURES.public }),
  ]);
  if (!article) throw new NotStored(null);
  const translation = stored?.article ? stored.translation : null;
  return assembleArticlePage(
    article,
    translation
      ? {
          title: translation.title,
          stale: translation.stale,
          // As everywhere: images and facets are the English article's.
          doc: { ...translation.doc, images: [], facets: {} },
        }
      : null,
    compiled,
    language,
    (names) => getIngredientTargets(db, names),
    translation
      ? { partial: translation.partial, retryable: translation.retryable, images: translation.doc.images }
      : null,
  );
}

/** The page payload from an article and its translation. Exported for tests. */
export async function assembleArticlePage(
  article: StoredArticle,
  translation: StoredTranslation | null,
  compiled: { index: LinkTarget[]; linker: Linker },
  lang: Lang,
  resolveIngredients: (names: string[]) => Promise<Map<string, IngredientTarget>>,
  /** Progress of the translation, and the English images with their translated captions. */
  progress: { partial: boolean; retryable: boolean; images: ArticleImage[] } | null = null,
): Promise<ArticlePage> {
  const doc: ArticleDoc = translation
    ? {
        ...article.doc,
        lead: translation.doc.lead,
        blocks: translation.doc.blocks,
        infobox: translation.doc.infobox,
        images: progress?.images ?? article.doc.images,
      }
    : article.doc;

  const flatten = (box: ArticleDoc['infobox']) => (box ? [...box.common, ...box.tabs.flatMap((t) => t.groups)] : []);
  const groups = flatten(doc.infobox);
  const sourceGroups = flatten(article.doc.infobox);

  // Names come from the English article, always: a translation that dropped a
  // gloss should cost a parenthetical, not the icon and the link.
  const found = await resolveIngredients(recipeLookups(sourceGroups));

  return {
    article: { ...article, updatedAt: article.updatedAt.toISOString() },
    translation: translation
      ? {
          title: translation.title,
          stale: translation.stale,
          partial: progress?.partial ?? false,
          retryable: progress?.retryable ?? false,
        }
      : null,
    title: translation?.title ?? article.title,
    doc,
    ingredientTargets: Object.fromEntries(found),
    recipeSources: translation ? pairRecipeSources(groups, sourceGroups) : {},
    links: collectArticleLinks({
      doc,
      source: article.doc,
      index: compiled.index,
      linker: compiled.linker,
      selfSlug: article.slug,
      lang,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Search: /api/wiki/index and /api/wiki/search                                */
/* -------------------------------------------------------------------------- */

/**
 * The bilingual, lean title list the search downloads (`getSearchIndex`).
 * Used by `/api/wiki/index?v=2`. The same for every reader and both languages.
 */
export const getSearchIndexData = cache(
  (): Promise<TitleIndexEntry[]> =>
    unstable_cache(async () => getSearchIndex(await getDb()), ['wiki-search-index'], {
      tags: [CORPUS_TAG],
      revalidate: REVALIDATE,
    })(),
);

/**
 * The original title list, for browsers still running the previous build of
 * the search. Used by `/api/wiki/index` without `v`.
 */
export const getLegacyTitleIndex = cache(
  (): Promise<TitleIndexEntry[]> =>
    unstable_cache(async () => getTitleIndex(await getDb()), ['wiki-title-index'], {
      tags: [CORPUS_TAG],
      revalidate: REVALIDATE,
    })(),
);

/**
 * The accented words the content search folds queries against
 * (`getSearchVocabulary`). Used by `/api/wiki/search`.
 */
export const getSearchVocabularyData = cache(
  (): Promise<string[]> =>
    unstable_cache(async () => getSearchVocabulary(await getDb()), ['wiki-search-vocabulary'], {
      tags: [CORPUS_TAG],
      revalidate: REVALIDATE,
    })(),
);

/**
 * Every linkable name in a language, for pages that link names outside an
 * article body (the guide's item chips use the English one). Article pages
 * get their links from `getArticlePage` instead.
 */
export const getLinkTargets = cache(
  (lang: Lang): Promise<LinkTarget[]> =>
    unstable_cache(async (language: Lang) => getLinkIndex(await getDb(), language), ['wiki-link-index'], {
      tags: [CORPUS_TAG],
      revalidate: REVALIDATE,
    })(lang),
);
