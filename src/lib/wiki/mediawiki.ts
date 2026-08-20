import type { FetchedPage, PageRef, WikiSource } from './types';
import { articleUrl } from './sources';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type MediaWikiClientOptions = {
  /** Contact address embedded in the User-Agent, as MediaWiki's policy requires. */
  contact: string;
  fetchImpl?: FetchLike;
  /** Attempts per request, including the first. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. */
  retryBaseMs?: number;
  /** Injectable so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request ceiling in ms. `fetch` has no default timeout. */
  timeoutMs?: number;
};

type QueryParams = Record<string, string | number | undefined>;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal MediaWiki Action API client.
 *
 * Only two operations are needed: enumerate article titles, and fetch one
 * article as rendered HTML. Rendered HTML rather than wikitext because the
 * Valheim wiki leans heavily on templates (`{{item link|…}}`, `{{cols|…}}`)
 * that only the server can expand correctly.
 */
export class MediaWikiClient {
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  constructor(options: MediaWikiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 4;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
    this.userAgent = `WikiValheimRAG/0.1 (${options.contact})`;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(source: WikiSource, params: QueryParams): Promise<T> {
    const url = new URL(source.api);
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(this.retryBaseMs * 2 ** (attempt - 1));
      }
      try {
        const response = await this.fetchImpl(url.toString(), {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          // A stalled connection would otherwise hold a concurrency slot for
          // the lifetime of the run.
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        // 429 and 5xx are transient; 4xx other than 429 will not improve.
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`${source.id}: HTTP ${response.status} for ${params['page'] ?? params['list'] ?? 'request'}`);
          continue;
        }
        if (!response.ok) {
          throw new Error(`${source.id}: HTTP ${response.status} for ${url.toString()}`);
        }
        const body = (await response.json()) as T & { error?: { code: string; info: string } };
        if (body.error) {
          throw new MediaWikiApiError(body.error.code, body.error.info);
        }
        return body;
      } catch (error) {
        if (error instanceof MediaWikiApiError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error('MediaWiki request failed');
  }

  /** Yields every non-redirect article title in the source's namespaces. */
  async *listPages(source: WikiSource): AsyncGenerator<PageRef> {
    for (const namespace of source.namespaces) {
      let cont: string | undefined;
      do {
        const body = await this.request<{
          query?: { allpages?: { pageid: number; title: string }[] };
          continue?: { apcontinue?: string };
        }>(source, {
          action: 'query',
          list: 'allpages',
          apnamespace: namespace,
          aplimit: 500,
          apfilterredir: 'nonredirects',
          apcontinue: cont,
        });

        for (const p of body.query?.allpages ?? []) {
          yield { pageId: p.pageid, title: p.title };
        }
        cont = body.continue?.apcontinue;
      } while (cont);
    }
  }

  /** Fetches one article as rendered HTML, with its revision id and categories. */
  async fetchPage(source: WikiSource, ref: PageRef): Promise<FetchedPage | null> {
    const body = await this.request<{
      parse?: {
        title: string;
        pageid: number;
        revid: number;
        text: string;
        categories?: { category: string; hidden?: boolean }[];
      };
    }>(source, {
      action: 'parse',
      pageid: ref.pageId,
      prop: 'text|revid|categories',
    });

    if (!body.parse) return null;
    return {
      source: source.id,
      pageId: body.parse.pageid,
      title: body.parse.title,
      url: articleUrl(source, body.parse.title),
      revid: body.parse.revid,
      categories: (body.parse.categories ?? [])
        .filter((c) => !c.hidden)
        .map((c) => c.category.replace(/_/g, ' ')),
      html: body.parse.text,
    };
  }

  /**
   * Current revision ids for up to 50 pages in one request.
   *
   * This is what makes re-indexing incremental: comparing revids costs one
   * request per 50 articles, versus fetching and re-embedding every page.
   */
  async fetchRevisions(source: WikiSource, pageIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (let i = 0; i < pageIds.length; i += 50) {
      const batch = pageIds.slice(i, i + 50);
      const body = await this.request<{
        query?: { pages?: { pageid: number; revisions?: { revid: number }[] }[] };
      }>(source, {
        action: 'query',
        pageids: batch.join('|'),
        prop: 'revisions',
        rvprop: 'ids',
      });
      for (const p of body.query?.pages ?? []) {
        const revid = p.revisions?.[0]?.revid;
        if (revid !== undefined) out.set(p.pageid, revid);
      }
    }
    return out;
  }
}

/** A well-formed API response that reports an error (e.g. `missingtitle`). */
export class MediaWikiApiError extends Error {
  constructor(
    readonly code: string,
    info: string,
  ) {
    super(`MediaWiki API error ${code}: ${info}`);
    this.name = 'MediaWikiApiError';
  }
}
