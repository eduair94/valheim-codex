import { describe, expect, it } from 'vitest';
import {
  BY_NAME,
  columnKind,
  dataLines,
  headingWidth,
  isMissing,
  isShortHeading,
  leadingNumber,
  nextSort,
  sortRows,
  valueLines,
} from '@/components/wiki/lists/compare-model';
import { countLabel, facetLine, filterAxis, formatCount, headingParts } from '@/components/wiki/lists/format';
import { fandomSources } from '@/components/wiki/lists/image';

describe('fandomSources', () => {
  const biome =
    'https://static.wikia.nocookie.net/valheim/images/1/1f/Biome_meadows.png/revision/latest/scale-to-width-down/268?cb=20210203';

  it('gives a picture drawn at two sizes a srcset, never wider than what is stored', () => {
    const { src, srcSet } = fandomSources(biome, [64, 266]);
    // The card asks for 532 and gets the stored 268: never enlarged.
    expect(src).toBe(biome);
    expect(srcSet).toBe(`${biome.replace('/268?', '/128?')} 128w, ${biome} 268w`);
  });

  it('gives a picture drawn at one size one URL, at twice that size', () => {
    const sprite = 'https://static.wikia.nocookie.net/valheim/images/a/a1/Iron.png/revision/latest?cb=1';
    expect(fandomSources(sprite, [40])).toEqual({
      src: 'https://static.wikia.nocookie.net/valheim/images/a/a1/Iron.png/revision/latest/scale-to-width-down/80?cb=1',
    });
  });

  it('leaves a picture from anywhere else alone', () => {
    expect(fandomSources('https://example.com/a.png', [64, 266])).toEqual({ src: 'https://example.com/a.png' });
  });
});

describe('countLabel', () => {
  it('agrees the noun with the number', () => {
    // "/wiki/c/all?biome=Rivers" used to read "1 artículos".
    expect(countLabel(1, 'es')).toBe('1 artículo');
    expect(countLabel(24, 'es')).toBe('24 artículos');
    expect(countLabel(0, 'es')).toBe('0 artículos');
    expect(countLabel(1, 'en')).toBe('1 article');
    expect(countLabel(158, 'en')).toBe('158 articles');
  });

  it('formats the number the reader’s way', () => {
    expect(formatCount(1027, 'en')).toBe('1,027');
    expect(countLabel(1027, 'en')).toBe('1,027 articles');
    expect(formatCount(1027, 'es')).toMatch(/^1\.?027$/);
  });
});

describe('headingParts', () => {
  it('names each part of a filter in the reader’s language', () => {
    expect(headingParts({ category: 'Weapons' }, 'es')).toEqual([
      { text: 'Armas', english: 'Weapons', untranslated: false },
    ]);
    expect(headingParts({ biome: 'Meadows', station: 'Forge' }, 'es').map((p) => p.text)).toEqual([
      'Praderas',
      'Forja',
    ]);
  });

  it('keeps English where there is no Spanish name, and says so', () => {
    const [part] = headingParts({ category: 'Some new category' }, 'es');
    expect(part).toEqual({ text: 'Some new category', english: 'Some new category', untranslated: true });
  });

  it('never marks English as untranslated in English', () => {
    expect(headingParts({ category: 'Some new category' }, 'en')[0]?.untranslated).toBe(false);
  });
});

describe('filterAxis', () => {
  it('names the one way in, or none when the filter combines several', () => {
    expect(filterAxis({ category: 'Weapons' })).toBe('category');
    expect(filterAxis({ station: 'Forge' })).toBe('station');
    expect(filterAxis({ category: 'Food', biome: 'Plains' })).toBeNull();
    expect(filterAxis({})).toBeNull();
  });
});

describe('facetLine', () => {
  it('translates the facets a row falls back on', () => {
    expect(facetLine({ type: 'Sword', station: 'Forge' }, 'es')).toBe('Espada · Forja');
    expect(facetLine({ type: 'Sword', station: 'Forge' }, 'en')).toBe('Sword · Forge');
    expect(facetLine({ type: '', biome: 'Meadows' }, 'es')).toBe('Praderas');
  });
});

describe('leadingNumber', () => {
  it('reads the first number of a value', () => {
    expect(leadingNumber('55 slash')).toBe(55);
    expect(leadingNumber('0,8')).toBe(0.8);
    expect(leadingNumber('-5%')).toBe(-5);
    expect(leadingNumber('Sword')).toBeNull();
  });
});

describe('columnKind', () => {
  it('sets numbers as data', () => {
    expect(columnKind(['55', '73', '21 (0 skill); 31.5 (100 skill)'])).toBe('number');
  });

  it('keeps a few words on one line', () => {
    expect(columnKind(['Sword', 'Axe', 'Yes', ''])).toBe('short');
  });

  it('wraps sentences instead of stretching the column', () => {
    expect(
      columnKind([
        'For a slight blood offering, this staff lets you cast a protective bubble around you and your allies.',
        'Sword',
      ]),
    ).toBe('text');
  });

  it('reads each line of a multi-line value on its own', () => {
    expect(columnKind(['Wood x10\nBronze x5\nDeer Hide x2'])).toBe('short');
  });

  it('treats a long numeric value as prose', () => {
    expect(columnKind(['10 per hit, but only while standing in the smoke of a burning building'])).toBe('text');
  });
});

