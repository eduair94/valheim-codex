import pLimit from 'p-limit';
import type { Db } from '@/lib/db/create-db';
import {
  clearEmbeddings,
  deleteMissingPages,
  dedupeAcrossSources,
  EMBEDDING_PROVIDER_KEY,
  finishIngestRun,
  getExistingEmbeddings,
  getIndexedRevisions,
  getSetting,
  replacePageChunks,
  setSetting,
  startIngestRun,
  upsertPage,
  type IngestRunStats,
} from '@/lib/db/repo';
import { chunkPage } from '@/lib/wiki/chunker';
import { extractArticle } from '@/lib/wiki/article';
import { slugify } from '@/lib/wiki/slug';
import { upsertArticle } from '@/lib/db/wiki-repo';
import { extractSections } from '@/lib/wiki/html';
import { extractInfobox } from '@/lib/wiki/infobox';
import type { MediaWikiClient } from '@/lib/wiki/mediawiki';
import { SOURCES } from '@/lib/wiki/sources';
import type { PageRef, WikiChunk, WikiSource } from '@/lib/wiki/types';
import { getEmbeddingProvider, toVectorLiteral } from '@/lib/rag/embed';

export type IngestOptions = {
  db: Db;
  client: MediaWikiClient;
  sources?: WikiSource[];
  /** Re-parse and re-embed every page, ignoring stored revision ids. */
  full?: boolean;
  /** Stop after this many changed pages. For smoke tests. */
  limit?: number;
  /** Concurrent page fetches. MediaWiki asks clients to stay modest. */
  concurrency?: number;
  trigger?: string;
  onProgress?: (event: ProgressEvent) => void;
  /** Injected in tests to avoid calling the embeddings API. */
  embedFn?: (texts: string[]) => Promise<number[][]>;
  /** Discard stored vectors and recompute them all. */
  reembed?: boolean;
  /** Identifier recorded so a later run can detect a provider change. */
  embeddingProviderId?: string;
  /** Injected so runs are reproducible in tests. */
  runId?: string;
};

export type ProgressEvent =
  | { type: 'listed'; source: string; pages: number }
  | { type: 'planned'; source: string; changed: number }
  | { type: 'page'; source: string; title: string; index: number; total: number; chunks: number }
  | { type: 'error'; title: string; message: string }
  | { type: 'reembed'; reason: string }
  | { type: 'done'; stats: IngestRunStats };

export type IngestResult = IngestRunStats & { runId: string; durationMs: number };

/**
 * Fetches, parses, chunks and embeds the configured wikis.
 *
 * Incremental by default: MediaWiki reports the current revision id of 50 pages
 * per request, so an ordinary re-index reads a handful of requests and touches
 * only the pages a patch actually changed. Within a changed page, chunks whose
 * content hash is unchanged keep their existing embedding, so a one-line edit
 * does not pay to re-embed the whole article.
 */
