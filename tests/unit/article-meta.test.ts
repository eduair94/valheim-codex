import { describe, expect, it } from 'vitest';
import { askTitle, clipText, displayTitle, primaryCategory, titleTier, titleWrapClass } from '@/components/wiki/article/article-meta';
import { isMention, lineCuts, piecesOf, segmentLines, splitSegments } from '@/components/wiki/article/lines';

describe('displayTitle (LM-14)', () => {
  it('splits a translated title into the name and its English gloss', () => {
    expect(displayTitle('Espada de hierro (Iron Sword)', 'Iron Sword')).toEqual({
      name: 'Espada de hierro',
      english: 'Iron Sword',
    });
  });

  it('still shows the English name when the translation dropped the gloss', () => {
    expect(displayTitle('Murciélago', 'Bat')).toEqual({ name: 'Murciélago', english: 'Bat' });
  });

  it('shows no gloss for an untranslated title, or one that is the same in both', () => {
    expect(displayTitle('Iron Sword', 'Iron Sword')).toEqual({ name: 'Iron Sword', english: null });
    expect(displayTitle('Eitr', 'Eitr')).toEqual({ name: 'Eitr', english: null });
  });

  it('keeps brackets that are part of the name', () => {
    expect(displayTitle('Yuleklapp (mediano) (Yuleklapp (medium))', 'Yuleklapp (medium)').name).toBe('Yuleklapp (mediano)');
  });
});

describe('titleTier', () => {
  it('sizes the title by its length', () => {
    expect(titleTier('Troll')).toBe('short');
    expect(titleTier('Espada de hierro de dos manos')).toBe('medium');
    expect(titleTier('Champiñones a montones a la Tierras brumosas')).toBe('long');
  });
});

describe('titleWrapClass', () => {
  it('breaks any word too long for the line, and hyphenates a name that is one word', () => {
    // Ran 26px past a 320px phone's column beside the picture.
    expect(titleWrapClass('Congelamiento')).toBe('wrap-break-word hyphens-auto');
    expect(titleWrapClass(' Quiebraespinas ')).toBe('wrap-break-word hyphens-auto');
  });

  it('leaves a name of several words to break between them, unhyphenated', () => {
    expect(titleWrapClass('Hachas Berserkir Atronadoras')).toBe('wrap-break-word');
    expect(titleWrapClass('Espada de hierro')).toBe('wrap-break-word');
  });
});

describe('primaryCategory', () => {
  it('skips the wiki bookkeeping and the recipe lists', () => {
    expect(primaryCategory(['Forge recipes', 'Weapons', 'Swords'])).toBe('Weapons');
    expect(primaryCategory(['Unfinished', 'Creatures'])).toBe('Creatures');
  });

  it('falls back to a recipe list when that is all there is', () => {
    expect(primaryCategory(['Cooking recipes'])).toBe('Cooking recipes');
    expect(primaryCategory([])).toBeNull();
  });
});

