import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { rawQuery, type Db } from './create-db';
import { chunks, conversations, ingestRuns, messages, pages, settings, type Citation } from './schema';
import type { WikiChunk } from '@/lib/wiki/types';

/* -------------------------------------------------------------------------- */
/* Pages and chunks                                                            */
/* -------------------------------------------------------------------------- */

export type StoredPage = { key: string; pageId: number; revid: number };

/** Revision ids already indexed for a source, keyed by page id. */
export async function getIndexedRevisions(db: Db, source: string): Promise<Map<number, StoredPage>> {
  const rows = await db
    .select({ key: pages.key, pageId: pages.pageId, revid: pages.revid })
    .from(pages)
    .where(eq(pages.source, source));
  return new Map(rows.map((r) => [r.pageId, r]));
}

/** Content hash -> embedding, for every chunk of a page. */
export async function getExistingEmbeddings(
  db: Db,
  pageKey: string,
): Promise<Map<string, string>> {
  const rows = await rawQuery<{ content_hash: string; embedding: string | null }>(
    db,
    sql`SELECT content_hash, embedding::text AS embedding FROM chunks WHERE page_key = ${pageKey}`,
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.embedding) out.set(r.content_hash, r.embedding);
  }
  return out;
}

export type PageUpsert = {
  key: string;
  source: string;
  pageId: number;
  title: string;
  url: string;
  revid: number;
  categories: string[];
};

export async function upsertPage(db: Db, page: PageUpsert): Promise<void> {
  await db
    .insert(pages)
    .values({ ...page, fetchedAt: new Date(), indexedAt: new Date() })
    .onConflictDoUpdate({
      target: pages.key,
      set: {
        title: page.title,
        url: page.url,
        revid: page.revid,
        categories: page.categories,
        fetchedAt: new Date(),
        indexedAt: new Date(),
      },
    });
}

/**
 * Replaces every chunk of a page.
 *
 * Delete-then-insert rather than a diff: a page's chunk ids shift whenever a
 * section is added, so reconciling them individually is more code and more
 * ways to leave an orphan behind. Embeddings are still reused by content hash,
 * which is where the actual cost is.
 */
export async function replacePageChunks(
  db: Db,
  pageKey: string,
  rows: (WikiChunk & { embedding: string | null })[],
): Promise<void> {
  await db.delete(chunks).where(eq(chunks.pageKey, pageKey));
  if (rows.length === 0) return;

  /*
   * One statement per page rather than one per chunk.
   *
   * Against a local database the difference is invisible; against a managed
   * Postgres a round trip is ~150 ms, and a row-at-a-time insert turned a
   * full ingest into an hour. Batching cuts it to roughly a sixth.
   *
   * Batched at 50 rows so a page with an unusual number of sections cannot
   * approach the parameter limit.
   */
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const values = batch.map(
      (row) => sql`(${row.id}, ${row.pageKey}, ${row.source}, ${row.sourceRank}, ${row.title},
                    ${row.url}, ${row.sectionPath}, ${row.kind}, ${row.content}, ${row.tokenCount},
                    ${row.contentHash},
                    ${row.embedding === null ? null : sql`${row.embedding}::vector`})`,
    );

    await db.execute(sql`
      INSERT INTO chunks (id, page_key, source, source_rank, title, url, section_path, kind,
                          content, token_count, content_hash, embedding)
      VALUES ${sql.join(values, sql`, `)}
    `);
  }
}

/**
 * Removes pages that no longer exist upstream. Chunks cascade.
 *
 * The id list is passed as a single `int[]` literal rather than as one bound
 * parameter per id: Drizzle renders a JS array as a tuple, which Postgres
 * rejects for `ALL(...)`, and a thousand-parameter `IN` list would not survive
 * Neon's HTTP query size limit anyway.
 */
