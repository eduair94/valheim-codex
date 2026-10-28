import { sql, type SQL } from 'drizzle-orm';
import { rawQuery, type Db } from './create-db';
import { articles } from './schema';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import { normalizeTerm, spanishName, type LinkTarget } from '@/lib/wiki/links';
import { STATION_LEVEL_SQL, isMaintenanceCategory, type BiomeEvidence } from '@/lib/wiki/browse-groups';
import { compactIcon } from '@/lib/wiki/title-search';
import { planSearch, searchTsQueries, type AccentIndex } from '@/lib/rag/tsquery';
import { spanishTitle } from '@/lib/i18n/article-names';
import { termLabel } from '@/lib/i18n/terms';
import type { Lang } from '@/lib/i18n/strings';

export type StoredArticle = {
  pageKey: string;
  source: string;
  title: string;
  slug: string;
  url: string;
  categories: string[];
  doc: ArticleDoc;
  /** When the ingest last wrote this article; a translation older than it is stale. */
  updatedAt: Date;
};

export type ArticleUpsert = {
  pageKey: string;
  source: string;
  title: string;
  slug: string;
  url: string;
  categories: string[];
  doc: ArticleDoc;
};

export async function upsertArticle(db: Db, input: ArticleUpsert): Promise<void> {
  const { doc } = input;
  await db
    .insert(articles)
    .values({
      pageKey: input.pageKey,
      source: input.source,
      title: input.title,
      slug: input.slug,
      url: input.url,
      categories: input.categories,
      lead: doc.lead,
      blocks: doc.blocks,
      infobox: doc.infobox,
      images: doc.images,
      facets: doc.facets as Record<string, string>,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: articles.pageKey,
      set: {
        title: input.title,
        slug: input.slug,
        url: input.url,
        categories: input.categories,
        lead: doc.lead,
        blocks: doc.blocks,
        infobox: doc.infobox,
        images: doc.images,
        facets: doc.facets as Record<string, string>,
        updatedAt: new Date(),
      },
    });
}

type ArticleRow = {
  page_key: string;
  source: string;
  title: string;
  slug: string;
  url: string;
  categories: string[];
  lead: string;
  blocks: ArticleDoc['blocks'];
  infobox: ArticleDoc['infobox'];
  images: ArticleDoc['images'];
  facets: ArticleDoc['facets'];
  updated_at: string;
};

function toStored(row: ArticleRow): StoredArticle {
  return {
    pageKey: row.page_key,
    source: row.source,
    title: row.title,
    slug: row.slug,
    url: row.url,
    categories: row.categories ?? [],
    updatedAt: new Date(row.updated_at),
    doc: {
      lead: row.lead,
      blocks: row.blocks ?? [],
      infobox: row.infobox ?? null,
      images: row.images ?? [],
      facets: row.facets ?? {},
    },
  };
}

/** A Postgres `text[]` literal, for `= ANY(...)`: one bound parameter however long the list. */
function textArray(values: readonly string[]): SQL {
  const literal = `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
  return sql`${literal}::text[]`;
}

export async function getArticleBySlug(db: Db, slug: string): Promise<StoredArticle | null> {
  const rows = await rawQuery<ArticleRow>(
    db,
    sql`SELECT page_key, source, title, slug, url, categories, lead, blocks, infobox, images, facets, updated_at
        FROM articles WHERE slug = ${slug} LIMIT 1`,
  );
  return rows[0] ? toStored(rows[0]) : null;
}

/**
 * Whether an article has this slug: one index lookup, no columns read.
 *
 * What the article page asks about an address before it touches its cache,
 * so an unknown slug costs this and nothing else, and a deleted one stops
 * being served from what the cache kept of it.
 */
export async function articleExists(db: Db, slug: string): Promise<boolean> {
  const rows = await rawQuery<{ found: number }>(db, sql`SELECT 1 AS found FROM articles WHERE slug = ${slug} LIMIT 1`);
  return rows.length > 0;
}

/** A stored translation, as the article page reads it. */
export type StoredTranslation = { title: string; doc: ArticleDoc; stale: boolean };

/**
 * An article and, in the same round trip, its translation.
 *
 * The article page used to wait for the article before asking for the
 * translation, which added a whole wave of latency to every Spanish view —
 * 40 to 150 ms against the metered database. The translation is keyed by the
 * article's page key, so it can ride along on a join instead.
 */
export async function getArticleWithTranslation(
  db: Db,
  slug: string,
  lang: string,
): Promise<{ article: StoredArticle; translation: StoredTranslation | null } | null> {
  const rows = await rawQuery<
    ArticleRow & {
      t_title: string | null;
      t_lead: string | null;
      t_blocks: unknown;
      t_infobox: unknown;
      t_stale: boolean | null;
    }
  >(
    db,
    sql`SELECT a.page_key, a.source, a.title, a.slug, a.url, a.categories, a.lead, a.blocks, a.infobox,
               a.images, a.facets, a.updated_at,
               t.title AS t_title, t.lead AS t_lead, t.blocks AS t_blocks, t.infobox AS t_infobox,
               (t.source_updated_at < a.updated_at) AS t_stale
        FROM articles a
        LEFT JOIN article_translations t ON t.page_key = a.page_key AND t.lang = ${lang}
        WHERE a.slug = ${slug}
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;

  const translation: StoredTranslation | null =
    lang !== 'en' && row.t_title !== null
      ? {
          title: row.t_title,
          stale: Boolean(row.t_stale),
          doc: {
            lead: row.t_lead ?? '',
            blocks: (row.t_blocks ?? []) as ArticleDoc['blocks'],
            infobox: (row.t_infobox ?? null) as ArticleDoc['infobox'],
            // As in getTranslation: images and facets are never translated.
            images: [],
            facets: {},
          },
        }
      : null;

  return { article: toStored(row), translation };
}

/** Resolves the slug for a wiki title, so a citation can link inward. */
export async function getSlugForTitle(db: Db, title: string): Promise<string | null> {
  const rows = await rawQuery<{ slug: string }>(
    db,
    sql`SELECT slug FROM articles WHERE lower(title) = lower(${title}) LIMIT 1`,
  );
  return rows[0]?.slug ?? null;
}

/**
 * An article's picture.
 *
 * The infobox image where there is one, and the first image on the page
 * otherwise. Biome and structure articles carry no infobox image at all — the
 * Swamp page's picture of the swamp and the Workbench page's picture of the
 * workbench both sit in the gallery — so an infobox-only rule leaves exactly
 * the articles that most need a picture without one.
 */
const ARTICLE_ICON = sql`coalesce(infobox->'image'->>'url', images->0->>'url')`;

/** The same, for a query where `articles` is aliased `a`. */
const ARTICLE_ICON_A = sql`coalesce(a.infobox->'image'->>'url', a.images->0->>'url')`;

export type TitleIndexEntry = {
  s: string; // slug
  t: string; // title
  c: string[]; // categories
  y?: string; // type facet
  /** Icon: a full URL, or (search index) a path under the Fandom image root; see `expandIcon`. */
  i?: string;
  /** Spanish name, when it differs from the English title (search index only). */
  e?: string;
  /** Other Spanish names the article answers to (search index only). */
  a?: string[];
};

/**
 * The whole title list, shipped to the browser for instant search.
 *
 * About 1,000 entries. Keys are one character because this payload is
 * downloaded on every cold load and cached for offline use; the difference is
 * roughly a third of the transfer for no loss of clarity at the call site,
 * where it is mapped to real names immediately.
 *
 * The original shape, kept for browsers still running the previous build;
 * the current search reads `getSearchIndex`.
 */
