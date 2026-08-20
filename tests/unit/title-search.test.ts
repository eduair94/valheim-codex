import { describe, expect, it } from 'vitest';
import { fold, searchTitles } from '@/lib/wiki/title-search';
import type { TitleIndexEntry } from '@/lib/db/wiki-repo';

const INDEX: TitleIndexEntry[] = [
  { s: 'iron', t: 'Iron', c: ['Materials'], y: 'Metal' },
  { s: 'iron-sword', t: 'Iron Sword', c: ['Weapons', 'Swords'], y: 'Sword' },
  { s: 'iron-pit', t: 'Iron Pit', c: ['Points of interest'] },
  { s: 'black-metal-sword', t: 'Black Metal Sword', c: ['Weapons'], y: 'Sword' },
  { s: 'surtling-core', t: 'Surtling Core', c: ['Materials'] },
  { s: 'nucleo-de-prueba', t: 'Núcleo de prueba', c: ['Materials'] },
  { s: 'deathsquito', t: 'Deathsquito', c: ['Creatures'], y: 'Creature' },
  { s: 'dvergr-race', t: 'Dvergr (race)', c: ['Creatures'] },
];

const titles = (q: string, limit?: number): string[] =>
  searchTitles(INDEX, q, limit).map((m) => m.entry.t);

describe('fold', () => {
  it('drops accents and case', () => {
    expect(fold('Núcleo')).toBe('nucleo');
    expect(fold('DVERGR')).toBe('dvergr');
  });
});

describe('searchTitles', () => {
  it('puts an exact title first', () => {
    expect(titles('iron')[0]).toBe('Iron');
  });

  it('prefers a prefix over a mid-word match', () => {
    const found = titles('sword');
    // "Sword" starts a word in both, but the shorter title wins the tie.
    expect(found[0]).toBe('Iron Sword');
    expect(found).toContain('Black Metal Sword');
  });

  it('matches a word inside the title, not just the start', () => {
    expect(titles('metal')).toContain('Black Metal Sword');
  });

  it('finds accented titles from unaccented typing, as a phone keyboard produces', () => {
    expect(titles('nucleo')).toContain('Núcleo de prueba');
    expect(titles('núcleo')).toContain('Núcleo de prueba');
  });

  it('matches all words of a multi-word query in any order', () => {
    expect(titles('sword iron')).toContain('Iron Sword');
  });

  it('falls back to categories so a category name surfaces its articles', () => {
    const found = titles('weapons');
    expect(found).toContain('Iron Sword');
    expect(found).toContain('Black Metal Sword');
  });

  it('falls back to the type facet', () => {
    expect(titles('creature')).toContain('Deathsquito');
  });

  it('handles the parenthesised titles the wiki uses', () => {
    expect(titles('dvergr')).toContain('Dvergr (race)');
    expect(titles('race')).toContain('Dvergr (race)');
  });

  it('returns nothing for empty input rather than everything', () => {
    expect(searchTitles(INDEX, '')).toEqual([]);
    expect(searchTitles(INDEX, '   ')).toEqual([]);
  });

  it('returns nothing when nothing matches', () => {
    expect(searchTitles(INDEX, 'zzzz')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(searchTitles(INDEX, 'e', 2)).toHaveLength(2);
  });

  it('is deterministic', () => {
    expect(titles('iron')).toEqual(titles('iron'));
  });

  it('stays fast enough to run on every keystroke', () => {
    const big: TitleIndexEntry[] = Array.from({ length: 1200 }, (_, i) => ({
      s: `a-${i}`,
      t: `Article number ${i}`,
      c: ['Materials'],
    }));
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) searchTitles(big, 'article');
    // 20 keystrokes over a corpus larger than the real one.
    expect(performance.now() - started).toBeLessThan(250);
  });
});