export async function runIngest(options: IngestOptions): Promise<IngestResult> {
  const {
    db,
    client,
    sources = SOURCES,
    full = false,
    limit,
    concurrency = 3,
    trigger = 'cli',
    onProgress,
    reembed = false,
    embedFn,
    embeddingProviderId,
    runId = `run-${Date.now().toString(36)}`,
  } = options;

  const provider = embedFn
    ? { id: embeddingProviderId ?? 'injected', embedDocuments: embedFn }
    : getEmbeddingProvider();
  const embed = provider.embedDocuments;
  const providerId = embeddingProviderId ?? provider.id;

  const startedAt = Date.now();
  const stats: IngestRunStats = {
    pagesSeen: 0,
    pagesChanged: 0,
    chunksWritten: 0,
    embeddingsComputed: 0,
    errors: [],
  };

  await startIngestRun(db, runId, trigger);

  try {
    /*
     * Vectors from two embedding models occupy the same space but mean
     * different things, so an index half-built with each retrieves nonsense
     * without ever erroring. Changing provider therefore forces a re-embed
     * rather than being allowed to mix.
     */
    const storedProvider = await getSetting(db, EMBEDDING_PROVIDER_KEY);
    const providerChanged = storedProvider !== null && storedProvider !== providerId;
    const forceReembed = reembed || providerChanged;

    if (providerChanged) {
      onProgress?.({
        type: 'reembed',
        reason: `embedding provider changed from "${storedProvider}" to "${providerId}"`,
      });
    }
    if (forceReembed) {
      await clearEmbeddings(db);
    }
    await setSetting(db, EMBEDDING_PROVIDER_KEY, providerId);

    for (const source of sources) {
      const refs: PageRef[] = [];
      for await (const ref of client.listPages(source)) refs.push(ref);
      stats.pagesSeen += refs.length;
      onProgress?.({ type: 'listed', source: source.id, pages: refs.length });

      const indexed = await getIndexedRevisions(db, source.id);
      const liveRevisions = full
        ? new Map<number, number>()
        : await client.fetchRevisions(source, refs.map((r) => r.pageId));

      let changed = refs.filter((ref) => {
        if (full) return true;
        const stored = indexed.get(ref.pageId);
        if (!stored) return true;
        const live = liveRevisions.get(ref.pageId);
        return live === undefined || live !== stored.revid;
      });
      if (limit !== undefined) changed = changed.slice(0, limit);

      onProgress?.({ type: 'planned', source: source.id, changed: changed.length });

      const gate = pLimit(concurrency);
      let done = 0;

      await Promise.all(
        changed.map((ref) =>
          gate(async () => {
            try {
              const written = await ingestOnePage(db, client, source, ref, embed, stats, forceReembed);
              done += 1;
              onProgress?.({
                type: 'page',
                source: source.id,
                title: ref.title,
                index: done,
                total: changed.length,
                chunks: written,
              });
            } catch (error) {
              // One bad page must not abort a run over thousands of pages.
              const message = error instanceof Error ? error.message : String(error);
              stats.errors.push({ title: ref.title, message });
              onProgress?.({ type: 'error', title: ref.title, message });
            }
          }),
        ),
      );

      stats.pagesChanged += changed.length;

      // Only prune when the listing was complete; a truncated run would delete
      // every page it did not get to.
      if (limit === undefined) {
        await deleteMissingPages(db, source.id, refs.map((r) => r.pageId));
      }
    }

    await dedupeAcrossSources(db);

    const durationMs = Date.now() - startedAt;
    await finishIngestRun(db, runId, 'ok', stats, durationMs);
    onProgress?.({ type: 'done', stats });
    return { ...stats, runId, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    stats.errors.push({ title: '(run)', message });
    await finishIngestRun(db, runId, 'failed', stats, durationMs);
    throw error;
  }
}

async function ingestOnePage(
  db: Db,
  client: MediaWikiClient,
  source: WikiSource,
  ref: PageRef,
  embedFn: (texts: string[]) => Promise<number[][]>,
  stats: IngestRunStats,
  forceReembed: boolean,
): Promise<number> {
  const page = await client.fetchPage(source, ref);
  if (!page) return 0;

  const pageKey = `${page.source}:${page.pageId}`;
  const parsed = {
    page,
    infobox: extractInfobox(page.html),
    sections: await extractSections(page.html),
  };
  const pageChunks = chunkPage(parsed, { sourceRank: source.rank });

  /*
   * The reading document is built from the same fetch as the chunks. Doing it
   * here rather than in a second pass means one HTTP request per page and one
   * place where "what this page contains" is decided.
   */
  const article = await extractArticle(page.html);

  const reusable = forceReembed ? new Map<string, string>() : await getExistingEmbeddings(db, pageKey);
  const needsEmbedding: WikiChunk[] = [];
  const vectors = new Map<string, string>();

  for (const chunk of pageChunks) {
    const existing = reusable.get(chunk.contentHash);
    if (existing) vectors.set(chunk.id, existing);
    else needsEmbedding.push(chunk);
  }

  if (needsEmbedding.length > 0) {
    const embeddings = await embedFn(needsEmbedding.map((c) => c.content));
    needsEmbedding.forEach((chunk, i) => {
      const vector = embeddings[i];
      if (vector) vectors.set(chunk.id, toVectorLiteral(vector));
    });
    stats.embeddingsComputed += needsEmbedding.length;
  }

  await upsertPage(db, {
    key: pageKey,
    source: page.source,
    pageId: page.pageId,
    title: page.title,
    url: page.url,
    revid: page.revid,
    categories: page.categories,
  });

  await replacePageChunks(
    db,
    pageKey,
    pageChunks.map((c) => ({ ...c, embedding: vectors.get(c.id) ?? null })),
  );

  await upsertArticle(db, {
    pageKey,
    source: page.source,
    title: page.title,
    slug: slugify(page.title),
    url: page.url,
    categories: page.categories,
    doc: article,
  });

  stats.chunksWritten += pageChunks.length;
  return pageChunks.length;
}