export async function getTitleIndex(db: Db): Promise<TitleIndexEntry[]> {
  const rows = await rawQuery<{
    slug: string;
    title: string;
    categories: string[];
    type: string | null;
    icon: string | null;
  }>(
    db,
    sql`SELECT slug, title, categories,
               facets->>'type' AS type,
               ${ARTICLE_ICON} AS icon
        FROM articles ORDER BY title`,
  );

  return rows.map((r) => {
    const entry: TitleIndexEntry = { s: r.slug, t: r.title, c: r.categories ?? [] };
    if (r.type) entry.y = r.type;
    if (r.icon) entry.i = r.icon;
    return entry;
  });
}

/** Categories a search row can show next to the type; the rest are never drawn. */
const SEARCH_INDEX_CATEGORIES = 3;

/**
 * The title list as the search needs it: bilingual, and no heavier than what
 * a result row draws.
 *
 * Every entry carries its Spanish name (`e`) where it has one — the stored
 * translation's title without its English gloss, or for an untranslated hub
 * page the vocabulary's name ("Banco de trabajo") — and the other Spanish
 * names readers use for it (`a`). That is what lets "espada de hierro" or
 * "praderas" find their article in a browser that holds only this list.
 *
 * Lean, because it is downloaded on a phone before the first keystroke can be
 * answered: icons travel as a path under the image root instead of a full
 * 111-character URL (59% of the old payload), and only the categories a row
 * shows. One payload for both languages, so the CDN can hold one copy.
 */
export async function getSearchIndex(db: Db): Promise<TitleIndexEntry[]> {
  const rows = await rawQuery<{
    slug: string;
    title: string;
    categories: string[];
    type: string | null;
    icon: string | null;
    translated: string | null;
  }>(
    db,
    sql`SELECT a.slug, a.title, a.categories,
               a.facets->>'type' AS type,
               ${ARTICLE_ICON_A} AS icon,
               t.title AS translated
        FROM articles a
        LEFT JOIN article_translations t ON t.page_key = a.page_key AND t.lang = 'es'
        ORDER BY a.title`,
  );

  return rows.map((r) => {
    // The wiki's bookkeeping ("Unfinished", "Stubs") is dropped before the
    // cut, so it neither shows under a result nor pushes a real category out.
    const categories = (r.categories ?? []).filter((c) => !isMaintenanceCategory(c));
    const entry: TitleIndexEntry = { s: r.slug, t: r.title, c: categories.slice(0, SEARCH_INDEX_CATEGORIES) };
    const { name, aliases } = spanishTitle(r.title, r.translated);
    if (name) entry.e = name;
    if (aliases.length > 0) entry.a = aliases;
    if (r.type) entry.y = r.type;
    const icon = r.icon ? compactIcon(r.icon) : null;
    if (icon) entry.i = icon;
    return entry;
  });
}

/**
 * A browsable group of articles.
 *
 * `icon` is one member's sprite, borrowed to stand for the whole group. A
 * category tile with a picture of a sword on it is recognised before its label
 * is read, which is the entire reason browsing beats typing when you do not yet
 * know the name of the thing you want.
 *
 * `label` is the name to show, when the caller asked for one in a language;
 * `name` stays the English value that URLs and filters match on.
 */
export type CategorySummary = { name: string; count: number; icon: string | null; label?: string };

/**
 * Every article's picture, keyed by its title.
 *
 * The group's own article is what a tile should show — the Swamp page's picture
 * is of the swamp, the Workbench page's is of the workbench — and it is almost
 * never inside its own group: a biome page carries no `biome` facet and a bench
 * page carries no `station` facet, so grouping alone cannot reach it. This is
 * the lookup that can.
 *
 * `DISTINCT ON` keeps it one row per title, so joining against it cannot
 * duplicate a member and inflate a group's count.
 */
const ARTICLE_BY_TITLE = sql`named AS (
  SELECT DISTINCT ON (lower(title)) lower(title) AS key, ${ARTICLE_ICON} AS icon
  FROM articles
  ORDER BY lower(title), title
)`;

/**
 * One picture to stand for a group.
 *
 * The group's own article first; failing that, the alphabetically first member
 * that has a picture — arbitrary, but the same on every render, so the picture
 * becomes part of how the group is recognised instead of flickering between
 * members on each load.
 */
const REPRESENTATIVE_ICON = sql`coalesce(
  max(named.icon),
  (array_agg(member.icon ORDER BY member.title) FILTER (WHERE member.icon IS NOT NULL))[1]
) AS icon`;

/** Joins each member to its group's own article, when the wiki has one. */
const JOIN_NAMED = sql`LEFT JOIN named ON named.key = lower(member.name)`;

/** Categories with at least `min` articles, largest first. */
export async function listCategories(db: Db, min = 3): Promise<CategorySummary[]> {
  const rows = await rawQuery<{ name: string; n: string; icon: string | null }>(
    db,
    sql`WITH member AS (
          SELECT jsonb_array_elements_text(categories) AS name,
                 title,
                 ${ARTICLE_ICON} AS icon
          FROM articles
        ), ${ARTICLE_BY_TITLE}
        SELECT member.name, count(*)::text AS n, ${REPRESENTATIVE_ICON}
        FROM member ${JOIN_NAMED}
        GROUP BY member.name
        HAVING count(*) >= ${min}
        ORDER BY count(*) DESC, member.name`,
  );
  return rows.map((r) => ({ name: r.name, count: Number(r.n), icon: r.icon }));
}

/**
 * A station without its level: "Cauldron (level 3)" is the Cauldron.
 *
 * The facet stores what the wiki wrote, and the wiki writes the level into the
 * name for the few recipes that need an upgraded bench. Grouped and filtered
 * by the raw value, those recipes appeared under no tile at all: the Cauldron
 * tile counted 27 and left out the five that need it at level 3 or 4.
 */
const BASE_STATION = sql`regexp_replace(facets->>'station', ${STATION_LEVEL_SQL}, '', 'i')`;

/** Distinct values of one facet, with counts. Stations are counted by bench, whatever its level. */
export async function listFacetValues(
  db: Db,
  facet: 'biome' | 'station' | 'type',
): Promise<CategorySummary[]> {
  const value = facet === 'station' ? BASE_STATION : sql`facets->>${facet}`;
  const rows = await rawQuery<{ name: string; n: string; icon: string | null }>(
    db,
    sql`WITH member AS (
          SELECT ${value} AS name,
                 title,
                 ${ARTICLE_ICON} AS icon
          FROM articles
          WHERE facets->>${facet} IS NOT NULL AND facets->>${facet} <> ''
        ), ${ARTICLE_BY_TITLE}
        SELECT member.name, count(*)::text AS n, ${REPRESENTATIVE_ICON}
        FROM member ${JOIN_NAMED}
        GROUP BY member.name
        ORDER BY count(*) DESC, member.name`,
  );
  return rows.map((r) => ({ name: r.name, count: Number(r.n), icon: r.icon }));
}

/**
 * Whether an infobox states a recipe, as `statesRecipe` in article.ts reads
 * it for the station facet: materials that name something ("Wood x6", not
 * "n/a"), or a crafting level that is a number. Not a repair level, which
 * Hildir's clothes have too.
 */