describe('clipText', () => {
  it('returns short text whole, with its spacing flattened', () => {
    expect(clipText('The iron sword\n is the second sword.', 160)).toBe('The iron sword is the second sword.');
  });

  it('cuts at a word boundary and marks the cut', () => {
    const out = clipText('Trolls are aggressive creatures found in Black Forests, massive bumbling humanoids.', 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toBe('Trolls are aggressive creatures found…');
  });
});

describe('askTitle', () => {
  it('asks in the reader’s words, with the English name the wiki uses', () => {
    expect(askTitle('Espada de hierro (Iron Sword)', 'Iron Sword')).toBe('Espada de hierro (Iron Sword)');
    expect(askTitle('Murciélago', 'Bat')).toBe('Murciélago (Bat)');
    expect(askTitle('Iron Sword', 'Iron Sword')).toBe('Iron Sword');
  });
});

describe('segmentLines', () => {
  const link = { slug: 'wood', title: 'Wood' };

  it('splits linked text at its line breaks, keeping each quantity with its material (BWR-01)', () => {
    const lines = segmentLines([
      { text: '10 ' },
      { text: 'Wood', link },
      { text: '\n15 ' },
      { text: 'Flint', link: { slug: 'flint', title: 'Flint' } },
    ]);
    expect(lines.map((line) => line.map((s) => s.text).join(''))).toEqual(['10 Wood', '15 Flint']);
    expect(lines[0]?.[1]?.link).toEqual(link);
  });

  it('cuts a link that spans a break into two links to the same article', () => {
    const lines = segmentLines([{ text: 'Iron\nSword', link }]);
    expect(lines).toEqual([[{ text: 'Iron', link }], [{ text: 'Sword', link }]]);
  });

  it('drops empty lines and the spaces around a break', () => {
    const lines = segmentLines([{ text: 'Fire \n\n Frost' }]);
    expect(lines).toEqual([[{ text: 'Fire' }], [{ text: 'Frost' }]]);
  });

  it('leaves text without breaks as one line', () => {
    expect(segmentLines([{ text: 'Slash: 55' }])).toEqual([[{ text: 'Slash: 55' }]]);
  });
});

describe('lineCuts — breaks an older ingest lost', () => {
  const pieces = (text: string, repair?: 'cell' | 'value') => piecesOf(text, lineCuts(text, repair));

  it('splits a cell of quantities run together, one material per line', () => {
    expect(pieces('10 Wood15 Flint20 Leather scraps5 Deer hide', 'cell')).toEqual([
      '10 Wood',
      '15 Flint',
      '20 Leather scraps',
      '5 Deer hide',
    ]);
    // The translated form keeps its glosses in brackets.
    expect(pieces('2 Madera (Wood)20 Hierro (Iron)3 Retazos de cuero (Leather scraps)', 'cell')).toEqual([
      '2 Madera (Wood)',
      '20 Hierro (Iron)',
      '3 Retazos de cuero (Leather scraps)',
    ]);
  });

  it('leaves alone what only looks run together', () => {
    for (const text of ['Tier2 pickaxe', 'Weak to x1.5', '1x + 1x + 2x', '2.46 s (0.86 + 0.70 + 0.90)', 'Yes, if a Love potion is active']) {
      expect(lineCuts(text, 'cell')).toEqual([]);
    }
  });

  it('splits short entries joined with "; " in an infobox value, and never a sentence', () => {
    expect(pieces('21 (0 skill); 31.5 (100 skill)', 'value')).toEqual(['21 (0 skill)', '31.5 (100 skill)']);
    const sentence = 'It can be crafted at the Forge; it requires a level 2 forge and a good amount of patience to make.';
    expect(lineCuts(sentence, 'value')).toEqual([]);
  });

  it('splits labelled amounts run together, in a cell or a value', () => {
    expect(pieces('Perforante: 47/56Veneno (Poison): 5/20', 'cell')).toEqual(['Perforante: 47/56', 'Veneno (Poison): 5/20']);
    expect(pieces('Slash: 35/53Pierce: 20', 'value')).toEqual(['Slash: 35/53', 'Pierce: 20']);
    // A capital after a digit that does not start a "Name: amount" stays put.
    expect(lineCuts('Tier 2Iron pickaxe', 'cell')).toEqual([]);
    expect(lineCuts('Level 3Total', 'value')).toEqual([]);
  });

  it('prefers the string’s own line breaks, and repairs nothing without being asked', () => {
    expect(pieces('10 Wood\n15 Flint', 'cell')).toEqual(['10 Wood', '15 Flint']);
    expect(lineCuts('10 Wood15 Flint')).toEqual([]);
  });
});

describe('splitSegments', () => {
  it('cuts linked text at repaired breaks, keeping each link whole', () => {
    const wood = { slug: 'wood', title: 'Wood' };
    const flint = { slug: 'flint', title: 'Flint' };
    const segments = [{ text: '10 ' }, { text: 'Wood', link: wood }, { text: '15 ' }, { text: 'Flint', link: flint }];
    const text = segments.map((s) => s.text).join('');
    const lines = splitSegments(segments, lineCuts(text, 'cell'));
    expect(lines).toEqual([
      [{ text: '10 ' }, { text: 'Wood', link: wood }],
      [{ text: '15 ' }, { text: 'Flint', link: flint }],
    ]);
  });

  it('drops the separator of a "; " join', () => {
    const text = 'Fire; Frost';
    expect(splitSegments([{ text }], lineCuts(text, 'value'))).toEqual([[{ text: 'Fire' }], [{ text: 'Frost' }]]);
  });
});

describe('isMention', () => {
  const link = (title: string) => ({ slug: 'x', title });

  it('keeps a name, and a name with its gloss', () => {
    expect(isMention({ text: 'Madera (Wood)', link: link('Madera') })).toBe(true);
    expect(
      isMention({
        text: 'Champiñones a montones a la Tierras brumosas (Mushrooms Galore á la Mistlands)',
        link: link('Champiñones a montones a la Tierras brumosas'),
      }),
    ).toBe(true);
  });

  it('refuses a run-together list item claimed whole for its last name', () => {
    expect(isMention({ text: 'Fabricación: Bronce Cuchillo de cobre (Copper knife)', link: link('Cuchillo de cobre') })).toBe(false);
  });

  it('has nothing to refuse in plain text', () => {
    expect(isMention({ text: 'just words' })).toBe(true);
  });
});
