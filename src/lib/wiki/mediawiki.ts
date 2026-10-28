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

/** Where a redirect leads: a page, and the section of it the redirect names, if any. */
export type RedirectTarget = { title: string; fragment: string | null };

/** One hop as `action=query&redirects=1` lists it. */
type RedirectHop = { from: string; to: string; tofragment?: string; tointerwiki?: string };

/** Characters MediaWiki allows in no title. A `|` would also split one title into two in a request. */
const NOT_IN_A_TITLE = /[#<>[\]|{}]/;

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
    const maintenance = new Set((source.maintenanceCategories ?? []).map((c) => c.toLowerCase()));
    return {
      source: source.id,
      pageId: body.parse.pageid,
      title: body.parse.title,
      url: articleUrl(source, body.parse.title),
      revid: body.parse.revid,
      categories: (body.parse.categories ?? [])
        .filter((c) => !c.hidden)
        .map((c) => c.category.replace(/_/g, ' '))
        .filter((c) => !maintenance.has(c.toLowerCase())),
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

  /**
   * Where each of these titles leads, for those that are redirects, asking
   * about 50 titles per request.
   *
   * Recipes link a material by whatever title its editor typed, and four in
   * ten of those links are redirects. For a thing with no page of its own the
   * redirect is the only record of where it is described: "Mead base: Poison
   * resistance" is the "Mead base" tab of Poison Resistance Mead. The titles
   * recipes link to, some five hundred, take about ten requests, where
   * listing every redirect on the wiki with its target takes over thirty.
   *
   * Each answer is filed under the title as it was asked and as the wiki
   * spells it, since MediaWiki capitalizes a title's first letter and reads
   * underscores as spaces before it looks the title up. A title that is not a
   * redirect is absent, and so is one whose redirects go round in a loop or
   * on to another wiki. Titles are passed without their fragment; one holding
   * a character no title can (`#`, `|`, brackets) is not asked about.
   */
  async fetchRedirects(source: WikiSource, titles: string[]): Promise<Map<string, RedirectTarget>> {
    const asked = [...new Set(titles)].filter((title) => title.trim() !== '' && !NOT_IN_A_TITLE.test(title));
    const out = new Map<string, RedirectTarget>();
    for (let i = 0; i < asked.length; i += 50) {
      const batch = asked.slice(i, i + 50);
      const body = await this.request<{
        query?: { normalized?: { from: string; to: string }[]; redirects?: RedirectHop[] };
      }>(source, {
        action: 'query',
        titles: batch.join('|'),
        redirects: 1,
      });

      const spelled = new Map((body.query?.normalized ?? []).map((n) => [n.from, n.to]));
      const hops = new Map((body.query?.redirects ?? []).map((hop) => [hop.from, hop]));
      for (const title of batch) {
        const wikiTitle = spelled.get(title) ?? title;
        const target = followRedirects(hops, wikiTitle);
        if (!target) continue;
        out.set(title, target);
        out.set(wikiTitle, target);
      }
    }
    return out;
  }
}

/**
 * Follows a title through the redirects one response listed, to the page at
 * the end: the API resolves a redirect to a redirect, a slip the wiki's
 * editors fix sooner or later, and lists every hop. A section named by an
 * earlier hop carries over a later hop that names none, as a browser keeps a
 * URL's fragment across HTTP redirects. Null when the title is no redirect,
 * or its redirects loop or lead off the wiki, where no page here is the end.
 */
function followRedirects(hops: ReadonlyMap<string, RedirectHop>, title: string): RedirectTarget | null {
  let hop = hops.get(title);
  if (!hop) return null;
  const seen = new Set([title]);
  let fragment: string | null = null;
  for (;;) {
    if (hop.tointerwiki) return null;
    fragment = hop.tofragment || fragment;
    const next = hops.get(hop.to);
    if (!next) return { title: hop.to, fragment };
    if (seen.has(hop.to)) return null;
    seen.add(hop.to);
    hop = next;
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