export async function deleteMissingPages(
  db: Db,
  source: string,
  livePageIds: number[],
): Promise<number> {
  if (livePageIds.length === 0) return 0;
  const ids = livePageIds.map(Number).filter(Number.isInteger);
  if (ids.length === 0) return 0;
  const literal = `{${ids.join(',')}}`;

  const rows = await rawQuery<{ count: string }>(
    db,
    sql`
      WITH deleted AS (
        DELETE FROM pages
        WHERE source = ${source} AND page_id <> ALL(${literal}::int[])
        RETURNING key
      )
      SELECT count(*)::text AS count FROM deleted
    `,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Drops chunks from a lower-priority wiki that duplicate one from a preferred
 * wiki. A no-op while only one source is configured; it exists so adding a
 * second source does not double every answer's context.
 */
export async function dedupeAcrossSources(db: Db, threshold = 0.95): Promise<number> {
  const rows = await rawQuery<{ count: string }>(
    db,
    sql`
      WITH deleted AS (
        DELETE FROM chunks c
        USING chunks p
        WHERE c.source_rank > p.source_rank
          AND lower(c.title) = lower(p.title)
          AND c.embedding IS NOT NULL
          AND p.embedding IS NOT NULL
          AND (1 - (c.embedding <=> p.embedding)) > ${threshold}
        RETURNING c.id
      )
      SELECT count(*)::text AS count FROM deleted
    `,
  );
  return Number(rows[0]?.count ?? 0);
}

export async function countChunks(db: Db): Promise<number> {
  const rows = await rawQuery<{ count: string }>(db, sql`SELECT count(*)::text AS count FROM chunks`);
  return Number(rows[0]?.count ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export const EMBEDDING_PROVIDER_KEY = 'embedding_provider';

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/** Drops every stored vector, so the next ingest recomputes them all. */
export async function clearEmbeddings(db: Db): Promise<void> {
  await db.execute(sql`UPDATE chunks SET embedding = NULL`);
}

/* -------------------------------------------------------------------------- */
/* Ingest runs                                                                 */
/* -------------------------------------------------------------------------- */

export type IngestRunStats = {
  pagesSeen: number;
  pagesChanged: number;
  chunksWritten: number;
  embeddingsComputed: number;
  errors: { title: string; message: string }[];
};

export async function startIngestRun(db: Db, id: string, trigger: string): Promise<void> {
  await db.insert(ingestRuns).values({ id, trigger, status: 'running', startedAt: new Date() });
}

export async function finishIngestRun(
  db: Db,
  id: string,
  status: 'ok' | 'failed',
  stats: IngestRunStats,
  durationMs: number,
): Promise<void> {
  await db
    .update(ingestRuns)
    .set({ status, finishedAt: new Date(), durationMs, ...stats })
    .where(eq(ingestRuns.id, id));
}

export async function latestIngestRuns(db: Db, limit = 5) {
  return db.select().from(ingestRuns).orderBy(desc(ingestRuns.startedAt)).limit(limit);
}

/* -------------------------------------------------------------------------- */
/* Conversations                                                               */
/* -------------------------------------------------------------------------- */

export async function listConversations(db: Db, profile: string, limit = 50) {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      lang: conversations.lang,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(eq(conversations.profile, profile))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

export async function createConversation(
  db: Db,
  input: { id: string; profile: string; title: string; lang: 'es' | 'en' },
): Promise<void> {
  await db.insert(conversations).values(input);
}

/**
 * Fetches a conversation only if it belongs to this profile.
 *
 * Ownership is checked in the query rather than after loading, so a guessed id
 * cannot reach another profile's history even for a moment.
 */
export async function getConversation(db: Db, id: string, profile: string) {
  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.profile, profile)))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteConversation(db: Db, id: string, profile: string): Promise<boolean> {
  const existing = await getConversation(db, id, profile);
  if (!existing) return false;
  await db.delete(conversations).where(eq(conversations.id, id));
  return true;
}

export async function renameConversation(
  db: Db,
  id: string,
  profile: string,
  title: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(conversations.id, id), eq(conversations.profile, profile)));
}

export async function touchConversation(db: Db, id: string): Promise<void> {
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));
}

export async function listMessages(db: Db, conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

export async function appendMessage(
  db: Db,
  input: {
    id: string;
    conversationId: string;
    role: 'user' | 'assistant';
    parts: unknown[];
    citations?: Citation[];
  },
): Promise<void> {
  // Ignore a repeat: regenerating or retrying resends a message id that is
  // already stored, and losing the request over a duplicate would be worse
  // than storing it once.
  await db
    .insert(messages)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      role: input.role,
      parts: input.parts,
      citations: input.citations ?? [],
    })
    .onConflictDoNothing({ target: messages.id });
}
