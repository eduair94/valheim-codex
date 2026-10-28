import pLimit from 'p-limit';
import { buildRecipeGraph, type BuiltGraph } from '@/lib/craft/build';
import type { Db } from '@/lib/db/create-db';
import { getRecipeStates, isRecipeGraphBehind, writePageRecipes, type RecipeState } from '@/lib/db/recipe-repo';
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
import { extractRecipes } from '@/lib/wiki/recipes';
import { RECIPES_VERSION } from '@/lib/wiki/recipes-version';
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
  /**
   * Stop after fetching this many pages per source, for articles and recipes
   * together. For smoke tests: a page it leaves with no recipes stored keeps
   * the recipe graph from being assembled.
   */
  limit?: number;
  /** Concurrent page fetches, for articles and recipes alike. MediaWiki asks clients to stay modest. */
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
  /**
   * Read recipes and nothing else (`pnpm ingest --recipes`): every listed
   * page whose stored recipes are missing, were read by another extractor, or
   * from another revision than the live one is fetched once for them, and
   * the recipe graph is assembled again, always, so that an edit to the
   * overrides reaches it. Articles, chunks, vectors and translations stay as
   * they are; a page the index does not have yet gets its row, unfinished,
   * for the next ordinary run to derive. With `full`, every listed page's
   * recipes are read again.
   */
  recipesOnly?: boolean;
  /** Injected in tests to stand for an extractor change. Defaults to RECIPES_VERSION. */
  recipesVersion?: number;
};

/**
 * Why a page is re-derived in this run. `unfinished`: an earlier run stopped
 * partway through rewriting it (see `ingestOnePage`).
 */
export type StaleReason = 'added' | 'revised' | 'unfinished' | 'parser' | 'forced';

/**
 * Why a page's recipes are read again apart from its article: never read,
 * read by another extractor (`extractor`), read from an older revision than
 * the live one, or asked for (`forced`, a recipes-only `full`).
 */
export type RecipeStaleReason = 'missing' | 'extractor' | 'revised' | 'forced';

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
  | { type: 'recipes-planned'; source: string; pages: number; reasons: Record<RecipeStaleReason, number> }
  | { type: 'recipes'; source: string; title: string; index: number; total: number }
  | { type: 'graph'; graph: BuiltGraph }
  | { type: 'graph-skipped'; reason: string }
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
  /** Pages whose recipes this run read and stored, with their articles or on their own. */
  recipesExtracted: number;
  /** The recipe graph this run assembled and stored; null when it assembled none. */
  graph: BuiltGraph | null;
};

