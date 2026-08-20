import { sql } from 'drizzle-orm';
import { rawQuery, type Db } from './create-db';
import { articles } from './schema';
import type { ArticleDoc } from '@/lib/wiki/article-types';

export type StoredArticle = {
  pageKey: string;
  source: string;
  title: string;
  slug: string;
  url: string;
  categories: string[];
  doc: ArticleDoc;
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
};

function toStored(row: ArticleRow): StoredArticle {
  return {
    pageKey: row.page_key,
    source: row.source,
    title: row.title,
    slug: row.slug,
    url: row.url,
    categories: row.categories ?? [],
    doc: {
      lead: row.lead,
      blocks: row.blocks ?? [],
      infobox: row.infobox ?? null,
      images: row.images ?? [],
      facets: row.facets ?? {},
    },
  };
}

export async function getArticleBySlug(db: Db, slug: string): Promise<StoredArticle | null> {
  const rows = await rawQuery<ArticleRow>(
    db,
    sql`SELECT page_key, source, title, slug, url, categories, lead, blocks, infobox, images, facets
        FROM articles WHERE slug = ${slug} LIMIT 1`,
  );
  return rows[0] ? toStored(rows[0]) : null;
}

/** Resolves the slug for a wiki title, so a citation can link inward. */
export async function getSlugForTitle(db: Db, title: string): Promise<string | null> {
  const rows = await rawQuery<{ slug: string }>(
    db,
    sql`SELECT slug FROM articles WHERE lower(title) = lower(${title}) LIMIT 1`,
  );
  return rows[0]?.slug ?? null;
}

export type TitleIndexEntry = {
  s: string; // slug
  t: string; // title
  c: string[]; // categories
  y?: string; // type facet
  i?: string; // icon url
};

/**
 * The whole title list, shipped to the browser for instant search.
 *
 * About 1,000 entries. Keys are one character because this payload is
 * downloaded on every cold load and cached for offline use; the difference is
 * roughly a third of the transfer for no loss of clarity at the call site,
 * where it is mapped to real names immediately.
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
               infobox->'image'->>'url' AS icon
        FROM articles ORDER BY title`,
  );

  return rows.map((r) => {
    const entry: TitleIndexEntry = { s: r.slug, t: r.title, c: r.categories ?? [] };
    if (r.type) entry.y = r.type;
    if (r.icon) entry.i = r.icon;
    return entry;
  });
}

export type CategorySummary = { name: string; count: number };

/** Categories with at least `min` articles, largest first. */
export async function listCategories(db: Db, min = 3): Promise<CategorySummary[]> {
  const rows = await rawQuery<{ name: string; n: string }>(
    db,
    sql`SELECT jsonb_array_elements_text(categories) AS name, count(*)::text AS n
        FROM articles
        GROUP BY 1
        HAVING count(*) >= ${min}
        ORDER BY count(*) DESC, 1`,
  );
  return rows.map((r) => ({ name: r.name, count: Number(r.n) }));
}

/** Distinct values of one facet, with counts. */
export async function listFacetValues(
  db: Db,
  facet: 'biome' | 'station' | 'type',
): Promise<CategorySummary[]> {
  const rows = await rawQuery<{ name: string; n: string }>(
    db,
    sql`SELECT facets->>${facet} AS name, count(*)::text AS n
        FROM articles
        WHERE facets->>${facet} IS NOT NULL AND facets->>${facet} <> ''
        GROUP BY 1 ORDER BY count(*) DESC, 1`,
  );
  return rows.map((r) => ({ name: r.name, count: Number(r.n) }));
}

export type ArticleSummary = {
  slug: string;
  title: string;
  lead: string;
  icon: string | null;
  facets: Record<string, string>;
};

export type BrowseFilter = {
  category?: string;
  biome?: string;
  station?: string;
  type?: string;
};

/** Articles matching a category and any facet filters, alphabetically. */
export async function listArticles(
  db: Db,
  filter: BrowseFilter,
  limit = 500,
): Promise<ArticleSummary[]> {
  const conditions = [sql`TRUE`];
  if (filter.category) {
    conditions.push(sql`categories @> ${JSON.stringify([filter.category])}::jsonb`);
  }
  for (const key of ['biome', 'station', 'type'] as const) {
    const value = filter[key];
    if (value) conditions.push(sql`facets->>${key} = ${value}`);
  }

  const rows = await rawQuery<{
    slug: string;
    title: string;
    lead: string;
    icon: string | null;
    facets: Record<string, string>;
  }>(
    db,
    sql`SELECT slug, title, lead, infobox->'image'->>'url' AS icon, facets
        FROM articles
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY title
        LIMIT ${limit}`,
  );

  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    lead: r.lead,
    icon: r.icon,
    facets: r.facets ?? {},
  }));
}

export type CompareRow = { slug: string; title: string; icon: string | null; values: Record<string, string> };
export type CompareTable = { columns: string[]; rows: CompareRow[] };

/**
 * Builds a comparison table for a category.
 *
 * Generic on purpose: the columns are whatever infobox labels the category's
 * articles actually share, so a new item type needs no schema written for it.
 * Only labels present on at least a quarter of the rows become columns —
 * otherwise one unusual item adds a column that is empty for everything else.
 */
