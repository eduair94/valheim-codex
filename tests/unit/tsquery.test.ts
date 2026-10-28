import { describe, expect, it } from 'vitest';
import {
  accentIndex,
  buildTsQuery,
  isStopWord,
  MAX_GROUPS,
  planSearch,
  searchTsQueries,
  STOP_WORDS,
} from '@/lib/rag/tsquery';

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

  it('adds the accented spellings the index holds when given them, for the chat retriever', () => {
    const accents = accentIndex(['jörmundling', 'mjölnir', 'núcleo']);
    expect(buildTsQuery('jormundling and mjolnir', accents)).toBe('jormundling or jörmundling or mjolnir or mjölnir');
    // Typed with the accent: nothing to add.
    expect(buildTsQuery('Jörmundling', accents)).toBe('jörmundling');
    // Without the list, unchanged.
    expect(buildTsQuery('jormundling')).toBe('jormundling');
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

describe('planSearch', () => {
  it('makes one group per word or phrase, with the glossary English as alternatives', () => {
    expect(planSearch('espada de hierro')).toEqual([
      { words: ['espada'], typed: [], english: [['sword']], prefix: false },
      { words: ['hierro'], typed: [], english: [['iron']], prefix: false },
    ]);
  });

  it('keeps a phrase together, minus its stop words', () => {
    expect(planSearch('banco de trabajo')).toEqual([
      { words: ['banco', 'trabajo'], typed: [], english: [['workbench']], prefix: false },
    ]);
  });

  it('drops stop words in any accenting, and plans nothing for a query of only stop words', () => {
    expect(planSearch('¿Cómo invocar a Eikthyr?').map((g) => g.words)).toEqual([['invocar'], ['eikthyr']]);
    expect(planSearch('dónde encuentro plata').map((g) => g.words)).toEqual([['plata']]);
    expect(planSearch('de la')).toEqual([]);
    expect(planSearch('   ')).toEqual([]);
  });

  it('treats only an untranslated last word as still being typed', () => {
    expect(planSearch('eikth').at(-1)!.prefix).toBe(true);
    // "mead:*" would bring in the Meadows.
    expect(planSearch('hidromiel').at(-1)!.prefix).toBe(false);
    expect(planSearch('eikth hierro').some((g) => g.prefix)).toBe(false);
  });

  it('needs three letters for a prefix: "ca:*" matches nearly every passage', () => {
    expect(planSearch('ca').at(-1)!.prefix).toBe(false);
    expect(planSearch('cab').at(-1)!.prefix).toBe(true);
    expect(planSearch('hierro ca').at(-1)!.prefix).toBe(false);
  });

  it('plans at most five groups, whatever is typed', () => {
    const planned = planSearch('iron wood stone bronze copper silver black metal');
    expect(MAX_GROUPS).toBe(5);
    expect(planned.map((g) => g.words.join(' '))).toEqual(['iron', 'wood', 'stone', 'bronze', 'copper']);
    expect(searchTsQueries(planned)!.titles).toHaveLength(5);
  });

  it('folds the words and keeps the typed spelling beside them', () => {
    expect(planSearch('Jörmundling')).toEqual([
      { words: ['jormundling'], typed: ['jörmundling'], english: [], prefix: true },
    ]);
  });

  it('drops glossary output that is itself a stop word', () => {
    // "conseguir" is "get obtain"; "get" is a stop word.
    expect(planSearch('conseguir hierro')[0]!.english).toEqual([['obtain']]);
  });
});

describe('searchTsQueries', () => {
  it('ORs the groups to find candidates and ANDs them to rank', () => {
    const planned = searchTsQueries(planSearch('espada de hierro'))!;
    expect(planned.any).toBe("('espada' | 'sword') | ('hierro' | 'iron')");
    expect(planned.every).toBe("('espada' | 'sword') & ('hierro' | 'iron')");
    expect(planned.titles).toEqual(["('espada':A | 'sword':A)", "('hierro':A | 'iron':A)"]);
  });

  it('keeps a word with two readings as alternatives, never as two required words', () => {
    expect(searchTsQueries(planSearch('horno'))!.every).toBe("('horno' | 'kiln' | 'smelter')");
  });

  it('requires every word of a phrase alternative', () => {
    expect(searchTsQueries(planSearch('banco de trabajo'))!.any).toBe("(('banco' & 'trabajo') | 'workbench')");
  });

  it('adds the accented spellings the index holds, so folding needs no folded index', () => {
    const accents = accentIndex(['jörmundling', 'núcleo', 'nidhögg', 'iron']);
    expect(searchTsQueries(planSearch('nucleo'), accents)!.any).toBe("('nucleo' | 'núcleo' | 'core')");
    // A known name of several words stays one group, Spanish words and English name alike.
    expect(searchTsQueries(planSearch('nucleo de surtling'), accents)!.any).toBe(
      "((('nucleo' | 'núcleo') & 'surtling') | ('surtling' & 'core'))",
    );
    // A prefix reaches the accented words it starts.
    expect(searchTsQueries(planSearch('jormund'), accents)!.any).toBe("('jormund':* | 'jörmundling')");
    expect(searchTsQueries(planSearch('jormund'), accents)!.titles).toEqual(["('jormund':*A | 'jörmundling':A)"]);
  });

  it('is null when there is nothing to search for', () => {
    expect(searchTsQueries(planSearch('de la'))).toBeNull();
  });

  it('never lets an operator or a quote through, whatever the input', () => {
    const planned = searchTsQueries(planSearch("it's x5 & | ! ( ) : * \ ' \" <script> \u0000 drop"))!;
    for (const lexeme of planned.any.match(/'[^']*'/g) ?? []) expect(lexeme).toMatch(/^'[\p{L}\p{N}]+'$/u);
    expect(planned.any).not.toMatch(/[<>"\\]/);
    expect(planned.any.includes(String.fromCharCode(0))).toBe(false);
  });
});

describe('isStopWord', () => {
  it('matches whatever the accents', () => {
    expect(isStopWord('Dónde')).toBe(true);
    expect(isStopWord('donde')).toBe(true);
    expect(isStopWord('hierro')).toBe(false);
  });

  it('exports the shared list, which still drives the chat query', () => {
    expect(STOP_WORDS.has('valheim')).toBe(true);
  });
});