const STATES_RECIPE = sql.raw(
  `'lax $.**.rows[*] ? ((@.label like_regex "^(crafting materials|materials)$" flag "i" && !(@.value like_regex "^(n/?a|none|nil|unknown|-+|—|–)?$" flag "i")) || (@.label like_regex "^crafting level$" flag "i" && @.value like_regex "[0-9]"))'`,
);

/**
 * What every article's infobox says about where it is, for the biome ladder
 * (`articleBiome` in browse-groups decides; this only reads the rows).
 *
 * Read with JSON paths rather than re-parsed in JavaScript, so only four short
 * strings per article leave the database instead of every infobox.
 */
export async function listBiomeEvidence(
  db: Db,
): Promise<(BiomeEvidence & { slug: string; title: string; icon: string | null })[]> {
  const rows = await rawQuery<{
    slug: string;
    title: string;
    icon: string | null;
    facet: string | null;
    location: string | null;
    source: string | null;
    craftable: boolean | null;
  }>(
    db,
    sql`SELECT slug, title, ${ARTICLE_ICON} AS icon,
               facets->>'biome' AS facet,
               jsonb_path_query_first(infobox, 'lax $.**.rows[*] ? (@.label like_regex "^location$" flag "i").value') #>> '{}' AS location,
               jsonb_path_query_first(infobox, 'lax $.**.rows[*] ? (@.label like_regex "^source$" flag "i").value') #>> '{}' AS source,
               jsonb_path_exists(infobox, ${STATES_RECIPE}) AS craftable
        FROM articles
        WHERE infobox IS NOT NULL OR coalesce(facets->>'biome', '') <> ''
        ORDER BY title`,
  );
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    icon: r.icon,
    facet: r.facet,
    location: r.location,
    source: r.source,
    craftable: Boolean(r.craftable),
  }));
}

export type ArticleSummary = {
  slug: string;
  /** The name to show: Spanish when the list was asked for in Spanish and one exists. */
  title: string;
  lead: string;
  icon: string | null;
  facets: Record<string, string>;
  /** The English title, when `title` is a Spanish name, for a secondary line. */
  englishTitle?: string;
  /**
   * Whether `lead` is the stored translation. False on a Spanish list means
   * the lead is the English original, which the page should mark `lang="en"`.
   */
  translated?: boolean;
};

export type BrowseFilter = {
  category?: string;
  biome?: string;
  station?: string;
  type?: string;
};

/** Options the browse queries share. Optional, so every existing caller reads English as before. */
export type BrowseOptions = {
  /** Language of the titles, leads and labels returned; filters stay on the English values. */
  lang?: Lang;
  /**
   * Restricts the set to these slugs. How a filter computed outside SQL — the
   * biome ladder reads several infobox rows — narrows a query.
   */
  only?: readonly string[];
};

/** The WHERE conditions of a browse filter, for queries where `articles` is aliased `a`. */
function filterConditions(filter: BrowseFilter, options: BrowseOptions = {}): SQL[] {
  const conditions: SQL[] = [];
  if (filter.category) {
    conditions.push(sql`a.categories @> ${JSON.stringify([filter.category])}::jsonb`);
  }
  if (filter.biome) conditions.push(sql`a.facets->>'biome' = ${filter.biome}`);
  if (filter.station) {
    conditions.push(sql`regexp_replace(a.facets->>'station', ${STATION_LEVEL_SQL}, '', 'i') = ${filter.station}`);
  }
  if (filter.type) conditions.push(sql`a.facets->>'type' = ${filter.type}`);
  if (options.only) conditions.push(sql`a.slug = ANY(${textArray(options.only)})`);
  return conditions;
}

/** Every value a browse filter can name, as the filters match them (`filterConditions`). */
export type FilterValues = { categories: string[]; stations: string[]; types: string[] };

/**
 * Every category, bench and type at least one article has: the values a
 * browse filter can match anything with.
 *
 * Stations by bench, the way the station filter compares them: "Cauldron
 * (level 3)" is the Cauldron. Exact strings, because the filters are exact.
 * A couple of hundred short rows, for the data layer to hold and check
 * filters from URLs against before it lets them name a cache entry.
 */
export async function listFilterValues(db: Db): Promise<FilterValues> {
  const rows = await rawQuery<{ kind: keyof FilterValues; value: string }>(
    db,
    sql`SELECT 'categories' AS kind, c AS value
          FROM articles, jsonb_array_elements_text(categories) AS c
        UNION
        SELECT 'stations', regexp_replace(facets->>'station', ${STATION_LEVEL_SQL}, '', 'i')
          FROM articles WHERE coalesce(facets->>'station', '') <> ''
        UNION
        SELECT 'types', facets->>'type'
          FROM articles WHERE coalesce(facets->>'type', '') <> ''`,
  );
  const values: FilterValues = { categories: [], stations: [], types: [] };
  for (const row of rows) values[row.kind].push(row.value);
  return values;
}

/**
 * How many articles a browse filter matches: what tells a filter some link
 * points at from one somebody typed.
 */
