import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare, SHARE_PARAM } from '@/lib/craft/share';
import {
  ALL_CATEGORIES,
  articleHref,
  articleLevelHref,
  browseHref,
  categoryFromParam,
  categoryHref,
  chatAboutHref,
  citationHref,
  craftHref,
  facetQuery,
  isPlausibleName,
  parseCategoryQuery,
  resolveCategorySegment,
} from '@/lib/routes';

describe('articleHref', () => {
  it('builds a real path, not a template with the segment left in', () => {
    // The bug this guards against: an object href renders as
    // `/wiki/a/[slug]?slug=iron-sword`, which 404s on every link in the app.
    expect(articleHref('iron-sword')).toBe('/wiki/a/iron-sword');
    expect(articleHref('iron-sword')).not.toContain('[slug]');
  });

  it('encodes a segment that would otherwise change the path', () => {
    expect(articleHref('a/b')).toBe('/wiki/a/a%2Fb');
    expect(articleHref('a?b')).toBe('/wiki/a/a%3Fb');
  });
});

describe('categoryHref', () => {
  it('builds the plain path with no query', () => {
    expect(categoryHref('Weapons')).toBe('/wiki/c/Weapons');
  });

  it('encodes a category with a space', () => {
    expect(categoryHref('Points of interest')).toBe('/wiki/c/Points%20of%20interest');
  });

  it('appends only the params that have a value', () => {
    expect(categoryHref('Weapons', { view: 'compare', tab: undefined })).toBe(
      '/wiki/c/Weapons?view=compare',
    );
    expect(categoryHref('all', { biome: 'Plains' })).toBe('/wiki/c/all?biome=Plains');
  });

  it('drops a param cleared to undefined, so a toggle can turn one off', () => {
    expect(categoryHref('Weapons', { view: undefined, tab: '2' })).toBe('/wiki/c/Weapons?tab=2');
  });

  it('encodes query values', () => {
    expect(categoryHref('all', { station: 'Black forge' })).toContain('station=Black+forge');
  });

  it('writes the params in one order, whatever order they come in', () => {
    // The page spreads the query it parsed before the change a link makes,
    // so the same level read `view=compare&tab=2` before a click and
    // `tab=2&view=compare` after: two addresses, two cache entries.
    const href = '/wiki/c/Weapons?view=compare&tab=2';
    expect(categoryHref('Weapons', { view: 'compare', tab: '2' })).toBe(href);
    expect(categoryHref('Weapons', { tab: '2', view: 'compare' })).toBe(href);
    expect(categoryHref('all', { tab: '2', view: 'compare', type: 'Sword', station: 'Forge', biome: 'Meadows' })).toBe(
      '/wiki/c/all?biome=Meadows&station=Forge&type=Sword&view=compare&tab=2',
    );
  });
});

describe('browseHref', () => {
  it('puts a category in the path and a facet in the query', () => {
    expect(browseHref('category', 'Crafting structures')).toBe('/wiki/c/Crafting%20structures');
    expect(browseHref('biome', 'Black Forest')).toBe('/wiki/c/all?biome=Black+Forest');
    expect(browseHref('station', 'Forge')).toBe(`/wiki/c/${ALL_CATEGORIES}?station=Forge`);
  });
});

/**
 * What Next does with a `/wiki/c/[category]` segment: it decodes the path to
 * match the route, then hands the layout and the page `encodeURIComponent` of
 * the result, and `generateMetadata` the decoded value itself.
 */
function paramsFor(href: string): { page: string; metadata: string } {
  const segment = new URL(href, 'https://example.test').pathname.split('/')[3] ?? '';
  const decoded = decodeURIComponent(segment);
  return { page: encodeURIComponent(decoded), metadata: decoded };
}