/** The title a failed assembly of the recipe graph is recorded under, among the run's errors. */
export const RECIPE_GRAPH_ERROR = '(recipe graph)';

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
 *
 * Each page's recipes are read from the same fetch as its article
 * (`extractRecipes`), and a recipes pass after the pages reads them for
 * every other page whose stored recipes are missing or out of date. The run
 * ends by assembling the recipe graph (`buildRecipeGraph`) when it stored
 * recipes or the graph is behind them, once no listed page is without its
 * recipes; a failure there is recorded with the run's errors and fails
 * nothing else. `recipesOnly` does the recipe work alone.
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
    recipesOnly = false,
    recipesVersion = RECIPES_VERSION,
  } = options;

  if (recipesOnly) {
    // Half of what was asked, done without a word, would read as all of it:
    // a recipes-only run leaves articles and vectors as they are.
    const asked = [reparse && '--reparse', reembed && '--reembed', switchProvider !== undefined && '--switch-provider'];
    const refused = asked.filter((flag): flag is string => typeof flag === 'string');
    if (refused.length > 0) {
      throw new IngestConfigError(
        `--recipes reads recipes and leaves articles and vectors as they are, so it does not combine with ` +
          `${refused.join(', ')}. Nothing was changed. Run them separately.`,
      );
    }
  }

  // A recipes-only run embeds nothing, so it asks for no provider: it needs
  // no key, loads no model, and records nothing about the index's vectors.
  const embedding = recipesOnly ? null : embeddingOf(embedFn, embeddingProviderId);

  const startedAt = Date.now();
  const stats: IngestRunStats = {
    pagesSeen: 0,
    pagesChanged: 0,
    chunksWritten: 0,
    embeddingsComputed: 0,
    errors: [],
  };
  const counters = { articlesChanged: 0, outdatedPages: 0, recipesExtracted: 0 };
  let graph: BuiltGraph | null = null;

  await startIngestRun(db, runId, trigger);

  /** Gives every chunk without a vector one, reporting as it goes. */
  const backfill = async (embed: Embedding['embed']): Promise<void> => {
    const total = await countMissingVectors(db);
    if (total === 0) return;
    const embedded = await embedMissingVectors(db, embed, (done) =>
      onProgress?.({ type: 'vectors', embedded: done, total }),
    );
    stats.embeddingsComputed += embedded;
  };

  /** Records what failed without failing the run: one page, or the recipe graph. */
  const failure = (title: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    stats.errors.push({ title, message });
    onProgress?.({ type: 'error', title, message });
  };

  try {
    if (embedding) {
      const storedProvider = await getSetting(db, EMBEDDING_PROVIDER_KEY);
      const plan = planVectors(storedProvider, embedding.providerId, { reembed, switchProvider });

      if (plan !== 'keep') {
        onProgress?.({
          type: 'reembed',
          reason:
            plan === 'switch'
              ? `moving the index from "${storedProvider}" to "${embedding.providerId}"`
              : `requested, with "${embedding.providerId}"`,
        });
        /*
         * Cleared before the new provider is recorded. Interrupted between the
         * two, the index is left empty under the old name, and the next run
         * refills it consistently; the other order would leave the old vectors
         * under the new name, to be mixed with new ones.
         */
        await clearEmbeddings(db);
      }
      await setSetting(db, EMBEDDING_PROVIDER_KEY, embedding.providerId);

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
      await backfill(embedding.embed);
    }

    // Listed pages that still have no recipes stored once a source's passes
    // are done. A graph assembled without them would be part of the wiki.
    const unread: string[] = [];

    for (const source of sources) {
      const refs: PageRef[] = [];
      for await (const ref of client.listPages(source)) refs.push(ref);
      stats.pagesSeen += refs.length;
      onProgress?.({ type: 'listed', source: source.id, pages: refs.length });

      const indexed = await getIndexedPages(db, source.id);
      // What the article pass leaves the recipes pass: the pages it read
      // (their recipes with them), those it failed on, and the live
      // revisions it looked up.
      const articles: ArticlePass = { read: new Set(), failed: new Set(), live: new Map(), fetches: 0 };

      if (embedding) {
        const settings: StaleSettings = { full, reparse, parserVersion };
        // Only the pages whose revision decides need it looked up.
        const byRevision = refs.filter((ref) => rederivedRegardless(indexed.get(ref.pageId), settings) === null);
        if (byRevision.length > 0) articles.live = await client.fetchRevisions(source, byRevision.map((r) => r.pageId));

        const why = (ref: PageRef): StaleReason | null =>
          staleness(indexed.get(ref.pageId), articles.live.get(ref.pageId), settings);

        let changed = refs.filter((ref) => why(ref) !== null);
        if (limit !== undefined) changed = changed.slice(0, limit);
        articles.fetches = changed.length;

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
                const written = await ingestOnePage(db, client, source, ref, embedding.embed, stats, counters, {
                  parserVersion,
                  recipesVersion,
                });
                articles.read.add(ref.pageId);
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
                articles.failed.add(ref.pageId);
                failure(ref.title, error);
              }
            }),
          ),
        );

        stats.pagesChanged += changed.length;
      }

      await readRecipesPass({
        db,
        client,
        source,
        refs,
        indexed,
        articles,
        full,
        // What a limited run has left to fetch, its pages' articles counted.
        budget: limit === undefined ? Infinity : Math.max(0, limit - articles.fetches),
        concurrency,
        recipesVersion,
        onProgress,
        failure,
        counters,
      });

      // Only prune when the listing was complete; a truncated run would delete
      // every page it did not get to. A recipes-only run leaves the pages gone
      // upstream, and their articles, to the next ordinary run.
      if (limit === undefined && !recipesOnly) {
        await deleteMissingPages(db, source.id, refs.map((r) => r.pageId));
      }

      const states = await getRecipeStates(db, source.id);
      unread.push(...refs.filter((ref) => !states.has(ref.pageId)).map((ref) => ref.title));
    }

    /*
     * The recipe graph, once every listed page's recipes are stored, and
     * before the vectors below: it needs nothing they do, and should neither
     * wait the minutes they can take nor fail with them.
     *
     * Assembled when this run stored recipes (even the same ones: a page read
     * again may have a new title or new categories, which the graph takes as
     * well), when the graph is behind what is stored (a page gone, a run that
     * stopped before its graph, a graph that failed), and on every
     * recipes-only run, which is how an edit to the overrides reaches it. A
     * failure is recorded with the run's errors and fails nothing else:
     * readers keep the graph they have, and the next run tries again, since
     * the graph is still behind.
     */
    const due = recipesOnly || counters.recipesExtracted > 0 || (await isRecipeGraphBehind(db));
    const wiki = sources[0];
    if (due && wiki && unread.length > 0) {
      const named = unread.slice(0, 5).join(', ') + (unread.length > 5 ? `, and ${unread.length - 5} more` : '');
      // Another run with a limit reads no more of them than this one did.
      const then = limit === undefined ? 'the next run reads them' : 'a run without a limit reads them';
      onProgress?.({
        type: 'graph-skipped',
        reason: `${unread.length} listed pages have no recipes stored yet (${named}); ${then} and assembles the graph`,
      });
    } else if (due && wiki) {
      try {
        graph = await buildRecipeGraph(db, client, wiki);
        onProgress?.({ type: 'graph', graph });
      } catch (error) {
        failure(RECIPE_GRAPH_ERROR, error);
      }
    }

    if (embedding) {
      /*
       * Every chunk leaves with a vector: those of the pages above that the
       * provider answered short for. Before deduplication, which compares
       * vectors.
       */
      await backfill(embedding.embed);

      await dedupeAcrossSources(db);

      const missing = await countMissingVectors(db);
      if (missing > 0) {
        throw new Error(`${missing} chunks are still without a vector; the next run will retry them`);
      }
    }

    const durationMs = Date.now() - startedAt;
    await finishIngestRun(db, runId, 'ok', stats, durationMs);
    onProgress?.({ type: 'done', stats });
    return { ...stats, runId, durationMs, parserVersion, ...counters, graph };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    stats.errors.push({ title: '(run)', message });
    await finishIngestRun(db, runId, 'failed', stats, durationMs);
    throw error;
  }
}