export async function countMatchingArticles(
  db: Db,
  filter: BrowseFilter,
  options: BrowseOptions = {},
): Promise<number> {
  const conditions = [sql`TRUE`, ...filterConditions(filter, options)];
  const rows = await rawQuery<{ n: string }>(
    db,
    sql`SELECT count(*)::text AS n FROM articles a WHERE ${sql.join(conditions, sql` AND `)}`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Spanish collation for names shown in Spanish: "Arpón abisal" sorts with the A's. */
const SPANISH_ORDER = new Intl.Collator('es', { sensitivity: 'base' });

/**
 * Articles matching a category and any facet filters, alphabetically.
 *
 * In Spanish the rows carry the stored translation's title and lead — 151 of
 * the 158 Weapons rows have one — and sort by the name shown, not by the
 * English one underneath it: Spanish names in English order read as noise.
 */
export async function listArticles(
  db: Db,
  filter: BrowseFilter,
  limit = 500,
  options: BrowseOptions = {},
): Promise<ArticleSummary[]> {
  const lang = options.lang ?? 'en';
  const conditions = [sql`TRUE`, ...filterConditions(filter, options)];
  const translation =
    lang === 'en'
      ? sql`NULL::text AS translated, NULL::text AS translated_lead`
      : sql`t.title AS translated, t.lead AS translated_lead`;
  const join =
    lang === 'en'
      ? sql``
      : sql`LEFT JOIN article_translations t ON t.page_key = a.page_key AND t.lang = ${lang}`;

  const rows = await rawQuery<{
    slug: string;
    title: string;
    lead: string;
    icon: string | null;
    facets: Record<string, string>;
    translated: string | null;
    translated_lead: string | null;
  }>(
    db,
    sql`SELECT a.slug, a.title, a.lead, ${ARTICLE_ICON_A} AS icon, a.facets, ${translation}
        FROM articles a ${join}
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY a.title
        LIMIT ${limit}`,
  );

  const out = rows.map((r): ArticleSummary => {
    const summary: ArticleSummary = {
      slug: r.slug,
      title: r.title,
      lead: r.lead,
      icon: r.icon,
      facets: r.facets ?? {},
    };
    if (lang === 'en') return summary;

    const name = spanishTitle(r.title, r.translated).name;
    if (name) {
      summary.title = name;
      summary.englishTitle = r.title;
    }
    // `lead` is NOT NULL DEFAULT '': an empty translated lead means "none".
    summary.translated = Boolean(r.translated_lead);
    if (r.translated_lead) summary.lead = r.translated_lead;
    return summary;
  });

  return lang === 'en' ? out : out.sort((a, b) => SPANISH_ORDER.compare(a.title, b.title));
}

export type CompareRow = {
  slug: string;
  /** The name to show; Spanish (without its English gloss) when asked for in Spanish. */
  title: string;
  icon: string | null;
  /** Values keyed by the English column label, in the language asked for where a translation lines up. */
  values: Record<string, string>;
  /** The English title, when `title` is a Spanish name. */
  englishTitle?: string;
  /**
   * The upgrade level the values come from, when it is not the one asked for:
   * a shield that stops at level 3 shows its level-3 stats under "Nivel 4",
   * and says so once, next to its name.
   */
  shownTab?: string;
  /**
   * On a table asked for in another language: whether `values` are the
   * translation's. False means they are the English originals (no
   * translation, a stale one, or one that does not line up row for row), so
   * the cells should be marked `lang="en"` — the title can be Spanish while
   * they are not. Absent on an English table.
   */
  valuesTranslated?: boolean;
};

export type CompareTable = {
  /** English infobox labels: the keys of `values`, of sorting and of React lists. */
  columns: string[];
  rows: CompareRow[];
  /** Display name per column, when the table was asked for in a language other than English. */
  columnLabels?: Record<string, string>;
};

type InfoboxRowPair = { label: string; value: string };

/**
 * Builds a comparison table for a category.
 *
 * Generic on purpose: the columns are whatever infobox labels the category's
 * articles actually share, so a new item type needs no schema written for it.
 * Only labels present on at least a quarter of the rows become columns —
 * otherwise one unusual item adds a column that is empty for everything else
 * — and only labels whose values can rank or group the rows: no identifiers,
 * descriptions, lists or a value every row shares (`comparability`). A set
 * with no such column has no rows either.
 *
 * A row is an article with its own stats: not a set's page, whose infobox is
 * one of its pieces' (`isOwnInfobox`).
 *
 * Only the rows a table can use leave the database: the shared rows and the
 * one upgrade level being compared, not every level's groups, images and
 * headings. For Weapons that was 895 KB per request.
 *
 * The level shown per row is chosen in the query:
 *
 *   - the level asked for, when the item has it;
 *   - an item with a single tab, as it is: its stats do not change by level
 *     (arrows, bombs, a torch);
 *   - otherwise the highest numbered level at or below the one asked for,
 *     reported in `shownTab` — a shield that stops at 3 compared at 4;
 *   - and failing that, nothing: the per-level cells show as empty rather
 *     than as another tab's numbers. Comparing a level-1 shield against a
 *     level-4 sword, unmarked, was a silently wrong table.
 *
 * In Spanish, titles and labels are translated and the values come from the
 * stored translation wherever it lines up row for row with the English. The
 * columns are chosen on the English values, so they are the same columns in
 * both languages.
 */
export async function buildCompareTable(
  db: Db,
  filter: BrowseFilter,
  options: { tab?: string; maxColumns?: number } & BrowseOptions = {},
): Promise<CompareTable> {
  const { tab, maxColumns = 12 } = options;
  const lang = options.lang ?? 'en';
  const requested = tab ?? null;
  const requestedLevel = tab !== undefined && /^\d+$/.test(tab) ? Number(tab) : null;

  const conditions = [sql`a.infobox IS NOT NULL`, ...filterConditions(filter, options)];
  const translated =
    lang === 'en'
      ? sql`NULL::text AS translated, NULL::boolean AS fresh, NULL::jsonb AS common_rows_es, NULL::jsonb AS tab_rows_es`
      : sql`t.title AS translated,
            (t.source_updated_at >= a.updated_at) AS fresh,
            jsonb_path_query_array(t.infobox, 'lax $.common[*].rows[*]') AS common_rows_es,
            jsonb_path_query_array(t.infobox->'tabs'->((chosen.position - 1)::int), 'lax $.groups[*].rows[*]') AS tab_rows_es`;
  const join =
    lang === 'en'
      ? sql``
      : sql`LEFT JOIN article_translations t ON t.page_key = a.page_key AND t.lang = ${lang}`;

  const rows = await rawQuery<{
    slug: string;
    title: string;
    icon: string | null;
    infobox_title: string | null;
    variant: boolean | null;
    common_rows: InfoboxRowPair[] | null;
    tab_count: number;
    tab_label: string | null;
    tab_rows: InfoboxRowPair[] | null;
    translated: string | null;
    fresh: boolean | null;
    common_rows_es: InfoboxRowPair[] | null;
    tab_rows_es: InfoboxRowPair[] | null;
  }>(
    db,
    sql`SELECT a.slug, a.title, a.infobox->'image'->>'url' AS icon,
               a.infobox->>'title' AS infobox_title,
               jsonb_typeof(a.infobox->'variants') = 'array' AS variant,
               jsonb_path_query_array(a.infobox, 'lax $.common[*].rows[*]') AS common_rows,
               jsonb_array_length(coalesce(a.infobox->'tabs', '[]'::jsonb))::int AS tab_count,
               chosen.label AS tab_label,
               chosen.rows AS tab_rows,
               ${translated}
        FROM articles a
        LEFT JOIN LATERAL (
          SELECT x.tab->>'label' AS label, x.n AS position,
                 jsonb_path_query_array(x.tab, 'lax $.groups[*].rows[*]') AS rows
          FROM jsonb_array_elements(coalesce(a.infobox->'tabs', '[]'::jsonb)) WITH ORDINALITY AS x(tab, n)
          WHERE ${requested}::text IS NULL
             OR x.tab->>'label' = ${requested}::text
             OR jsonb_array_length(coalesce(a.infobox->'tabs', '[]'::jsonb)) <= 1
             OR (${requestedLevel}::numeric IS NOT NULL
                 AND x.tab->>'label' ~ '^[0-9]+$'
                 AND (x.tab->>'label')::numeric <= ${requestedLevel}::numeric)
          ORDER BY CASE
                     WHEN ${requested}::text IS NULL THEN x.n
                     WHEN x.tab->>'label' = ${requested}::text THEN 0
                     WHEN x.tab->>'label' ~ '^[0-9]+$' THEN 1000000 - (x.tab->>'label')::numeric
                     ELSE 2000000
                   END,
                   x.n
          LIMIT 1
        ) chosen ON true
        ${join}
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY a.title
        LIMIT 300`,
  );

  const frequency = new Map<string, number>();
  // English values per label: what decides a column, in either language.
  const values = new Map<string, string[]>();
  const translatedLabels = new Map<string, Map<string, number>>();
  const collected: CompareRow[] = [];

  for (const row of rows) {
    // A set's page, whose infobox is its first piece's: that piece has an
    // article, and a row, of its own (`isOwnInfobox`).
    if (row.variant && !isOwnInfobox(row.title, row.infobox_title ?? '')) continue;

    const english: Record<string, string> = {};
    const shown: Record<string, string> = {};

    // A translation is only trusted while it is current — a re-ingested
    // article can gain a row the translation does not have — and where it
    // lines up with the English row for row, shared rows and level rows both.
    // All or nothing per item: half a row in Spanish and half in English
    // could not say which cells are which language.
    const linesUp = (en: InfoboxRowPair[] | null, es: InfoboxRowPair[] | null): boolean =>
      (en ?? []).length === (es ?? []).length;
    const useTranslation =
      lang !== 'en' &&
      Boolean(row.fresh) &&
      (row.common_rows_es !== null || row.tab_rows_es !== null) &&
      linesUp(row.common_rows, row.common_rows_es) &&
      linesUp(row.tab_rows, row.tab_rows_es);

    const pair = (en: InfoboxRowPair[] | null, es: InfoboxRowPair[] | null): void => {
      (en ?? []).forEach((r, i) => {
        if (english[r.label] !== undefined) return;
        english[r.label] = r.value;
        const t = useTranslation ? es?.[i] : undefined;
        shown[r.label] = t ? spanishName(t.value, r.value) : r.value;
        if (t) {
          const counts = translatedLabels.get(r.label) ?? new Map<string, number>();
          const label = spanishName(t.label, r.label);
          counts.set(label, (counts.get(label) ?? 0) + 1);
          translatedLabels.set(r.label, counts);
        }
      });
    };
    pair(row.common_rows, row.common_rows_es);
    pair(row.tab_rows, row.tab_rows_es);

    for (const [label, value] of Object.entries(english)) {
      frequency.set(label, (frequency.get(label) ?? 0) + 1);
      values.set(label, [...(values.get(label) ?? []), value]);
    }

    const compareRow: CompareRow = { slug: row.slug, title: row.title, icon: row.icon, values: shown };
    if (tab !== undefined && row.tab_label !== null && row.tab_label !== tab && Number(row.tab_count) > 1) {
      compareRow.shownTab = row.tab_label;
    }
    if (lang !== 'en') {
      const name = spanishTitle(row.title, row.translated).name;
      if (name) {
        compareRow.title = name;
        compareRow.englishTitle = row.title;
      }
      compareRow.valuesTranslated = useTranslation;
    }
    collected.push(compareRow);
  }

  const threshold = Math.max(2, Math.ceil(collected.length / 4));
  const columns = [...frequency.entries()]
    .filter(([label, n]) => n >= threshold && !IDENTITY_LABELS.has(label.trim().toLowerCase()))
    .map(([label, n]) => ({ label, score: n * comparability(values.get(label) ?? []) }))
    .filter((column) => column.score > 0)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, maxColumns)
    .map((c) => c.label);

  // No column, no table. Its rows would still be counted — "24 with stats"
  // over "these articles share no stats to compare", on Skills, whose only
  // shared row is a description — where an empty table lets the page say
  // what the set is from its list, as it does for one with no infobox at all.
  if (columns.length === 0) return { columns, rows: [] };

  if (lang === 'en') return { columns, rows: collected };

  // The vocabulary's name for a label, else what the translations call it
  // most often, else the English.
  const columnLabels: Record<string, string> = {};
  for (const column of columns) {
    const fixed = termLabel('facet', column, lang);
    const common = [...(translatedLabels.get(column) ?? new Map<string, number>()).entries()].sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0];
    columnLabels[column] = fixed !== column ? fixed : (common ?? column);
  }

  return {
    columns,
    rows: collected.sort((a, b) => SPANISH_ORDER.compare(a.title, b.title)),
    columnLabels,
  };
}

