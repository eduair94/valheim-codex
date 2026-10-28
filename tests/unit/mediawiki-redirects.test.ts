import { describe, expect, it, vi } from 'vitest';
import { MediaWikiClient, type FetchLike } from '@/lib/wiki/mediawiki';
import { getSource } from '@/lib/wiki/sources';

/**
 * Where the wiki's redirects point. Recipes link materials by whatever title
 * the editor typed, and four in ten of those links are redirects: a mead base
 * lives in a tab of its mead's page, a trophy in a section of the Trophies
 * page. The recipe graph resolves them through this map.
 */

const source = getSource('fandom');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchImpl: FetchLike) {
  return new MediaWikiClient({ contact: 'test@example.com', fetchImpl, retryBaseMs: 1, sleep: async () => {} });
}

/** The titles one request asked about. */
function titlesOf(url: string): string[] {
  return new URL(url).searchParams.get('titles')!.split('|');
}

describe('MediaWikiClient.fetchRedirects', () => {
  it('maps a redirect to its target page and the section it points at', async () => {
    // The shape `action=query&redirects=1` answers with, formatversion 2.
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        batchcomplete: true,
        query: {
          redirects: [{ from: 'Mead base: Poison resistance', to: 'Poison Resistance Mead', tofragment: 'Mead base' }],
          pages: [{ pageid: 2087, ns: 0, title: 'Poison Resistance Mead' }],
        },
      }),
    );

    const redirects = await clientWith(fetchImpl).fetchRedirects(source, ['Mead base: Poison resistance']);

    expect(Object.fromEntries(redirects)).toEqual({
      'Mead base: Poison resistance': { title: 'Poison Resistance Mead', fragment: 'Mead base' },
    });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get('action')).toBe('query');
    expect(url.searchParams.get('redirects')).toBe('1');
    expect(url.searchParams.get('titles')).toBe('Mead base: Poison resistance');
    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['User-Agent']).toContain('test@example.com');
  });

  it('gives a redirect without a section a null fragment, and leaves out titles that are not redirects', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        query: {
          redirects: [
            { from: 'Feather', to: 'Feathers' },
            { from: 'Linen', to: 'Linen Thread', tofragment: '' },
          ],
          pages: [
            { pageid: 1, ns: 0, title: 'Feathers' },
            { pageid: 2, ns: 0, title: 'Linen Thread' },
            { pageid: 3, ns: 0, title: 'Bronze' },
            { ns: 0, title: 'Dyrnwyn hilt fragment', missing: true },
          ],
        },
      }),
    );

    const redirects = await clientWith(fetchImpl as unknown as FetchLike).fetchRedirects(source, [
      'Feather',
      'Linen',
      'Bronze',
      'Dyrnwyn hilt fragment',
    ]);

    expect(Object.fromEntries(redirects)).toEqual({
      Feather: { title: 'Feathers', fragment: null },
      Linen: { title: 'Linen Thread', fragment: null },
    });
  });

  it('asks about 50 titles at a time: 120 titles are 3 requests', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      jsonResponse({ query: { redirects: titlesOf(url).map((title) => ({ from: title, to: `${title} (target)` })) } }),
    );
    const titles = Array.from({ length: 120 }, (_, i) => `Title ${i + 1}`);

    const redirects = await clientWith(fetchImpl as unknown as FetchLike).fetchRedirects(source, titles);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([url]) => titlesOf(url).length)).toEqual([50, 50, 20]);
    expect(redirects.size).toBe(120);
    expect(redirects.get('Title 77')).toEqual({ title: 'Title 77 (target)', fragment: null });
  });

  it('asks about each title once, and makes no request for none', async () => {
    const fetchImpl = vi.fn(async (url: string) => jsonResponse({ query: { pages: titlesOf(url).map((title) => ({ title })) } }));
    const client = clientWith(fetchImpl as unknown as FetchLike);

    expect((await client.fetchRedirects(source, [])).size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    await client.fetchRedirects(source, ['Bronze', 'Tin', 'Bronze']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(titlesOf(String(fetchImpl.mock.calls[0]?.[0]))).toEqual(['Bronze', 'Tin']);
  });

  it('never sends what cannot be a title', async () => {
    // A `|` would split one title into two in the request, and a `#` would be
    // read as a section of another page: MediaWiki allows neither in a title.
    const fetchImpl = vi.fn(async (url: string) => jsonResponse({ query: { pages: titlesOf(url).map((title) => ({ title })) } }));

    await clientWith(fetchImpl as unknown as FetchLike).fetchRedirects(source, [
      'Bronze',
      'Pot shard x3|x4',
      'Deer Meat#Cooked',
      '  ',
      '[[Wood]]',
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(titlesOf(String(fetchImpl.mock.calls[0]?.[0]))).toEqual(['Bronze']);
  });

  it('answers under the spelling it was asked with as well as the wiki’s own', async () => {
    // MediaWiki capitalizes a title's first letter and reads underscores as
    // spaces before it looks the title up, and names the redirect by its own
    // spelling of the title, not by the caller's.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        query: {
          normalized: [{ fromencoded: false, from: 'deer_trophy', to: 'Deer trophy' }],
          redirects: [{ from: 'Deer trophy', to: 'Trophies', tofragment: 'Meadows' }],
          pages: [{ pageid: 9, ns: 0, title: 'Trophies' }],
        },
      }),
    );

    const redirects = await clientWith(fetchImpl as unknown as FetchLike).fetchRedirects(source, ['deer_trophy']);

    expect(Object.fromEntries(redirects)).toEqual({
      deer_trophy: { title: 'Trophies', fragment: 'Meadows' },
      'Deer trophy': { title: 'Trophies', fragment: 'Meadows' },
    });
  });

  it('follows a redirect to a redirect to the page at its end, and gives up on a loop', async () => {
    // A double redirect is a slip the wiki's editors fix sooner or later; the
    // API resolves it anyway and lists every hop. A section named by an
    // earlier hop carries over a later hop that names none, as a browser keeps
    // the fragment across HTTP redirects. A loop leads to no page at all.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        query: {
          redirects: [
            { from: 'Cooked deer', to: 'Cooked deer meat' },
            { from: 'Cooked deer meat', to: 'Deer Meat', tofragment: 'Cooked' },
            { from: 'Raw venison', to: 'Venison', tofragment: 'Raw' },
            { from: 'Venison', to: 'Deer Meat' },
            { from: 'Loop A', to: 'Loop B' },
            { from: 'Loop B', to: 'Loop A' },
            { from: 'Itself', to: 'Itself' },
          ],
          pages: [{ pageid: 5, ns: 0, title: 'Deer Meat' }],
        },
      }),
    );

    const redirects = await clientWith(fetchImpl as unknown as FetchLike).fetchRedirects(source, [
      'Cooked deer',
      'Raw venison',
      'Loop A',
      'Itself',
    ]);

    expect(Object.fromEntries(redirects)).toEqual({
      'Cooked deer': { title: 'Deer Meat', fragment: 'Cooked' },
      'Raw venison': { title: 'Deer Meat', fragment: 'Raw' },
    });
  });

  it('leaves out a redirect to another wiki', async () => {
    // Its target names a page there, which a page here could share a title with.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        query: {
          redirects: [
            { from: 'Valheim on Wikipedia', to: 'Valheim', tointerwiki: 'wikipedia' },
            { from: 'Bronze nails', to: 'Bronze Nails' },
          ],
        },
      }),
    );

    const redirects = await clientWith(fetchImpl as unknown as FetchLike).fetchRedirects(source, [
      'Valheim on Wikipedia',
      'Bronze nails',
    ]);

    expect(Object.fromEntries(redirects)).toEqual({ 'Bronze nails': { title: 'Bronze Nails', fragment: null } });
  });
});