/** How a run embeds: the provider's function, and the id the index records for it. */
type Embedding = { embed: (texts: string[]) => Promise<number[][]>; providerId: string };

function embeddingOf(embedFn: IngestOptions['embedFn'], embeddingProviderId: string | undefined): Embedding {
  const provider = embedFn ? { id: embeddingProviderId ?? 'injected', embedDocuments: embedFn } : getEmbeddingProvider();
  return { embed: provider.embedDocuments, providerId: embeddingProviderId ?? provider.id };
}

/**
 * What a source's article pass leaves for its recipes pass: the pages whose
 * articles it rewrote, their recipes with them; the pages it failed on, to
 * be tried again by the next run rather than twice by this one; the live
 * revisions it looked up; and how many pages it fetched.
 */
type ArticlePass = { read: Set<number>; failed: Set<number>; live: Map<number, number>; fetches: number };

/**
 * The recipes pass: every listed page the article pass did not read whose
 * stored recipes are missing, were read by another extractor, or from
 * another revision than the live one, fetched once for its recipes alone. No
 * chunk, article or translation changes, and a stored page's row keeps the
 * revision its article was built from, so the next ordinary run still
 * rewrites an article that is behind. A page the index does not have yet is
 * stored unfinished first, as the recipes need its row: the next ordinary
 * run derives its article.
 */
