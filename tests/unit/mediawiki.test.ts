import { describe, expect, it, vi } from 'vitest';
import { MediaWikiApiError, MediaWikiClient, type FetchLike } from '@/lib/wiki/mediawiki';
import { getSource } from '@/lib/wiki/sources';

const source = getSource('fandom');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchImpl: FetchLike, overrides = {}) {
  return new MediaWikiClient({
    contact: 'test@example.com',
    fetchImpl,
    retryBaseMs: 1,
    sleep: async () => {},
    ...overrides,
  });
}

describe('MediaWikiClient.listPages', () => {
  it('follows the continue token until the listing is exhausted', async () => {
    const pages: Record<string, unknown> = {
      first: {
        query: { allpages: [{ pageid: 1, title: 'Iron' }] },
        continue: { apcontinue: 'J' },
      },
      J: { query: { allpages: [{ pageid: 2, title: 'Jute' }] } },
    };
    const fetchImpl = vi.fn(async (url: string) => {
      const cont = new URL(url).searchParams.get('apcontinue');
      return jsonResponse(pages[cont ?? 'first']);
    });

    const client = clientWith(fetchImpl as unknown as FetchLike);
    const seen = [];
    for await (const p of client.listPages(source)) seen.push(p);

    expect(seen).toEqual([
      { pageId: 1, title: 'Iron' },
      { pageId: 2, title: 'Jute' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('asks the API to exclude redirects', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ query: { allpages: [] } }),
    );
    const client = clientWith(fetchImpl as unknown as FetchLike);
    for await (const _ of client.listPages(source)) break;
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get('apfilterredir')).toBe('nonredirects');
  });
});

describe('MediaWikiClient.fetchPage', () => {
  it('maps the parse response onto a FetchedPage', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        parse: {
          title: 'Iron Sword',
          pageid: 42,
          revid: 999,
          text: '<div>hi</div>',
          categories: [{ category: 'Swords' }, { category: 'Hidden_thing', hidden: true }],
        },
      }),
    );
    const page = await clientWith(fetchImpl as unknown as FetchLike).fetchPage(source, {
      pageId: 42,
      title: 'Iron Sword',
    });

    expect(page).toMatchObject({
      source: 'fandom',
      pageId: 42,
      revid: 999,
      title: 'Iron Sword',
      html: '<div>hi</div>',
      url: 'https://valheim.fandom.com/wiki/Iron_Sword',
    });
    expect(page!.categories).toEqual(['Swords']);
  });

  it('sends an identifying User-Agent, as the MediaWiki policy requires', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ parse: { title: 'x', pageid: 1, revid: 1, text: '' } }),
    );
    await clientWith(fetchImpl as unknown as FetchLike).fetchPage(source, { pageId: 1, title: 'x' });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)['User-Agent']).toContain('test@example.com');
  });
});

describe('MediaWikiClient retries', () => {
  it('retries on 429 and then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return jsonResponse({}, 429);
      return jsonResponse({ parse: { title: 'ok', pageid: 1, revid: 2, text: '<p/>' } });
    });
    const page = await clientWith(fetchImpl as unknown as FetchLike).fetchPage(source, { pageId: 1, title: 'ok' });
    expect(page?.revid).toBe(2);
    expect(calls).toBe(3);
  });

  it('retries on 5xx and gives up after maxRetries', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const client = clientWith(fetchImpl as unknown as FetchLike, { maxRetries: 3 });
    await expect(client.fetchPage(source, { pageId: 1, title: 'x' })).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry an API-level error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 'missingtitle', info: 'gone' } }));
    const client = clientWith(fetchImpl as unknown as FetchLike);
    await expect(client.fetchPage(source, { pageId: 1, title: 'x' })).rejects.toBeInstanceOf(MediaWikiApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('MediaWikiClient.fetchRevisions', () => {
  it('batches page ids 50 at a time', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const ids = new URL(url).searchParams.get('pageids')!.split('|').map(Number);
      return jsonResponse({
        query: { pages: ids.map((id) => ({ pageid: id, revisions: [{ revid: id * 10 }] })) },
      });
    });
    const client = clientWith(fetchImpl as unknown as FetchLike);
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    const revs = await client.fetchRevisions(source, ids);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(revs.size).toBe(120);
    expect(revs.get(7)).toBe(70);
  });
});

describe('MediaWikiClient timeouts', () => {
  it('aborts a request that never resolves rather than hanging the run', async () => {
    // `fetch` has no default timeout: without an abort signal this call would
    // stall the ingest indefinitely, which is exactly what happened in
    // development.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'TimeoutError')),
          );
        }),
    );

    const client = clientWith(fetchImpl as unknown as FetchLike, {
      timeoutMs: 30,
      maxRetries: 2,
    });

    await expect(client.fetchPage(source, { pageId: 1, title: 'x' })).rejects.toThrow(/abort/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('passes an abort signal on every request', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ parse: { title: 'x', pageid: 1, revid: 1, text: '' } }),
    );
    await clientWith(fetchImpl as unknown as FetchLike).fetchPage(source, { pageId: 1, title: 'x' });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