describe('headingWidth', () => {
  it('keeps a heading to two balanced lines', () => {
    // "Adrenalina" / "de bloqueo"
    expect(headingWidth('Adrenalina de bloqueo')).toBe(10);
    // "Nivel de" / "fabricación"
    expect(headingWidth('Nivel de fabricación')).toBe(11);
    // "Armadura de" / "bloqueo de parada"
    expect(headingWidth('Armadura de bloqueo de parada')).toBe(17);
  });

  it('never breaks a single word', () => {
    expect(headingWidth('Teletransportable')).toBe(17);
    expect(headingWidth('  Peso ')).toBe(4);
  });
});

describe('isShortHeading', () => {
  it('keeps the label style for short headings only', () => {
    expect(isShortHeading('Durabilidad')).toBe(true);
    expect(isShortHeading('Teleportable (Can go through wood portal?)')).toBe(false);
  });
});

describe('dataLines', () => {
  it('puts each alternative of a value on its own line', () => {
    expect(dataLines('21 (0 skill); 31.5 (100 skill)')).toEqual(['21 (0 skill)', '31.5 (100 skill)']);
    expect(dataLines('Wood x10\nBronze x5')).toEqual(['Wood x10', 'Bronze x5']);
    expect(dataLines('55')).toEqual(['55']);
  });

  it('decides a column on its longest line, not the joined value', () => {
    expect(columnKind(['21 (0 de habilidad); 31.5 (100 de habilidad)', '2 (0 de habilidad); 3 (100 de habilidad)'])).toBe(
      'number',
    );
  });
});

describe('valueLines and isMissing', () => {
  it('splits a value on its line breaks and drops blanks', () => {
    expect(valueLines('Wood x10\n\n Bronze x5 ')).toEqual(['Wood x10', 'Bronze x5']);
    expect(isMissing(undefined)).toBe(true);
    expect(isMissing('  ')).toBe(true);
    expect(isMissing('0')).toBe(false);
  });
});

describe('sortRows', () => {
  const rows: { title: string; values: Record<string, string> }[] = [
    { title: 'Arbalest', values: { Weight: '1.5', Type: 'Crossbow' } },
    { title: 'Bronze Sword', values: { Weight: '20', Type: 'Sword' } },
    { title: 'Club', values: { Type: 'Club' } },
    { title: 'Dyrnwyn', values: { Weight: '100', Type: 'Sword' } },
    { title: 'Eitr', values: { Weight: 'varies', Type: 'Material' } },
  ];
  const titles = (list: typeof rows) => list.map((row) => row.title);

  it('keeps the arriving order by name, and turns it around', () => {
    expect(titles(sortRows(rows, BY_NAME, 'en'))).toEqual(['Arbalest', 'Bronze Sword', 'Club', 'Dyrnwyn', 'Eitr']);
    expect(titles(sortRows(rows, { column: null, desc: true }, 'en'))[0]).toBe('Eitr');
  });

  it('sorts numbers as numbers, words after them, missing values last', () => {
    expect(titles(sortRows(rows, { column: 'Weight', desc: false }, 'en'))).toEqual([
      'Arbalest',
      'Bronze Sword',
      'Dyrnwyn',
      'Eitr',
      'Club',
    ]);
  });

  it('keeps missing values last when the order is turned around', () => {
    expect(titles(sortRows(rows, { column: 'Weight', desc: true }, 'en'))).toEqual([
      'Dyrnwyn',
      'Bronze Sword',
      'Arbalest',
      'Eitr',
      'Club',
    ]);
  });

  it('breaks ties by name', () => {
    expect(titles(sortRows(rows, { column: 'Type', desc: false }, 'en'))).toEqual([
      'Club',
      'Arbalest',
      'Eitr',
      'Bronze Sword',
      'Dyrnwyn',
    ]);
  });

  it('never reorders the rows it was given', () => {
    const before = titles(rows);
    sortRows(rows, { column: 'Weight', desc: true }, 'en');
    expect(titles(rows)).toEqual(before);
  });
});

describe('nextSort', () => {
  it('turns the same column around and starts a new one ascending', () => {
    expect(nextSort(BY_NAME, 'Weight')).toEqual({ column: 'Weight', desc: false });
    expect(nextSort({ column: 'Weight', desc: false }, 'Weight')).toEqual({ column: 'Weight', desc: true });
    expect(nextSort({ column: 'Weight', desc: true }, null)).toEqual({ column: null, desc: false });
  });
});
