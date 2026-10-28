import { sql, type SQL } from 'drizzle-orm';
import { rawQuery, type Db } from '@/lib/db/create-db';
import { toVectorLiteral } from '@/lib/rag/embed-types';
import type { ArticleDoc } from '@/lib/wiki/article-types';

/**
 * The ingest's own reads and writes: what it needs to decide which pages to
 * re-derive, and to store what it derived without disturbing what did not
 * change.
 */

/** `IndexedPage.parserVersion` of a page that has chunks but no article. */
export const NO_ARTICLE = -1;

/**
 * `pages.revid` while a page is being rewritten: never a live revision id,
 * so a run that stops partway — a failed statement, a kill — leaves the page
 * looking revised to the next one (see `ingestOnePage`).
 */
export const UNFINISHED = -1;

export type IndexedPage = {
  key: string;
  revid: number;
  /** Version of the parser that built the page's article; NO_ARTICLE when it has none. */
  parserVersion: number;
};

/** Every indexed page of a source, keyed by page id, with how it was built. */
export async function getIndexedPages(db: Db, source: string): Promise<Map<number, IndexedPage>> {
  const rows = await rawQuery<{
    key: string;
    page_id: number;
    revid: number;
    parser_version: number | null;
  }>(
    db,
    sql`SELECT p.key, p.page_id, p.revid, a.parser_version
        FROM pages p LEFT JOIN articles a ON a.page_key = p.key
        WHERE p.source = ${source}`,
  );
  return new Map(
    rows.map((r) => [
      Number(r.page_id),
      {
        key: r.key,
        revid: Number(r.revid),
        parserVersion: r.parser_version === null ? NO_ARTICLE : Number(r.parser_version),
      },
    ]),
  );
}

export type ArticleWrite = {
  pageKey: string;
  source: string;
  title: string;
  slug: string;
  url: string;
  categories: string[];
  doc: ArticleDoc;
  parserVersion: number;
  /**
   * The page's live revision, recorded on its `pages` row by the same
   * statement as the article, so neither is ever stored without the other.
   * Left out, the row's revision is not touched.
   */
  revid?: number;
};

/**
 * An article's image captions by image URL: what a translation keeps of its
 * images (`captionsOf` in translate.ts), and lays over them by URL. Null when
 * no image has a caption.
 */
const captionsByUrl = (images: SQL): SQL => sql`(
  SELECT jsonb_object_agg(i->>'url', i->>'caption')
  FROM jsonb_array_elements(${images}) AS i
  WHERE i->>'url' IS NOT NULL AND btrim(coalesce(i->>'caption', '')) <> ''
)`;

/**
 * Stores an article, and says whether what a reader sees changed.
 *
 * `updated_at` is what marks a translation stale (the translation records the
 * `updated_at` it was made from). Writing it on every upsert meant that a
 * `--full` re-index of an unchanged wiki marked all 850 Spanish translations
 * stale, and signed-in views would then re-translate — and overwrite —
 * translations that were still exactly right. It now moves only when
 * something translated changes: the title, the lead, the blocks, the infobox,
 * or the image captions. A translation stores those by image URL, so a new
 * caption, an edited one, or a captioned image under a new URL each leave it
 * showing an old or an English caption, and count. The rest of an image (its
 * alt text, an uncaptioned image), the facets and the categories are never
 * translated, so they update in place without touching it.
 *
 * Written here rather than through `upsertArticle` because it also records
 * the parser version, which only the ingest knows — and, given `revid`, the
 * page's revision, in the same statement: the article and the revision it
 * was built from are stored together or not at all.
 *
 * The timestamp comes from here, not from `now()`, for the same reason the
 * old upsert used a JS date: a translation stores the time it was made from
 * as a JS date, with millisecond precision, and against a microsecond
 * `now()` every fresh translation would compare as older than its article.
 */
