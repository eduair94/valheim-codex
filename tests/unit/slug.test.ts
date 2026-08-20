import { describe, expect, it } from 'vitest';
import { slugify } from '@/lib/wiki/slug';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Iron Sword')).toBe('iron-sword');
    expect(slugify('Black Metal Sword')).toBe('black-metal-sword');
  });

  it('folds accents instead of escaping them', () => {
    expect(slugify('Núcleos de surtling')).toBe('nucleos-de-surtling');
    expect(slugify('Ásmund')).toBe('asmund');
  });

  it('handles the parenthesised disambiguation the wiki uses', () => {
    expect(slugify('Dvergr (race)')).toBe('dvergr-race');
    expect(slugify('Valheim (world)')).toBe('valheim-world');
  });

  it('collapses runs of punctuation into a single hyphen', () => {
    expect(slugify('Yagluth & Bonemass')).toBe('yagluth-bonemass');
    expect(slugify('0★ Deathsquito')).toBe('0-deathsquito');
  });

  it('never starts or ends with a hyphen', () => {
    expect(slugify('  Iron  ')).toBe('iron');
    expect(slugify('---Iron---')).toBe('iron');
    expect(slugify('Iron!')).toBe('iron');
  });

  it('bounds the length without leaving a trailing hyphen', () => {
    const slug = slugify('a '.repeat(80));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back rather than producing an empty path segment', () => {
    expect(slugify('★')).toBe('article');
    expect(slugify('')).toBe('article');
  });

  it('is stable', () => {
    expect(slugify('Iron Sword')).toBe(slugify('Iron Sword'));
  });
});
