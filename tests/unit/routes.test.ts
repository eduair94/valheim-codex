import { describe, expect, it } from 'vitest';
import { articleHref, categoryHref, chatAboutHref, citationHref } from '@/lib/routes';

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
});

describe('chatAboutHref', () => {
  it('carries the article title into the chat', () => {
    expect(chatAboutHref('Iron Sword')).toBe('/?about=Iron%20Sword');
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
