import { describe, expect, it } from 'vitest';
import { buildTsQuery } from '@/lib/rag/tsquery';

describe('buildTsQuery', () => {
  it('joins meaningful terms with OR', () => {
    expect(buildTsQuery('iron sword damage')).toBe('iron or sword or damage');
  });

  it('drops English and Spanish stop words', () => {
    expect(buildTsQuery('how much iron do I need for the sword')).toBe('iron or sword');
    expect(buildTsQuery('cuanto hierro necesito para la espada')).toBe('hierro or espada');
  });

  it('keeps proper nouns intact', () => {
    expect(buildTsQuery('¿Dónde está Yagluth?')).toBe('yagluth');
  });

  it('keeps accents on content words, and drops accented question words', () => {
    // "montaña" is what the question is about; "dónde" and "está" are not.
    expect(buildTsQuery('¿Dónde está la montaña?')).toBe('montaña');
    expect(buildTsQuery('¿Cómo cazo un jabalí?')).toBe('cazo or jabalí');
  });

  it('strips punctuation that would otherwise reach the parser', () => {
    // "x5" survives on purpose: crafting quantities read as "Iron x20".
    expect(buildTsQuery("Surtling's core (x5) & <fire>")).toBe('surtling or core or x5 or fire');
  });

  it('deduplicates repeated terms', () => {
    expect(buildTsQuery('iron iron iron sword')).toBe('iron or sword');
  });

  it('returns an empty string when nothing survives filtering', () => {
    expect(buildTsQuery('how much do I need')).toBe('');
    expect(buildTsQuery('   ')).toBe('');
    expect(buildTsQuery('?!.')).toBe('');
  });

  it('caps the number of terms', () => {
    const long = Array.from({ length: 30 }, (_, i) => `term${i}`).join(' ');
    expect(buildTsQuery(long).split(' or ')).toHaveLength(12);
  });

  it('drops a bare upgrade number but keeps the word "level", which infobox chunks use', () => {
    expect(buildTsQuery('level 3 sword')).toBe('level or sword');
  });

  it('keeps numbers big enough to be a stat', () => {
    expect(buildTsQuery('deathsquito 400 damage')).toContain('400');
  });
});

describe('corpus stop words', () => {
  it('drops "valheim", which every document in the index contains', () => {
    // Left in, it retrieved the *Valheim* article for a question about food.
    expect(buildTsQuery('¿Qué hace la comida en Valheim?')).toBe('comida');
    expect(buildTsQuery('valheim iron sword')).toBe('iron or sword');
  });

  it('still returns a usable query when only the corpus word is dropped', () => {
    expect(buildTsQuery('Valheim Yagluth')).toBe('yagluth');
  });
});