/**
 * Labels that name the item rather than describe it, which is what the row
 * header is for. By name, because in a small table nothing in the values
 * tells an identifier from a category: the nine Bosses' "Internal ID" reads
 * "Bonemass", "Eikthyr", "gd_king", the NPCs' "Haldor", "Hildir", "odin", and
 * a biome's three creatures' "Boar", "Neck", "Greyling". The same row is the
 * `internalId` facet (FACET_LABELS in article.ts). Lowercased.
 */
const IDENTITY_LABELS = new Set(['internal id']);

/**
 * Whether an infobox that is one of several on its page is the page's own.
 *
 * A page that shows one infobox per tab stores the first. On a meat that is
 * the raw meat, the page's subject ("Neck Tail", over "Grilled neck tail");
 * on an armor set it is the helmet: "Bronze helmet" on the Bronze Armor page,
 * the Drake helmet on the Wolf Armor's, the Rag tunic on the Rag Armor's. Its
 * levels, armor, weight and durability, read as the set's under the set's
 * name. A qualifier in brackets is the same thing: "Item stand (vertical)" is
 * the Item Stand.
 */
function isOwnInfobox(articleTitle: string, infoboxTitle: string): boolean {
  const name = (text: string): string => normalizeTerm(text.replace(/\s*\([^)]*\)/g, ''));
  return name(infoboxTitle) === '' || name(infoboxTitle) === name(articleTitle);
}

/** Past this median length, a string that differs on every row is prose: a description. */
const PROSE_LENGTH = 40;

/**
 * Rows before "differs on every row" says anything by itself. In a handful
 * of rows any column can: two creatures from two biomes, two weapons' block
 * armor. There an identifier has to look like one ("SwordIron").
 */
const DISTINCT_ROWS = 10;

/**
 * How useful a column is for comparing, as a multiplier on how common it is.
 * Zero keeps it out of the table altogether.
 *
 * Ordering by frequency alone put "Internal ID" first: every item has one, and
 * none of them tell you which weapon to take. What makes a column worth a
 * column is whether it lets you rank or group the rows.
 *
 *   - numeric values rank ("Slash: 55" against "Slash: 73");
 *   - a handful of repeated values group ("Type: Sword" against "Axe");
 *   - a list of several entries per row does neither: "Immune to: Spirit,
 *     Chop, Pickaxe", the drops, the abilities, a recipe. Two lists that
 *     differ in one entry sort apart, and a column of them is a column of
 *     paragraphs, 312 pixels each: with its resistances, abilities and drops
 *     the Creatures table was 2,500 pixels wide. Left out, the article lists
 *     them; so is a recipe that puts its quantities first ("15 Linen
 *     thread"), which only looks like a number. A stat in alternatives
 *     ("Block armor: 21 (0 skill)" over "31.5 (100 skill)") still ranks: it
 *     repeats from row to row, where a recipe differs on every one;
 *   - a distinct string per row identifies, and identity is what the row
 *     header is already for. Prose (a sentence, or past 40 characters) and
 *     identifiers (one word that differs on every row, or that reads as a
 *     code: "SwordIron", "FeastAshlands_Material") are left out; any other
 *     distinct string ranks last;
 *   - one value on every row does neither: Food's "Teleportable: Yes" on all
 *     77, every Mead's "Stack: 10" and "Weight: 1.0", every crafting
 *     structure's "Type: Crafting", "Parry adrenaline: 5" on every weapon
 *     that has it. Left out, it leaves its place to a column that differs.
 *
 * Derived from the values themselves rather than from a list of field names,
 * so a wiki that renames or adds fields needs no change here. The one field
 * left out by name is the item's identifier (IDENTITY_LABELS), which a small
 * table cannot tell from a category by its values.
 */
