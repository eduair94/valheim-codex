import pLimit from 'p-limit';
import type { Db } from '@/lib/db/create-db';
import {
  clearEmbeddings,
  deleteMissingPages,
  dedupeAcrossSources,
  EMBEDDING_PROVIDER_KEY,
  finishIngestRun,
  getExistingEmbeddings,
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
import { extractSections } from '@/lib/wiki/html';
import { extractInfobox } from '@/lib/wiki/infobox';
import type { MediaWikiClient } from '@/lib/wiki/mediawiki';
import { SOURCES } from '@/lib/wiki/sources';
import type { PageRef, WikiChunk, WikiSource } from '@/lib/wiki/types';
import { getEmbeddingProvider, toVectorLiteral } from '@/lib/rag/embed';
import {
  countMissingVectors,
  embedMissingVectors,
  getIndexedPages,
  NO_ARTICLE,
  UNFINISHED,
  writeArticle,
  type IndexedPage,
} from './store';
import { PARSER_VERSION } from './version';

export type IngestOptions = {
  db: Db;
  client: MediaWikiClient;
  sources?: WikiSource[];
  /** Re-parse every page, ignoring stored revision ids. */
  full?: boolean;
  /** Stop after this many changed pages. For smoke tests. */
  limit?: number;
  /** Concurrent page fetches. MediaWiki asks clients to stay modest. */
  concurrency?: number;
  trigger?: string;
  onProgress?: (event: ProgressEvent) => void;
  /** Injected in tests to avoid calling the embeddings API. */
  embedFn?: (texts: string[]) => Promise<number[][]>;
  /**
   * Discard every stored vector and rebuild them all, with the provider that
   * built the index. Never a way to change provider: see `switchProvider`.
   */
  reembed?: boolean;
  /**
   * Move the index to another embedding provider: every vector is discarded
   * and rebuilt with it. It must name the configured provider, so a switch
   * happens only when both the configuration and the command say so — the
   * app embeds questions with its own configured provider, and an index
   * built with another one answers every question with noise.
   */
  switchProvider?: string;
  /**
   * Also re-derive the pages an older parser built (see version.ts), whatever
   * their revision. Off by default so the owner picks the moment: it fetches
   * every such page once, and each article whose text the new parser changes
   * leaves its translations stale. `full` implies it.
   */
  reparse?: boolean;
  /** Identifier recorded so a later run can detect a provider change. */
  embeddingProviderId?: string;
  /** Injected so runs are reproducible in tests. */
  runId?: string;
  /** Injected in tests to stand for a parser change. Defaults to PARSER_VERSION. */
  parserVersion?: number;
};

/**
 * Why a page is re-derived in this run. `unfinished`: an earlier run stopped
 * partway through rewriting it (see `ingestOnePage`).
 */
export type StaleReason = 'added' | 'revised' | 'unfinished' | 'parser' | 'forced';

export type ProgressEvent =
  | { type: 'listed'; source: string; pages: number }
  | {
      type: 'planned';
      source: string;
      changed: number;
      reasons: Record<StaleReason, number>;
      /** Pages an older parser built that this run leaves as they are (no `reparse`). */
      outdated: number;
    }
  | { type: 'page'; source: string; title: string; index: number; total: number; chunks: number }
  | { type: 'error'; title: string; message: string }
  | { type: 'reembed'; reason: string }
  | { type: 'vectors'; embedded: number; total: number }
  | { type: 'done'; stats: IngestRunStats };

export type IngestResult = IngestRunStats & {
  runId: string;
  durationMs: number;
  /** Articles whose title, lead, body, infobox or captions changed: their translations are now stale. */
  articlesChanged: number;
  parserVersion: number;
  /** Pages still as an older parser built them; `reparse` rebuilds them. */
  outdatedPages: number;
};

/**
 * A run refused because of how it was configured. It stops before writing
 * anything, and its message says what to change, so the command line prints
 * it as advice rather than as a crash.
 */
export class IngestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestConfigError';
  }
}

/**
 * The configured embedding provider is not the one that built the index.
 *
 * Vectors from two models occupy the same space but mean different things, so
 * an index half-built with each retrieves nonsense without ever erroring. This
 * used to be handled by quietly dropping every vector and re-embedding — which
 * is how a scheduled run with a forgotten `EMBEDDING_PROVIDER` would have
 * wiped the production index. A mismatch is a configuration error, so the run
 * stops before writing anything, unless the switch is asked for by name.
 *
 * `--reembed` is not that request. It used to be, and since
 * `EMBEDDING_PROVIDER` defaults to gemini, a routine "recompute the vectors"
 * from a shell without the variable would have moved the production index to
 * Gemini — while the app kept embedding questions with the local model.
 */
