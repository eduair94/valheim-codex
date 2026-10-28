import { describe, expect, it } from 'vitest';
import { fold, slugify } from '@/lib/wiki/slug';

describe('fold', () => {
  it('drops accents and case, the same way for every caller', () => {
    expect(fold('Jörmundling')).toBe('jormundling');
    expect(fold('MONTAÑA')).toBe('montana');
    // Decomposed input folds the same as composed.
    expect(fold('montaña'.normalize('NFD'))).toBe('montana');
  });

  // The range is written as escapes in slug.ts; this fails if an editor ever
  // turns it back into raw marks and then strips or normalises them.
  it('strips every combining mark, from the first to the last', () => {
    for (const code of [0x300, 0x301, 0x303, 0x308, 0x30a, 0x327, 0x36f]) {
      expect(fold(`a${String.fromCharCode(code)}`)).toBe('a');
    }
    expect(fold(`a${String.fromCharCode(0x370)}`)).toBe(`a${String.fromCharCode(0x371)}`);
  });

  it('leaves letters that are not a base plus an accent', () => {
    expect(fold('Blåbär ø æ')).toBe('blabar ø æ');
  });
});

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
