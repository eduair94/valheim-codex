import { describe, expect, it } from 'vitest';
import { GLOSSARY_SIZE, matchGlossary, tokenize, translateQuery } from '@/lib/rag/glossary';

describe('translateQuery', () => {
  it('translates known Spanish words and keeps the rest', () => {
    expect(translateQuery('espada de hierro')).toBe('sword de iron');
  });

  it('returns null when nothing was translated, so an English query is not run twice', () => {
    expect(translateQuery('iron sword')).toBeNull();
    expect(translateQuery('')).toBeNull();
  });

  it('folds accents on lookup: a phone keyboard drops them', () => {
    expect(translateQuery('montana')).toBe('mountain');
    expect(translateQuery('estano')).toBe('tin');
    expect(translateQuery('murcielago')).toBe('bat');
    expect(translateQuery('MONTAÑA')).toBe('mountain');
  });

  it('reads decomposed input as the letters it spells', () => {
    // "montaña" with the tilde as a combining mark splits at the mark unless normalised.
    expect(translateQuery('montaña'.normalize('NFD'))).toBe('mountain');
  });

  it('translates the plural that the dead "montaña_s" key never reached', () => {
    expect(translateQuery('jefes de las montañas')).toBe('boss de las mountain');
  });

  it('treats a word that is a property of every object as a word', () => {
    // A plain-object lookup resolved "constructor" to Object and searched for "function Object()".
    expect(translateQuery('¿qué hace el constructor?')).toBeNull();
    expect(translateQuery('hierro constructor')).toBe('iron constructor');
  });

  it('matches names of several words before their single words', () => {
    expect(translateQuery('banco de trabajo')).toBe('workbench');
    expect(translateQuery('mesa de artesano')).toBe('artisan table');
    expect(translateQuery('donde esta el bosque negro')).toBe('donde esta el black forest');
    expect(translateQuery('selva negra')).toBe('black forest');
  });

  it('keeps an untranslated word as typed, accents and all, for the accent-keeping index', () => {
    expect(translateQuery('Jörmundling de hierro')).toBe('jörmundling de iron');
  });

  it('gives every alternative of a word that has two meanings', () => {
    expect(translateQuery('horno')).toBe('kiln smelter');
    // Hide or pelt: Deer hide and Wolf pelt are both "piel".
    expect(translateQuery('piel de ciervo')).toBe('pelt hide de deer');
  });

  it("knows the names the translations print where the article's own Spanish name differs", () => {
    expect(translateQuery('retazos de cuero')).toBe('leather scraps');
    expect(translateQuery('¿dónde encuentro restos de cuero?')).toBe('dónde encuentro leather scraps');
    expect(translateQuery('ojo de enano gris')).toBe('eye de greydwarf');
    expect(translateQuery('nido de trasgo gris')).toBe('nest de greydwarf');
    expect(translateQuery('cuero de trol')).toBe('leather de troll');
    // Their words alone are not those things: "restos" is also giant remains.
    expect(translateQuery('restos de gigante')).toBeNull();
  });

  it('reads "pecho" as body armour, not as the storage chest or a body', () => {
    expect(translateQuery('pecho')).toBe('body armor');
    expect(matchGlossary('pecho')[0]!.english).toEqual([['body', 'armor']]);
  });

  it('tells the antler pickaxe from the polearms "asta" also names', () => {
    expect(translateQuery('pico de asta')).toBe('antler pickaxe');
    expect(translateQuery('armas de asta')).toBe('polearms');
  });
});

describe('matchGlossary', () => {
  it('splits a query into recognised phrases and plain words, with alternatives kept apart', () => {
    expect(matchGlossary('horno de banco de trabajo')).toEqual([
      { words: ['horno'], english: [['kiln'], ['smelter']] },
      { words: ['de'], english: null },
      { words: ['banco', 'de', 'trabajo'], english: [['workbench']] },
    ]);
  });

  it('reads the display vocabulary backwards, so a tile name is a search term', () => {
    expect(matchGlossary('tierras cenicientas')[0]).toEqual({
      words: ['tierras', 'cenicientas'],
      english: [['ashlands']],
    });
    expect(matchGlossary('caldero')[0]!.english).toEqual([['cauldron']]);
  });
});

describe('tokenize', () => {
  it('keeps letters and digits only, in NFC', () => {
    expect(tokenize("Surtling's core (x5) & <fire>")).toEqual(['surtling', 's', 'core', 'x5', 'fire']);
    expect(tokenize('montaña'.normalize('NFD'))).toEqual(['montaña']);
    expect(tokenize('\u0000 ¿?')).toEqual([]);
  });
});

it('has a sizeable map', () => {
  expect(GLOSSARY_SIZE).toBeGreaterThan(300);
});