export class EmbeddingProviderMismatchError extends IngestConfigError {
  constructor(
    readonly stored: string,
    readonly configured: string,
  ) {
    super(
      `The index was embedded with "${stored}", but this run would embed with "${configured}" ` +
        '(EMBEDDING_PROVIDER, which defaults to gemini), and vectors from different models cannot ' +
        `be mixed. Nothing was changed. To update the index, run with EMBEDDING_PROVIDER=${stored}. ` +
        `To move it to "${configured}", pass --switch-provider=${configured}: every vector is rebuilt ` +
        `with it, and the app must then embed questions with "${configured}" too.`,
    );
    this.name = 'EmbeddingProviderMismatchError';
  }
}

/** What a run does to the stored vectors before it reads the wiki. */
export type VectorPlan = 'keep' | 'rebuild' | 'switch';

/**
 * Decides, before anything is written, whether the stored vectors stay, are
 * rebuilt with the same provider, or are moved to the configured one.
 *
 * A switch to the provider the index already has is nothing to do, rather
 * than a second rebuild: running the same command again after an interrupted
 * switch then finishes it — the vectors still missing are filled in below —
 * instead of starting over (and, on Gemini's free tier, running out of quota
 * at the same point every time).
 */
export function planVectors(
  stored: string | null,
  configured: string,
  { reembed, switchProvider }: { reembed: boolean; switchProvider?: string },
): VectorPlan {
  if (switchProvider !== undefined && switchProvider !== configured) {
    throw new IngestConfigError(
      `Asked to move the index to "${switchProvider}", but this run embeds with "${configured}" ` +
        `(EMBEDDING_PROVIDER). Nothing was changed. Run it with EMBEDDING_PROVIDER=${switchProvider}.`,
    );
  }
  if (stored !== null && stored !== configured) {
    if (switchProvider === configured) return 'switch';
    throw new EmbeddingProviderMismatchError(stored, configured);
  }
  return reembed ? 'rebuild' : 'keep';
}

