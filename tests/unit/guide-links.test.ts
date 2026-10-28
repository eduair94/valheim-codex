import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ARTICLE_FOR,
  FANDOM_SEARCH,
  LINKS_WAIT_MS,
  NO_GUIDE_LINKS,
  buildGuideLinks,
  itemTarget,
  loadGuideLinks,
} from '@/components/wiki/guide/guide-links';
import type { LinkTarget } from '@/lib/wiki/links';
import { slugify } from '@/lib/wiki/slug';

/**
 * Where a guide chip leads. A chip that opens the wrong article is worse than
 * one that opens a search, so the aliases and the fallbacks matter more than
 * the happy path.
 */

const INDEX: LinkTarget[] = [
  { match: 'Wood', slug: 'wood', title: 'Wood' },
  { match: 'Burial Chambers', slug: 'burial-chambers', title: 'Burial Chambers' },
  { match: "Hildir's Chests", slug: 'hildir-s-chests', title: "Hildir's Chests" },
  { match: 'Root', slug: 'root', title: 'Root' },
  { match: 'Root (item)', slug: 'root-item', title: 'Root (item)' },
  { match: 'Portal stone', slug: 'portal-stone', title: 'Portal stone' },
  { match: 'Portal Stone', slug: 'portal-stone-duplicate', title: 'Portal Stone' },
  { match: 'Nidhögg', slug: 'nidhogg', title: 'Nidhögg' },
  { match: 'Trophies', slug: 'trophies', title: 'Trophies' },
];

const links = buildGuideLinks(INDEX);

/** The English titles of the corpus (1,027 articles, taken from the indexed wiki on 2026-10-26). */
let corpus: string[] = [];

beforeAll(async () => {
  corpus = JSON.parse(await readFile('tests/fixtures/guide/corpus-titles.json', 'utf8')) as string[];
});

describe('buildGuideLinks', () => {
  it('keys names case- and spacing-insensitively', () => {
    expect(links.get('wood')).toBe('wood');
    expect(links.get('burial chambers')).toBe('burial-chambers');
  });

  it('keeps the first spelling when two titles normalise the same', () => {
    expect(links.get('portal stone')).toBe('portal-stone');
  });
});

describe('itemTarget', () => {
  it('links a name with an article to the article, in the app', () => {
    expect(itemTarget('Wood', links)).toEqual({ href: '/wiki/a/wood', internal: true });
    expect(itemTarget('Portal Stone', links)).toEqual({ href: '/wiki/a/portal-stone', internal: true });
    expect(itemTarget('Nidhögg', links)).toEqual({ href: '/wiki/a/nidhogg', internal: true });
  });

  it('follows the alias when the article is titled differently', () => {
    expect(ARTICLE_FOR['Burial Chamber']).toBe('Burial Chambers');
    expect(itemTarget('Burial Chamber', links)).toEqual({ href: '/wiki/a/burial-chambers', internal: true });
    expect(itemTarget("Hildir's Brass Chest", links).href).toBe('/wiki/a/hildir-s-chests');
  });

  it('prefers the article the sentence names over the name itself', () => {
    // "Root" alone is a disambiguation page; the guide means the item.
    expect(itemTarget('Root', links, 'Root (item)').href).toBe('/wiki/a/root-item');
    expect(itemTarget('Root', links).href).toBe('/wiki/a/root');
  });

  it('falls back to the name before it falls back to the other site', () => {
    const plain = buildGuideLinks([{ match: 'Burial Chamber', slug: 'burial-chamber', title: 'Burial Chamber' }]);
    expect(itemTarget('Burial Chamber', plain).href).toBe('/wiki/a/burial-chamber');
  });

  it('sends a trophy with no page of its own to the list of trophies, and one with a page to that page', () => {
    expect(itemTarget('Deer Trophy', links)).toEqual({ href: '/wiki/a/trophies', internal: true });
    expect(itemTarget("Queen's Trophy", links).href).toBe('/wiki/a/trophies');
    const own = buildGuideLinks([...INDEX, { match: 'Deer Trophy', slug: 'deer-trophy', title: 'Deer Trophy' }]);
    expect(itemTarget('Deer Trophy', own).href).toBe('/wiki/a/deer-trophy');
  });

  it('sends a name with no article to the original wiki’s search, encoded', () => {
    expect(itemTarget('Vegvisir', links)).toEqual({
      href: `${FANDOM_SEARCH}Vegvisir`,
      internal: false,
    });
    expect(itemTarget("Queen's Trophy", NO_GUIDE_LINKS).href).toBe(`${FANDOM_SEARCH}Queen's%20Trophy`);
  });

  it('never links outward when the database could not be read', () => {
    expect(itemTarget('Wood', NO_GUIDE_LINKS).internal).toBe(false);
  });

  it('only aliases names to titles that are spelled like article titles', () => {
    // A typo in the table would silently send every mention to the search.
    for (const [name, title] of Object.entries(ARTICLE_FOR)) {
      expect(title.trim(), name).toBe(title);
      expect(title, name).not.toBe(name);
    }
  });

  it('only aliases names to articles the corpus has', () => {
    const titles = new Set(corpus);
    expect(titles.size).toBeGreaterThan(1000);
    for (const [name, title] of Object.entries(ARTICLE_FOR)) expect(titles.has(title), `${name} → ${title}`).toBe(true);
    expect(titles.has('Trophies')).toBe(true);
  });

  it('resolves the names the review found sent to the other site, against the real titles', () => {
    const real = buildGuideLinks(corpus.map((title) => ({ match: title, slug: slugify(title), title })));
    expect(itemTarget('Fine Wood', real).href).toBe('/wiki/a/finewood');
    expect(itemTarget('Curious Axe Head', real).href).toBe('/wiki/a/early-axes');
    expect(itemTarget('Mysterious Axe Head', real).href).toBe('/wiki/a/early-axes');
    expect(itemTarget('Seeker Soldier Trophy', real).href).toBe('/wiki/a/trophies');
  });
});

describe('loadGuideLinks', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('builds the table from the index', async () => {
    const table = await loadGuideLinks(async () => INDEX);
    expect(table.get('wood')).toBe('wood');
  });

  it('renders without links, and says why once, when the index cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const table = await loadGuideLinks(async () => {
      throw new Error('connection refused');
    });
    expect(table).toBe(NO_GUIDE_LINKS);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[1])).toContain('link-index');
  });

  it('does not wait on a slow index, and lets it finish in the background', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let finish: (index: LinkTarget[]) => void = () => undefined;
    const loading = new Promise<LinkTarget[]>((resolve) => {
      finish = resolve;
    });
    const load = vi.fn(() => loading);

    const pending = loadGuideLinks(load);
    await vi.advanceTimersByTimeAsync(LINKS_WAIT_MS);
    await expect(pending).resolves.toBe(NO_GUIDE_LINKS);
    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // Finishing late is not an error: the data cache it fills serves the next reader.
    finish(INDEX);
    await vi.runAllTimersAsync();
  });

  it('swallows a late failure instead of leaving it unhandled', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail: (reason: Error) => void = () => undefined;
    const loading = new Promise<LinkTarget[]>((_, reject) => {
      fail = reject;
    });

    const pending = loadGuideLinks(() => loading, 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe(NO_GUIDE_LINKS);
    fail(new Error('timed out'));
    await vi.runAllTimersAsync();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