export async function buildCompareTable(
  db: Db,
  filter: BrowseFilter,
  options: { tab?: string; maxColumns?: number } = {},
): Promise<CompareTable> {
  const { tab, maxColumns = 12 } = options;

  const conditions = [sql`infobox IS NOT NULL`];
  if (filter.category) {
    conditions.push(sql`categories @> ${JSON.stringify([filter.category])}::jsonb`);
  }
  for (const key of ['biome', 'station', 'type'] as const) {
    const value = filter[key];
    if (value) conditions.push(sql`facets->>${key} = ${value}`);
  }

  const rows = await rawQuery<{
    slug: string;
    title: string;
    icon: string | null;
    infobox: {
      common?: { label: string; rows: { label: string; value: string }[] }[];
      tabs?: { label: string; groups: { label: string; rows: { label: string; value: string }[] }[] }[];
    };
  }>(
    db,
    sql`SELECT slug, title, infobox->'image'->>'url' AS icon, infobox
        FROM articles
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY title
        LIMIT 300`,
  );

  const frequency = new Map<string, number>();
  const values = new Map<string, string[]>();
  const collected: CompareRow[] = [];

  for (const row of rows) {
    const rowValues: Record<string, string> = {};

    for (const group of row.infobox?.common ?? []) {
      for (const r of group.rows) rowValues[r.label] ??= r.value;
    }

    // Prefer the requested upgrade level; otherwise the first tab, which is
    // the base item — comparing a level 1 sword against a level 4 one would
    // be a silently wrong table.
    const tabs = row.infobox?.tabs ?? [];
    const chosen = (tab ? tabs.find((t) => t.label === tab) : undefined) ?? tabs[0];
    for (const group of chosen?.groups ?? []) {
      for (const r of group.rows) rowValues[r.label] ??= r.value;
    }

    for (const [label, value] of Object.entries(rowValues)) {
      frequency.set(label, (frequency.get(label) ?? 0) + 1);
      values.set(label, [...(values.get(label) ?? []), value]);
    }
    collected.push({ slug: row.slug, title: row.title, icon: row.icon, values: rowValues });
  }

  const threshold = Math.max(2, Math.ceil(collected.length / 4));
  const columns = [...frequency.entries()]
    .filter(([, n]) => n >= threshold)
    .map(([label, n]) => ({ label, score: n * comparability(values.get(label) ?? []) }))
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, maxColumns)
    .map((c) => c.label);

  return { columns, rows: collected };
}

/**
 * How useful a column is for comparing, as a multiplier on how common it is.
 *
 * Ordering by frequency alone put "Internal ID" first: every item has one, and
 * none of them tell you which weapon to take. What makes a column worth a
 * column is whether it lets you rank or group the rows.
 *
 *   - numeric values rank ("Slash: 55" against "Slash: 73");
 *   - a handful of repeated values group ("Type: Sword" against "Axe");
 *   - a distinct string per row identifies, and identity is what the row
 *     header is already for.
 *
 * Derived from the values themselves rather than from a list of field names,
 * so a wiki that renames or adds fields needs no change here.
 */
export function comparability(columnValues: string[]): number {
  if (columnValues.length === 0) return 0;

  const numeric = columnValues.filter((v) => /^-?\d+(?:[.,]\d+)?/.test(v.trim())).length;
  if (numeric / columnValues.length >= 0.5) return 3;

  const distinct = new Set(columnValues).size;
  return distinct / columnValues.length <= 0.5 ? 2 : 0.4;
}

/** Upgrade-level labels available across a filtered set, for the level switcher. */
export async function listCompareTabs(db: Db, filter: BrowseFilter): Promise<string[]> {
  const conditions = [sql`infobox IS NOT NULL`];
  if (filter.category) {
    conditions.push(sql`categories @> ${JSON.stringify([filter.category])}::jsonb`);
  }
  for (const key of ['biome', 'station', 'type'] as const) {
    const value = filter[key];
    if (value) conditions.push(sql`facets->>${key} = ${value}`);
  }

  const rows = await rawQuery<{ label: string; n: string }>(
    db,
    sql`SELECT jsonb_array_elements(infobox->'tabs')->>'label' AS label, count(*)::text AS n
        FROM articles
        WHERE ${sql.join(conditions, sql` AND `)}
        GROUP BY 1 ORDER BY count(*) DESC, 1`,
  );
  return rows.filter((r) => r.label).map((r) => r.label);
}

export type ContentHit = {
  slug: string;
  title: string;
  sectionPath: string;
  snippet: string;
};

/**
 * Full-text search over article bodies, for when the title index misses.
 *
 * Reuses the weighted `chunks.fts` column the retrieval path already
 * maintains, then joins back to articles for the slug — one index, two
 * consumers, and no second copy of the corpus to keep in step.
 */
export async function searchContent(db: Db, query: string, limit = 20): Promise<ContentHit[]> {
  if (!query.trim()) return [];

  const rows = await rawQuery<{
    slug: string;
    title: string;
    section_path: string;
    snippet: string;
  }>(
    db,
    sql`
      SELECT a.slug, c.title, c.section_path,
             ts_headline('simple', c.content, q,
                         'MaxWords=28, MinWords=12, ShortWord=2, MaxFragments=1, StartSel=«, StopSel=»') AS snippet
      FROM chunks c
      JOIN articles a ON a.page_key = c.page_key,
           websearch_to_tsquery('simple', ${query}) q
      WHERE c.fts @@ q
      ORDER BY ts_rank_cd('{0.1, 0.2, 0.4, 1.0}', c.fts, q, 1) DESC
      LIMIT ${limit}
    `,
  );

  // One hit per article: five sections of the same page is a worse result list
  // than five different pages.
  const seen = new Set<string>();
  const hits: ContentHit[] = [];
  for (const row of rows) {
    if (seen.has(row.slug)) continue;
    seen.add(row.slug);
    hits.push({
      slug: row.slug,
      title: row.title,
      sectionPath: row.section_path,
      snippet: row.snippet,
    });
  }
  return hits;
}

export async function countArticles(db: Db): Promise<number> {
  const rows = await rawQuery<{ n: string }>(db, sql`SELECT count(*)::text n FROM articles`);
  return Number(rows[0]?.n ?? 0);
}