/**
 * Fetches, parses, chunks and embeds the configured wikis.
 *
 * Incremental by default: MediaWiki reports the current revision id of 50 pages
 * per request, so an ordinary re-index reads a handful of requests and touches
 * only the pages a patch actually changed. With `reparse` it also rebuilds,
 * once, every page an older version of the parser built (see version.ts); a
 * run without it counts them, so a parser fix cannot go unapplied unnoticed.
 * Within a changed page, chunks whose content hash is unchanged keep their
 * existing embedding, so a one-line edit does not pay to re-embed the whole
 * article.
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
    switchProvider,
    reparse = false,
    embedFn,
    embeddingProviderId,
    runId = `run-${Date.now().toString(36)}`,
    parserVersion = PARSER_VERSION,
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
  const counters = { articlesChanged: 0, outdatedPages: 0 };

  await startIngestRun(db, runId, trigger);

  /** Gives every chunk without a vector one, reporting as it goes. */
  const backfill = async (): Promise<void> => {
    const total = await countMissingVectors(db);
    if (total === 0) return;
    const embedded = await embedMissingVectors(db, embed, (done) =>
      onProgress?.({ type: 'vectors', embedded: done, total }),
    );
    stats.embeddingsComputed += embedded;
  };

  try {
    const storedProvider = await getSetting(db, EMBEDDING_PROVIDER_KEY);
    const plan = planVectors(storedProvider, providerId, { reembed, switchProvider });

    if (plan !== 'keep') {
      onProgress?.({
        type: 'reembed',
        reason:
          plan === 'switch'
            ? `moving the index from "${storedProvider}" to "${providerId}"`
            : `requested, with "${providerId}"`,
      });
      /*
       * Cleared before the new provider is recorded. Interrupted between the
       * two, the index is left empty under the old name, and the next run
       * refills it consistently; the other order would leave the old vectors
       * under the new name, to be mixed with new ones.
       */
      await clearEmbeddings(db);
    }
    await setSetting(db, EMBEDDING_PROVIDER_KEY, providerId);

    /*
     * Vectors first, pages second. A vector is rebuilt from the chunk text
     * the database already holds, so this needs the embedding model but not
     * the wiki — and a run that then cannot reach Fandom (listing refused,
     * network down) still leaves every chunk with a vector. Done after the
     * page loop instead, a `--reembed` that failed there left the whole index
     * without vectors, and retrieval by meaning with it, until some later run
     * succeeded. On an ordinary run this fills the holes an earlier failure
     * left, usually none. Changed pages below reuse these vectors by content
     * hash, so nothing is embedded twice.
     */
    await backfill();

    for (const source of sources) {
      const refs: PageRef[] = [];
      for await (const ref of client.listPages(source)) refs.push(ref);
      stats.pagesSeen += refs.length;
      onProgress?.({ type: 'listed', source: source.id, pages: refs.length });

      const indexed = await getIndexedPages(db, source.id);
      const settings: StaleSettings = { full, reparse, parserVersion };
      // Only the pages whose revision decides need it looked up.
      const byRevision = refs.filter((ref) => rederivedRegardless(indexed.get(ref.pageId), settings) === null);
      const liveRevisions =
        byRevision.length === 0
          ? new Map<number, number>()
          : await client.fetchRevisions(source, byRevision.map((r) => r.pageId));

      const why = (ref: PageRef): StaleReason | null =>
        staleness(indexed.get(ref.pageId), liveRevisions.get(ref.pageId), settings);

      let changed = refs.filter((ref) => why(ref) !== null);
      if (limit !== undefined) changed = changed.slice(0, limit);

      const reasons: Record<StaleReason, number> = { added: 0, revised: 0, unfinished: 0, parser: 0, forced: 0 };
      for (const ref of changed) reasons[why(ref)!] += 1;

      // Pages this run leaves as an older parser built them, so the command
      // line can say so every time, rather than the fix silently never landing.
      const rederived = new Set(changed.map((ref) => ref.pageId));
      const outdated = refs.filter((ref) => {
        const stored = indexed.get(ref.pageId);
        return stored !== undefined && stored.parserVersion !== parserVersion && !rederived.has(ref.pageId);
      }).length;
      counters.outdatedPages += outdated;

      onProgress?.({ type: 'planned', source: source.id, changed: changed.length, reasons, outdated });

      const gate = pLimit(concurrency);
      let done = 0;

      await Promise.all(
        changed.map((ref) =>
          gate(async () => {
            try {
              const written = await ingestOnePage(db, client, source, ref, embed, stats, counters, parserVersion);
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

    /*
     * Every chunk leaves with a vector: those of the pages above that the
     * provider answered short for. Before deduplication, which compares
     * vectors.
     */
    await backfill();

    await dedupeAcrossSources(db);

    const missing = await countMissingVectors(db);
    if (missing > 0) {
      throw new Error(`${missing} chunks are still without a vector; the next run will retry them`);
    }

    const durationMs = Date.now() - startedAt;
    await finishIngestRun(db, runId, 'ok', stats, durationMs);
    onProgress?.({ type: 'done', stats });
    return { ...stats, runId, durationMs, parserVersion, ...counters };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    stats.errors.push({ title: '(run)', message });
    await finishIngestRun(db, runId, 'failed', stats, durationMs);
    throw error;
  }
}

export type StaleSettings = { full: boolean; reparse: boolean; parserVersion: number };

/**
 * Why a page is re-derived whatever its live revision, or null when its
 * revision decides.
 */
function rederivedRegardless(
  stored: IndexedPage | undefined,
  { full, reparse, parserVersion }: StaleSettings,
): StaleReason | null {
  if (full) return 'forced';
  // A page with no article was never finished: a run failed between its
  // chunks and its article. Still new, whatever revision a run from before
  // revisions were recorded last stored for it.
  if (!stored || stored.parserVersion === NO_ARTICLE) return 'added';
  // One a run stopped rewriting: its chunks, its article or both may be
  // missing or out of date, and its revision was never recorded.
  if (stored.revid === UNFINISHED) return 'unfinished';
  // Not "older than": a rolled-back parser must rebuild what a newer one wrote.
  if (reparse && stored.parserVersion !== parserVersion) return 'parser';
  return null;
}

/**
 * Whether a page must be re-derived, and why; null when what is stored is
 * already what this run should leave: the current revision, built by this
 * parser — or, without `reparse`, by an older one.
 */
export function staleness(
  stored: IndexedPage | undefined,
  liveRevid: number | undefined,
  settings: StaleSettings,
): StaleReason | null {
  const regardless = rederivedRegardless(stored, settings);
  if (regardless !== null || !stored) return regardless;
  return liveRevid === undefined || liveRevid !== stored.revid ? 'revised' : null;
}

async function ingestOnePage(
  db: Db,
  client: MediaWikiClient,
  source: WikiSource,
  ref: PageRef,
  embedFn: (texts: string[]) => Promise<number[][]>,
  stats: IngestRunStats,
  counters: { articlesChanged: number },
  parserVersion: number,
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

  // Including after `--reembed`: the vectors were rebuilt before any page was read.
  const reusable = await getExistingEmbeddings(db, pageKey);
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

  /*
   * The revision is recorded last, by the statement that writes the article.
   * Until then the row says UNFINISHED: the chunks are replaced by a delete
   * and inserts that no transaction holds together (Neon's HTTP driver has
   * none), and a statement that fails between them — one dropped request in
   * a run of thousands — used to leave the page with no chunks, or with an
   * old article, under its new revision, where no later run would ever look
   * at it again. Now any failure from here on leaves a page the next run
   * rewrites (`unfinished`).
   */
  await upsertPage(db, {
    key: pageKey,
    source: page.source,
    pageId: page.pageId,
    title: page.title,
    url: page.url,
    revid: UNFINISHED,
    categories: page.categories,
  });

  await replacePageChunks(
    db,
    pageKey,
    pageChunks.map((c) => ({ ...c, embedding: vectors.get(c.id) ?? null })),
  );

  const articleChanged = await writeArticle(db, {
    pageKey,
    source: page.source,
    title: page.title,
    slug: slugify(page.title),
    url: page.url,
    categories: page.categories,
    doc: article,
    parserVersion,
    revid: page.revid,
  });
  if (articleChanged) counters.articlesChanged += 1;

  stats.chunksWritten += pageChunks.length;
  return pageChunks.length;
}