async function readRecipesPass(pass: {
  db: Db;
  client: MediaWikiClient;
  source: WikiSource;
  refs: PageRef[];
  indexed: Map<number, IndexedPage>;
  articles: ArticlePass;
  full: boolean;
  /** Pages it may fetch: a limited run's limit, less what the article pass fetched. */
  budget: number;
  concurrency: number;
  recipesVersion: number;
  onProgress: IngestOptions['onProgress'];
  failure: (title: string, error: unknown) => void;
  counters: { recipesExtracted: number };
}): Promise<void> {
  const { db, client, source, articles, recipesVersion, onProgress } = pass;
  const states = await getRecipeStates(db, source.id);
  const candidates = pass.refs.filter((ref) => !articles.read.has(ref.pageId) && !articles.failed.has(ref.pageId));
  const settings = { recipesVersion, full: pass.full };

  // The live revision decides only for recipes the running extractor read,
  // and is asked for only where the article pass did not look it up.
  const byRevision = (ref: PageRef): boolean => {
    const state = states.get(ref.pageId);
    return !pass.full && state !== undefined && state.recipesVersion === recipesVersion;
  };
  const ask = candidates.filter((ref) => byRevision(ref) && !articles.live.has(ref.pageId));
  const live =
    ask.length === 0
      ? articles.live
      : new Map([...articles.live, ...(await client.fetchRevisions(source, ask.map((ref) => ref.pageId)))]);

  const why = (ref: PageRef): RecipeStaleReason | null => recipeStaleness(states.get(ref.pageId), live.get(ref.pageId), settings);
  const stale = candidates.filter((ref) => why(ref) !== null).slice(0, pass.budget);

  const reasons: Record<RecipeStaleReason, number> = { missing: 0, extractor: 0, revised: 0, forced: 0 };
  for (const ref of stale) reasons[why(ref)!] += 1;
  onProgress?.({ type: 'recipes-planned', source: source.id, pages: stale.length, reasons });

  const gate = pLimit(pass.concurrency);
  let done = 0;
  await Promise.all(
    stale.map((ref) =>
      gate(async () => {
        try {
          const page = await client.fetchPage(source, ref);
          if (!page) return;
          const pageKey = `${page.source}:${page.pageId}`;
          const data = extractRecipes(page.html, { title: page.title });
          if (!pass.indexed.has(ref.pageId)) {
            await upsertPage(db, {
              key: pageKey,
              source: page.source,
              pageId: page.pageId,
              title: page.title,
              url: page.url,
              revid: UNFINISHED,
              categories: page.categories,
            });
          }
          await writePageRecipes(db, { pageKey, recipesVersion, revid: page.revid, data });
          pass.counters.recipesExtracted += 1;
          done += 1;
          onProgress?.({ type: 'recipes', source: source.id, title: ref.title, index: done, total: stale.length });
        } catch (error) {
          pass.failure(ref.title, error);
        }
      }),
    ),
  );
}

/**
 * Whether a page's stored recipes are read again, and why; null when the
 * running extractor read them from the live revision. Not "older than": an
 * extractor rolled back must read again what a newer one wrote, as with the
 * parser. A live revision the wiki did not report is one the stored recipes
 * cannot be shown to match.
 */
export function recipeStaleness(
  state: RecipeState | undefined,
  liveRevid: number | undefined,
  { recipesVersion, full }: { recipesVersion: number; full: boolean },
): RecipeStaleReason | null {
  if (full) return 'forced';
  if (!state) return 'missing';
  if (state.recipesVersion !== recipesVersion) return 'extractor';
  return liveRevid === undefined || liveRevid !== state.revid ? 'revised' : null;
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
  counters: { articlesChanged: number; recipesExtracted: number },
  versions: { parserVersion: number; recipesVersion: number },
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
  // And the recipes, which the reading document lets go of (recipes.ts).
  const recipes = extractRecipes(page.html, { title: page.title });

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

  // Before the article, for the same reason: a run that stops between the
  // two leaves the page unfinished, and the next one reads its recipes again
  // with everything else.
  await writePageRecipes(db, { pageKey, recipesVersion: versions.recipesVersion, revid: page.revid, data: recipes });
  counters.recipesExtracted += 1;

  const articleChanged = await writeArticle(db, {
    pageKey,
    source: page.source,
    title: page.title,
    slug: slugify(page.title),
    url: page.url,
    categories: page.categories,
    doc: article,
    parserVersion: versions.parserVersion,
    revid: page.revid,
  });
  if (articleChanged) counters.articlesChanged += 1;

  stats.chunksWritten += pageChunks.length;
  return pageChunks.length;
}