export function comparability(columnValues: string[]): number {
  if (columnValues.length === 0) return 0;
  const values = columnValues.map((v) => v.trim());
  if (values.length >= 2 && new Set(values).size === 1) return 0;
  const share = (test: (value: string) => boolean): number => values.filter(test).length / values.length;
  const distinct = new Set(values).size / values.length;
  const enough = values.length >= DISTINCT_ROWS;

  // Entries one per line, as values are stored, or as the wiki wrote them:
  // "Fire, Poison", and "; " in rows stored before values kept their lines.
  const lists = share((v) => /\n|[;,]\s/.test(v)) >= 0.5;
  if (lists && enough && distinct > 0.5) return 0;

  if (share((v) => /^-?\d+(?:[.,]\d+)?/.test(v)) >= 0.5) return 3;
  if (lists) return 0;
  if (distinct <= 0.5) return 2;

  // A different string on (nearly) every row.
  const lengths = values.map((v) => v.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  if (median > PROSE_LENGTH || share((v) => /[.!?…]$/.test(v)) >= 0.5) return 0;

  // Identifiers, one or a few to a row: "SwordIron", a point of interest's
  // "AbandonedLogCabin02; AbandonedLogCabin03", a pot's "piece_pot3 (small)".
  const words = (v: string): boolean =>
    v.split(/\n|[;,]\s*/).every((entry) => !/\s/.test(entry.replace(/\([^)]*\)/g, '').trim()));
  if (share(words) >= 0.8) {
    if ((enough && distinct >= 0.9) || share((v) => /[a-z][A-Z]|_/.test(v)) >= 0.5) return 0;
  }
  return 0.4;
}

/** Upgrade-level labels available across a filtered set, for the level switcher. */
export async function listCompareTabs(
  db: Db,
  filter: BrowseFilter,
  options: BrowseOptions = {},
): Promise<string[]> {
  const conditions = [sql`a.infobox IS NOT NULL`, ...filterConditions(filter, options)];

  const rows = await rawQuery<{ label: string; n: string }>(
    db,
    sql`SELECT jsonb_array_elements(a.infobox->'tabs')->>'label' AS label, count(*)::text AS n
        FROM articles a
        WHERE ${sql.join(conditions, sql` AND `)}
        GROUP BY 1 ORDER BY count(*) DESC, 1`,
  );
  return rows.filter((r) => r.label).map((r) => r.label);
}

export type ContentHit = {
  slug: string;
  /** The article's English title. */
  title: string;
  sectionPath: string;
  /** Text around the match, with the matched words between `«` and `»`. */
  snippet: string;
  /** The article's name in the language asked for, when it differs from `title`. */
  name?: string;
  /** The language the snippet is in: a Spanish search can match English text. */
  snippetLang?: Lang;
};

/** `ts_headline` options: one short fragment, matches marked with guillemets rather than HTML. */
const HEADLINE = 'MaxWords=28, MinWords=12, ShortWord=2, MaxFragments=1, StartSel=«, StopSel=»';

/**
 * A translation's searchable text: its title, weighted like a chunk's title,
 * and its lead. Written exactly as the expression index in
 * drizzle/0007_search_translation_fts.sql (and `ensureSearchIndexes`) is, so
 * the planner can answer the match from that index instead of building the
 * vector for every translation on every search.
 */
const TRANSLATION_DOC = sql.raw(
  `(setweight(to_tsvector('simple', t.title), 'A') || setweight(to_tsvector('simple', t.lead), 'B'))`,
);

/** The index the translation half of the search reads. Same DDL as drizzle/0007. */
const TRANSLATION_SEARCH_INDEX = sql.raw(
  `CREATE INDEX IF NOT EXISTS article_translations_search_idx ON article_translations
     USING GIN ((setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', lead), 'B')))`,
);

/**
 * Creates the search's index on the translations, for a database whose deploy
 * skipped `pnpm db:migrate` (deploys here do not run migrations).
 *
 * The search is correct without it, only slower: every Spanish search then
 * builds the vectors of all ~850 translations, 40 ms of PGlite per query.
 * Only the table's owner may create an index, so with the least-privilege app
 * role this fails, which the caller logs once and otherwise ignores. The
 * catalog is asked first, because that role is refused even a `CREATE INDEX
 * IF NOT EXISTS` for an index that is already there.
 *
 * True when it created the index.
 */