export async function writeArticle(db: Db, input: ArticleWrite): Promise<boolean> {
  const { doc } = input;
  const stamp = new Date().toISOString();
  const rows = await rawQuery<{ changed: boolean }>(
    db,
    sql`
      ${
        input.revid === undefined
          ? sql.empty()
          : sql`WITH revision AS (UPDATE pages SET revid = ${input.revid} WHERE key = ${input.pageKey})`
      }
      INSERT INTO articles AS a
        (page_key, source, title, slug, url, categories, lead, blocks, infobox, images, facets,
         parser_version, updated_at)
      VALUES (
        ${input.pageKey}, ${input.source}, ${input.title}, ${input.slug}, ${input.url},
        ${JSON.stringify(input.categories)}::jsonb, ${doc.lead}, ${JSON.stringify(doc.blocks)}::jsonb,
        ${doc.infobox === null ? null : JSON.stringify(doc.infobox)}::jsonb,
        ${JSON.stringify(doc.images)}::jsonb, ${JSON.stringify(doc.facets)}::jsonb,
        ${input.parserVersion}, ${stamp}::timestamptz
      )
      ON CONFLICT (page_key) DO UPDATE SET
        source = EXCLUDED.source,
        title = EXCLUDED.title,
        slug = EXCLUDED.slug,
        url = EXCLUDED.url,
        categories = EXCLUDED.categories,
        lead = EXCLUDED.lead,
        blocks = EXCLUDED.blocks,
        infobox = EXCLUDED.infobox,
        images = EXCLUDED.images,
        facets = EXCLUDED.facets,
        parser_version = EXCLUDED.parser_version,
        updated_at = CASE
          WHEN (a.title, a.lead, a.blocks, a.infobox, ${captionsByUrl(sql`a.images`)})
               IS DISTINCT FROM
               (EXCLUDED.title, EXCLUDED.lead, EXCLUDED.blocks, EXCLUDED.infobox, ${captionsByUrl(sql`EXCLUDED.images`)})
          THEN EXCLUDED.updated_at
          ELSE a.updated_at
        END
      RETURNING a.updated_at = ${stamp}::timestamptz AS changed
    `,
  );
  return Boolean(rows[0]?.changed);
}

/** Chunks embedded per request when filling in missing vectors. */
const BACKFILL_BATCH = 64;

/**
 * Gives every chunk that has no vector one, from its stored text.
 *
 * Runs at the start of every ingest, before the wiki is read, and again at
 * the end. It is what makes `--reembed` and `--switch-provider` complete: the
 * vectors are dropped for the whole index, and only the pages that changed
 * are re-fetched, so everything else is re-embedded here from text the
 * database already holds — the embedded text is the chunk's content, so there
 * is nothing to fetch. It also heals an index a failed run left with holes:
 * retrieval only searches chunks that have a vector, so a hole is a page that
 * silently stops being found by meaning.
 *
 * Returns the number of chunks embedded; `onBatch` hears the running total.
 */
export async function embedMissingVectors(
  db: Db,
  embed: (texts: string[]) => Promise<number[][]>,
  onBatch?: (embedded: number) => void,
): Promise<number> {
  const attempted = new Set<string>();
  let embedded = 0;

  for (;;) {
    const rows = await rawQuery<{ id: string; content: string }>(
      db,
      sql`SELECT id, content FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH}`,
    );
    if (rows.length === 0) return embedded;

    // A chunk that comes back after its update is one the database refused;
    // trying again would loop forever.
    const repeat = rows.find((row) => attempted.has(row.id));
    if (repeat) throw new Error(`could not store a vector for chunk ${repeat.id}`);
    for (const row of rows) attempted.add(row.id);

    const vectors = await embed(rows.map((row) => row.content));
    if (vectors.length !== rows.length) {
      throw new Error(`the embedding provider returned ${vectors.length} vectors for ${rows.length} chunks`);
    }

    const values = rows.map((row, i) => sql`(${row.id}, ${toVectorLiteral(vectors[i]!)})`);
    await db.execute(sql`
      UPDATE chunks AS c
      SET embedding = v.embedding::vector
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, embedding)
      WHERE c.id = v.id
    `);
    embedded += rows.length;
    onBatch?.(embedded);
  }
}

/** Chunks that retrieval cannot find by meaning, because they have no vector. */
export async function countMissingVectors(db: Db): Promise<number> {
  const rows = await rawQuery<{ n: string }>(
    db,
    sql`SELECT count(*)::text AS n FROM chunks WHERE embedding IS NULL`,
  );
  return Number(rows[0]?.n ?? 0);
}