describe('categoryFromParam', () => {
  const names = [
    'Weapons',
    'Points of interest',
    'Stacks & Piles',
    "Can't be Teleported",
    'Árboles',
    'Mesa de preparación de comida',
    '100%',
  ];

  it.each(names)('reads %j back from the page param, as metadata gets it', (name) => {
    const { page, metadata } = paramsFor(categoryHref(name, { view: 'compare' }));
    expect(categoryFromParam(page)).toBe(name);
    // Metadata uses its param as it is: it is already the name.
    expect(metadata).toBe(name);
  });

  it('reads a broken link the same way in the page and in its metadata', () => {
    // A link encoded twice, as the toggles of multi-word categories made.
    // Guessing the form from the value used to read the metadata param as
    // the real category while the page said "not found".
    const { page, metadata } = paramsFor('/wiki/c/Points%2520of%2520interest?view=compare');
    expect(categoryFromParam(page)).toBe('Points%20of%20interest');
    expect(metadata).toBe('Points%20of%20interest');
  });

  it.each(names)('builds the same links from the page as the page was reached by (%j)', (name) => {
    // The double-encoding bug: the page passed its still-encoded param to
    // categoryHref, so the List/Compare toggle and the level tabs of every
    // multi-word category pointed at `%2520…` and listed nothing.
    for (const query of [{}, { view: 'compare' }, { view: 'compare', tab: '2' }]) {
      const href = categoryHref(name, query);
      const rebuilt = categoryHref(categoryFromParam(paramsFor(href).page), query);
      expect(rebuilt).toBe(href);
      // An encoded percent sign followed by an escape is an escape encoded twice.
      expect(rebuilt).not.toMatch(/%25[0-9A-F]{2}/);
    }
  });

  it('never throws on a stray percent sign', () => {
    expect(() => categoryFromParam('100%')).not.toThrow();
    expect(categoryFromParam('%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('keeps the all-categories sentinel as it is', () => {
    expect(categoryFromParam(ALL_CATEGORIES)).toBe(ALL_CATEGORIES);
  });
});

describe('resolveCategorySegment', () => {
  const categories = new Set(['Weapons', 'Points of interest', 'Stacks & Piles', "Can't be Teleported", '100%']);

  /** The verdict for an address, as the layout reads it: the page param, decoded once. */
  const verdict = (href: string) => resolveCategorySegment(categoryFromParam(paramsFor(href).page), categories);

  it('passes the facet sentinel, whose query only the page can read', () => {
    expect(verdict('/wiki/c/all?biome=Meadows')).toEqual({ kind: 'all' });
    expect(verdict('/wiki/c/all')).toEqual({ kind: 'all' });
  });

  it.each([...categories])('passes the category %j, from the address every link makes', (name) => {
    expect(verdict(categoryHref(name, { view: 'compare' }))).toEqual({ kind: 'category' });
  });

  it('sends a link encoded twice or more to the category it stands for', () => {
    expect(verdict('/wiki/c/Points%2520of%2520interest?view=compare')).toEqual({
      kind: 'moved',
      name: 'Points of interest',
    });
    // Each click on the broken page wrapped its links once more.
    expect(verdict('/wiki/c/Points%252520of%252520interest')).toEqual({ kind: 'moved', name: 'Points of interest' });
    expect(verdict('/wiki/c/Stacks%2520%2526%2520Piles')).toEqual({ kind: 'moved', name: 'Stacks & Piles' });
    expect(verdict("/wiki/c/Can't%2520be%2520Teleported")).toEqual({ kind: 'moved', name: "Can't be Teleported" });
  });

  it('sends another letter case to the category, when only one matches', () => {
    expect(verdict('/wiki/c/weapons')).toEqual({ kind: 'moved', name: 'Weapons' });
    expect(verdict('/wiki/c/points%2520OF%2520interest')).toEqual({ kind: 'moved', name: 'Points of interest' });
    const twins = new Set(['Mistlands', 'MistLands']);
    expect(resolveCategorySegment('mistlands', twins)).toEqual({ kind: 'unlisted' });
  });

  it('leaves a name it does not have to the database, without decoding it into a crash', () => {
    expect(verdict('/wiki/c/does-not-exist')).toEqual({ kind: 'unlisted' });
    // A stray percent sign is not an escape: it ends the decoding, not the request.
    expect(resolveCategorySegment('100%', categories)).toEqual({ kind: 'category' });
    expect(resolveCategorySegment('50%', categories)).toEqual({ kind: 'unlisted' });
    expect(resolveCategorySegment('%E0%A4%A', categories)).toEqual({ kind: 'unlisted' });
  });

  it('answers a value no name can have without asking anyone', () => {
    expect(resolveCategorySegment('\u0000', categories)).toEqual({ kind: 'missing' });
    expect(resolveCategorySegment('x'.repeat(121), categories)).toEqual({ kind: 'missing' });
    expect(resolveCategorySegment('', categories)).toEqual({ kind: 'missing' });
  });
});

describe('parseCategoryQuery', () => {
  it('takes the first value of a repeated parameter', () => {
    // `?biome=a&biome=b` arrives as an array, which used to reach the queries whole.
    expect(parseCategoryQuery({ biome: ['Meadows', 'Swamp'] }).query).toEqual({ biome: 'Meadows' });
  });

  it('reads only `compare` as a view', () => {
    expect(parseCategoryQuery({ view: 'compare' }).query).toEqual({ view: 'compare' });
    expect(parseCategoryQuery({ view: 'list' }).query).toEqual({});
    expect(parseCategoryQuery({ view: ['compare', 'list'] }).query).toEqual({ view: 'compare' });
  });

  it('drops empty values and trims the rest', () => {
    expect(parseCategoryQuery({ station: '  Forge ', type: '', tab: undefined }).query).toEqual({
      station: 'Forge',
    });
  });

  it('flags a value no name can have, instead of querying for it', () => {
    expect(parseCategoryQuery({ station: '\u0000' }).invalid).toBe(true);
    expect(parseCategoryQuery({ tab: 'x'.repeat(121) }).invalid).toBe(true);
    expect(parseCategoryQuery({ station: 'Forge', tab: '2' }).invalid).toBe(false);
  });

  it('ignores parameters it does not know', () => {
    expect(parseCategoryQuery({ q: 'sword', utm_source: 'x' })).toEqual({ query: {}, invalid: false });
  });
});

describe('facetQuery', () => {
  it('keeps what decides the listing and drops the view', () => {
    expect(facetQuery({ biome: 'Meadows', view: 'compare', tab: '2' })).toEqual({ biome: 'Meadows' });
  });
});

describe('isPlausibleName', () => {
  it('accepts the names the wiki has and nothing else', () => {
    expect(isPlausibleName('Stacks & Piles')).toBe(true);
    expect(isPlausibleName('')).toBe(false);
    expect(isPlausibleName('a\tb')).toBe(false);
  });
});

describe('chatAboutHref', () => {
  it('carries the article title into the chat', () => {
    expect(chatAboutHref('Iron Sword')).toBe('/?about=Iron%20Sword');
  });
});

describe('craftHref', () => {
  const list = [
    { id: 'SwordIron', level: 4, from: 0, qty: 1 },
    { id: 'BronzeNails', level: 1, from: 0, qty: 20 },
  ];

  it('leads to the planner, alone or carrying a shared list', () => {
    expect(craftHref()).toBe('/wiki/craft');
    expect(craftHref('')).toBe('/wiki/craft');
    expect(craftHref(encodeShare(list))).toBe('/wiki/craft?l=SwordIron.4.0.1~BronzeNails.1.0.20');
    expect(craftHref(encodeShare(list)).startsWith('/wiki/craft?l=')).toBe(true);
  });

  it('puts the list in the param the planner reads, as the planner reads it', () => {
    // The param share.ts names, decoded once by the URL as a page gets it.
    const list2 = [...list, { id: 'page:wood-structures#wood-wall', level: 1, from: 0, qty: 30 }];
    const param = new URL(craftHref(encodeShare(list2)), 'https://codex.example').searchParams.get(SHARE_PARAM);
    expect(decodeShare(param)).toEqual(list2);
  });
});

describe('articleLevelHref', () => {
  it('opens an article on one upgrade level', () => {
    expect(articleLevelHref('iron-sword', 4)).toBe('/wiki/a/iron-sword#level-4');
    expect(articleLevelHref('iron-sword', 2)).toBe('/wiki/a/iron-sword#level-2');
  });

  it('adds no fragment for the first level, where the article opens anyway', () => {
    expect(articleLevelHref('iron-sword', 1)).toBe('/wiki/a/iron-sword');
  });

  it('encodes the slug as articleHref does, and adds no fragment for a level that is not one', () => {
    expect(articleLevelHref('a/b', 3)).toBe('/wiki/a/a%2Fb#level-3');
    for (const level of [0, -2, 2.5, Number.NaN]) expect(articleLevelHref('iron-sword', level)).toBe('/wiki/a/iron-sword');
  });
});

describe('citationHref', () => {
  const wikiUrl = 'https://valheim.fandom.com/wiki/Iron_Sword';

  it('points at the in-app article when the page has one', () => {
    const link = citationHref({ slug: 'iron-sword', url: wikiUrl });
    expect(link).toEqual({ href: '/wiki/a/iron-sword', internal: true });
  });

  it('falls back to the source wiki when there is no article', () => {
    // A citation must never be a dead end, even mid-ingest.
    expect(citationHref({ slug: null, url: wikiUrl })).toEqual({ href: wikiUrl, internal: false });
    expect(citationHref({ url: wikiUrl })).toEqual({ href: wikiUrl, internal: false });
  });

  it('treats an empty slug as absent rather than linking to /wiki/a/', () => {
    expect(citationHref({ slug: '', url: wikiUrl }).internal).toBe(false);
  });
});