export async function ensureSearchIndexes(db: Db): Promise<boolean> {
  const present = await rawQuery<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = 'article_translations_search_idx'`,
  );
  if (Number(present[0]?.n ?? 0) > 0) return false;
  await db.execute(TRANSLATION_SEARCH_INDEX);
  return true;
}

/**
 * Articles whose chunks are ranked in full, per search. The rest are cut on
 * the cheap signals first; a page of 20 results never reaches past the 60th
 * article in that order unless their ranks are within a hair of each other.
 */
const SHORTLIST = 60;

/**
 * Passages ranked per shortlisted article. A long page has a hundred chunks,
 * and `ts_rank_cd` on each was most of a search's cost; the ones that match
 * every word are taken first, so the passage shown is still the best one.
 */
const CHUNKS_PER_ARTICLE = 6;

/**
 * Full-text search over article bodies, for when the title index misses.
 *
 * Reuses the weighted `chunks.fts` column the retrieval path already
 * maintains, then joins back to articles for the slug — one index, two
 * consumers, and no second copy of the corpus to keep in step.
 *
 * The query is planned rather than passed through (`planSearch`): stop words
 * out, the glossary in ("hierro" also searches "iron"), accents folded, the
 * last word a prefix while it is being typed. Raw text through
 * `websearch_to_tsquery` ANDed every word, stop words included, so no Spanish
 * query and few English questions matched anything.
 *
 * One query, OR to find candidates, then ranked by how many of the query's
 * words the article's title covers, whether one passage matches them all, how
 * much of the title they are, and `ts_rank_cd` — the order that put the right
 * article first for 35 of 37 probe queries, Spanish and English. One hit per
 * article: five sections of the same page is a worse list than five pages.
 *
 * Bounded, because the route is public and a query of eight common words
 * matches most of the corpus. The title signals are per article (every chunk
 * carries its article's title), so they are computed once per article from
 * the title, not once per chunk; "matches every word" comes from a second
 * index scan, not from testing each candidate. Only the 60 articles those
 * signals put first have their passages ranked, at most six each. Measured
 * on PGlite, the slowest probes (eight common words) went from 750–900 ms to
 * about 100, and a one-word search takes 20–60.
 *
 * A Spanish search also reads the stored translations' titles and leads, so
 * a word that only the Spanish says ("cardo" for Thistle) still lands, and
 * returns each hit's Spanish name. Their bodies are not read: computed per
 * query that costs more than the rest of the search together, and the
 * glossary reaches the same paragraphs in English. The snippet quotes the
 * translation's lead whenever that lead has a searched word in it, whichever
 * text ranked the article: otherwise the best-matching articles, ranked by
 * their English passages, were the ones a Spanish reader got in English.
 *
 * `accents` lists the accented words the index holds (`getSearchVocabulary`);
 * without it, an unaccented query still matches unaccented text.
 */
export async function searchContent(
  db: Db,
  query: string,
  limit = 20,
  options: { lang?: Lang; accents?: AccentIndex } = {},
): Promise<ContentHit[]> {
  if (!query.trim()) return [];
  const lang = options.lang ?? 'en';
  const planned = searchTsQueries(planSearch(query), options.accents);
  if (!planned) return [];

  const W = sql.raw(`'{0.1, 0.2, 0.4, 1.0}'`);
  const order = sql`title_hits DESC, every_match DESC, title_hits::float / title_len DESC, rank DESC`;

  // One group: matching any word is matching every word, and the second
  // index scan would read the same chunks again.
  const complete =
    planned.every === planned.any
      ? sql`SELECT id FROM matched`
      : sql`SELECT c.id FROM chunks c WHERE c.fts @@ to_tsquery('simple', ${planned.every})`;

  const translationHits =
    lang === 'en'
      ? sql`SELECT NULL::text AS slug, 'es'::text AS src, NULL::text AS chunk_id, 0 AS title_hits,
                   false AS every_match, 1 AS title_len, 0::real AS rank
            WHERE false`
      : sql`SELECT a.slug, 'es'::text AS src, NULL::text AS chunk_id,
                   (SELECT count(*) FROM unnest(q.titleqs) tq WHERE d.doc @@ tq)::int AS title_hits,
                   (d.doc @@ to_tsquery('simple', ${planned.every})) AS every_match,
                   greatest(length(ts_filter(d.doc, '{a}')), 1) AS title_len,
                   ts_rank_cd(${W}, d.doc, q.anyq, 1) AS rank
            FROM (
              -- The vector is built once per matching row: OFFSET 0 keeps the
              -- planner from inlining it into each of the four uses above. It
              -- also keeps the language test out here, where it cannot tempt
              -- the planner into reading every translation through the
              -- language index (PGlite keeps no statistics to warn it off).
              SELECT t.page_key, t.lang, ${TRANSLATION_DOC} AS doc
              FROM article_translations t
              WHERE ${TRANSLATION_DOC} @@ to_tsquery('simple', ${planned.any})
              OFFSET 0
            ) d
            JOIN articles a ON a.page_key = d.page_key
            CROSS JOIN q
            WHERE d.lang = ${lang}`;

  const rows = await rawQuery<{
    slug: string;
    src: 'en' | 'es';
    title: string;
    translated: string | null;
    section_path: string;
    snippet: string;
  }>(
    db,
    sql`
      WITH q AS (
        SELECT to_tsquery('simple', ${planned.any}) AS anyq,
               ARRAY(SELECT to_tsquery('simple', x) FROM unnest(${textArray(planned.titles)}) AS x) AS titleqs
      ),
      matched AS MATERIALIZED (
        SELECT c.id, c.page_key, c.kind, c.section_path
        FROM chunks c WHERE c.fts @@ to_tsquery('simple', ${planned.any})
      ),
      complete AS MATERIALIZED (${complete}),
      candidates AS (
        SELECT m.page_key, count(*)::int AS n, bool_or(x.id IS NOT NULL) AS every_match
        FROM matched m LEFT JOIN complete x ON x.id = m.id
        GROUP BY m.page_key
      ),
      -- Materialized, and the title's vector fenced with OFFSET 0, so each is
      -- computed once per article rather than once per mention below.
      scored AS MATERIALIZED (
        SELECT a.slug, cd.page_key, cd.n, cd.every_match,
               (SELECT count(*) FROM unnest(q.titleqs) tq WHERE tv.doc @@ tq)::int AS title_hits,
               greatest(length(tv.doc), 1) AS title_len
        FROM candidates cd
        JOIN articles a ON a.page_key = cd.page_key
        CROSS JOIN LATERAL (SELECT setweight(to_tsvector('simple', a.title), 'A') AS doc OFFSET 0) tv
        CROSS JOIN q
      ),
      shortlist AS (
        SELECT * FROM scored
        ORDER BY title_hits DESC, every_match DESC, title_hits::float / title_len DESC, n DESC, slug
        LIMIT ${SHORTLIST}
      ),
      -- Which passages of an article are worth ranking: those with every
      -- word first, then the lead, prose before tables and the infobox, in
      -- page order (the id ends in the block's position).
      passages AS (
        SELECT s.slug, m.id, (x.id IS NOT NULL) AS whole,
               row_number() OVER (
                 PARTITION BY s.slug
                 ORDER BY (x.id IS NOT NULL) DESC, (m.section_path = '') DESC,
                          (m.kind = 'prose') DESC, (m.kind = 'table') DESC, length(m.id), m.id
               ) AS nth
        FROM shortlist s
        JOIN matched m ON m.page_key = s.page_key
        LEFT JOIN complete x ON x.id = m.id
      ),
      chunk_hits AS MATERIALIZED (
        SELECT DISTINCT ON (s.slug) s.slug, 'en'::text AS src, c.id AS chunk_id,
               s.title_hits, s.every_match, s.title_len,
               ts_rank_cd(${W}, c.fts, q.anyq, 1) AS rank
        FROM shortlist s
        JOIN passages p ON p.slug = s.slug AND p.nth <= ${CHUNKS_PER_ARTICLE} AND (p.whole OR NOT s.every_match)
        JOIN chunks c ON c.id = p.id
        CROSS JOIN q
        ORDER BY s.slug, rank DESC
      ),
      translation_hits AS MATERIALIZED (${translationHits}),
      best AS (
        SELECT DISTINCT ON (slug) * FROM (SELECT * FROM chunk_hits UNION ALL SELECT * FROM translation_hits) h
        ORDER BY slug, ${order}
      ),
      top AS (
        SELECT * FROM best ORDER BY ${order} LIMIT ${limit}
      )
      SELECT top.slug, (CASE WHEN top.src = 'es' OR l.es_lead THEN 'es' ELSE 'en' END) AS src,
             a.title, t.title AS translated,
             (CASE WHEN top.src = 'es' OR l.es_lead THEN '' ELSE coalesce(c.section_path, '') END) AS section_path,
             ts_headline('simple',
                         CASE WHEN top.src = 'es' THEN coalesce(nullif(t.lead, ''), t.title)
                              WHEN l.es_lead THEN t.lead
                              ELSE c.content END,
                         q.anyq, ${HEADLINE}) AS snippet
      FROM top
      JOIN articles a ON a.slug = top.slug
      LEFT JOIN chunks c ON c.id = top.chunk_id
      LEFT JOIN article_translations t ON t.page_key = a.page_key AND t.lang = ${lang}
      -- Which text the snippet quotes is decided here, apart from the
      -- ranking: an English passage can rank an article first (the English
      -- title is shorter than the glossed Spanish one, so it wins the title
      -- ratio), and a Spanish reader should still read Spanish when the
      -- translation's own lead says what was searched for. Only then: some
      -- leads are empty or a tab label ("CabezaPechoPiernas"), and those
      -- would be a worse snippet than the English passage.
      CROSS JOIN LATERAL (
        SELECT coalesce(${lang}::text <> 'en' AND t.lead <> '' AND to_tsvector('simple', t.lead) @@ q.anyq, false) AS es_lead
        FROM q
      ) l,
      q
      ORDER BY ${order}
    `,
  );

  return rows.map((row) => {
    const hit: ContentHit = {
      slug: row.slug,
      title: row.title,
      sectionPath: row.section_path,
      // List and table chunks are one item per line, which HTML runs together
      // into "Bloodgeon Blood Fang Brutal Slayer"; a separator keeps them apart.
      snippet: row.snippet.trim().replace(/\s*\n+\s*/g, ' · '),
    };
    if (lang !== 'en') {
      const name = spanishTitle(row.title, row.translated).name;
      if (name) hit.name = name;
      hit.snippetLang = row.src === 'es' ? lang : 'en';
    }
    return hit;
  });
}

/**
 * Every accented word the search reads, for folding queries (`accentIndex`).
 *
 * A few hundred words — Old Norse names in the English chunks, ordinary
 * Spanish in the translations' titles and leads — that change only when the
 * corpus does, so callers hold the list rather than ask per query.
 *
 * Most common first: a short prefix is offered only a few accented
 * completions (`spellings` in tsquery.ts), and they should be the words a
 * reader is likeliest to be typing, not the first ones alphabetically.
 */
export async function getSearchVocabulary(db: Db): Promise<string[]> {
  const rows = await rawQuery<{ word: string }>(
    db,
    sql`SELECT word FROM (
          SELECT word, ndoc FROM ts_stat('SELECT fts FROM chunks')
          UNION ALL
          SELECT word, ndoc FROM ts_stat($$SELECT to_tsvector('simple', title || ' ' || lead) FROM article_translations$$)
        ) w
        WHERE word ~ '[^\\x01-\\x7f]'
        GROUP BY word
        ORDER BY sum(ndoc) DESC, word`,
  );
  return rows.map((r) => r.word);
}

export async function countArticles(db: Db): Promise<number> {
  const rows = await rawQuery<{ n: string }>(db, sql`SELECT count(*)::text n FROM articles`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * The lead image for each of a set of articles, keyed by slug.
 *
 * Exists so an answer can show a picture without the model ever naming a URL.
 * A model asked for an image URL will happily invent a plausible one, and a
 * broken image in an answer about game mechanics reads as a broken app. Here
 * the model may only point at a source it already cited; the address comes
 * from the row the citation resolves to.
 *
 * Prefers the infobox image — on this wiki that is the item or creature
 * itself, shot on a plain background — and falls back to the first inline
 * image, which is usually a screenshot of it in the world.
 */
export async function getLeadImages(
  db: Db,
  slugs: string[],
): Promise<Map<string, { url: string; alt: string }>> {
  const wanted = [...new Set(slugs.filter(Boolean))];
  if (wanted.length === 0) return new Map();

  const rows = await rawQuery<{ slug: string; url: string | null; alt: string | null }>(
    db,
    sql`
      SELECT
        slug,
        COALESCE(infobox -> 'image' ->> 'url', images -> 0 ->> 'url')  AS url,
        COALESCE(infobox -> 'image' ->> 'alt', images -> 0 ->> 'alt')  AS alt
      FROM articles
      WHERE slug = ANY(${textArray(wanted)})
    `,
  );

  const found = new Map<string, { url: string; alt: string }>();
  for (const row of rows) {
    if (row.url) found.set(row.slug, { url: row.url, alt: row.alt ?? '' });
  }
  return found;
}

/** A cached translation, or null when the article has never been translated. */
export async function getTranslation(
  db: Db,
  pageKey: string,
  lang: string,
): Promise<{ title: string; doc: ArticleDoc; stale: boolean } | null> {
  const rows = await rawQuery<{
    title: string;
    lead: string;
    blocks: unknown;
    infobox: unknown;
    stale: boolean;
  }>(
    db,
    sql`
      SELECT t.title, t.lead, t.blocks, t.infobox,
             (t.source_updated_at < a.updated_at) AS stale
      FROM article_translations t
      JOIN articles a ON a.page_key = t.page_key
      WHERE t.page_key = ${pageKey} AND t.lang = ${lang}
      LIMIT 1
    `,
  );

  const row = rows[0];
  if (!row) return null;

  return {
    title: row.title,
    stale: row.stale,
    doc: {
      lead: row.lead,
      blocks: (row.blocks ?? []) as ArticleDoc['blocks'],
      infobox: (row.infobox ?? null) as ArticleDoc['infobox'],
      // Images and facets are never translated: one is binary, the other is
      // matched against English values elsewhere in the app.
      images: [],
      facets: {},
    },
  };
}

/** Stores a translation, replacing any earlier one for the same article and language. */
export async function saveTranslation(
  db: Db,
  input: {
    pageKey: string;
    lang: string;
    title: string;
    doc: ArticleDoc;
    model: string;
    sourceUpdatedAt: Date;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO article_translations
      (page_key, lang, title, lead, blocks, infobox, model, source_updated_at)
    VALUES (
      ${input.pageKey}, ${input.lang}, ${input.title}, ${input.doc.lead},
      ${JSON.stringify(input.doc.blocks)}::jsonb,
      ${input.doc.infobox === null ? null : JSON.stringify(input.doc.infobox)}::jsonb,
      ${input.model}, ${input.sourceUpdatedAt.toISOString()}
    )
    ON CONFLICT (page_key, lang) DO UPDATE SET
      title = EXCLUDED.title,
      lead = EXCLUDED.lead,
      blocks = EXCLUDED.blocks,
      infobox = EXCLUDED.infobox,
      model = EXCLUDED.model,
      source_updated_at = EXCLUDED.source_updated_at,
      created_at = now()
  `);
}

/**
 * Every name that can be linked to an article, in the reader's language.
 *
 * One term per English title, plus one per translated title where a
 * translation exists — a Spanish page names things in Spanish and only
 * sometimes carries the English alongside. The translated title is stored
 * with its gloss (`Diente de león (Dandelion)`), which is dropped here: the
 * term is the name alone, and the gloss is matched by the English entry.
 *
 * A translated term carries the English title (`english`), which is how the
 * article page checks a Spanish name against the English sentence it came
 * from before linking it — "claro" is the Glade's name and also the word for
 * "clear".
 */
export async function getLinkIndex(db: Db, lang: string): Promise<LinkTarget[]> {
  const rows = await rawQuery<{ slug: string; title: string; translated: string | null }>(
    db,
    sql`SELECT a.slug, a.title, t.title AS translated
        FROM articles a
        LEFT JOIN article_translations t ON t.page_key = a.page_key AND t.lang = ${lang}
        ORDER BY a.title`,
  );

  const out: LinkTarget[] = [];
  for (const row of rows) {
    const translated = row.translated ? spanishName(row.translated, row.title) : null;
    const title = translated || row.title;
    out.push({ match: row.title, slug: row.slug, title });
    if (translated && normalizeTerm(translated) !== normalizeTerm(row.title)) {
      out.push({ match: translated, slug: row.slug, title, english: row.title });
    }
  }
  return out;
}

/** An article a recipe ingredient points at. */
export type IngredientTarget = { slug: string; title: string; icon: string | null };

/**
 * Resolves ingredient names to the articles that describe them, in one query.
 *
 * By title rather than by slug, because a recipe names its materials the way
 * the wiki writes them — `Leather scraps` — and the slug is a derived form.
 * Matched case- and whitespace-insensitively: `Iron Nails` and `Iron nails`
 * are the same material, and which one a recipe happened to use should not
 * decide whether the reader gets a picture and a link.
 *
 * One query for the whole recipe. A lookup per ingredient would be a dozen
 * round trips to a metered database to render a single infobox row.
 *
 * The whitespace pattern is `\s`, doubled, because this is a TypeScript
 * string before it is a regular expression. Written once it becomes the plain
 * letter `s`, and the query then normalises by collapsing every s in a title:
 * `Bronze Nails` matched nothing because it had been folded to `bronze nail `.
 */
export async function getIngredientTargets(
  db: Db,
  names: string[],
): Promise<Map<string, IngredientTarget>> {
  const wanted = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  if (wanted.length === 0) return new Map();

  const rows = await rawQuery<{ key: string; slug: string; title: string; icon: string | null }>(
    db,
    sql`
      SELECT lower(regexp_replace(title, '\\s+', ' ', 'g')) AS key,
             slug, title,
             ${ARTICLE_ICON} AS icon
      FROM articles
      WHERE lower(regexp_replace(title, '\\s+', ' ', 'g')) = ANY(${textArray(wanted)})
    `,
  );

  return new Map(rows.map((row) => [row.key, { slug: row.slug, title: row.title, icon: row.icon }]));
}
