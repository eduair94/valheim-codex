import { describe, expect, it } from 'vitest';
import { ingredientKey, isRecipeLabel, parseRecipe, recipeLookups } from '@/lib/wiki/recipe';

/**
 * Every string here is one the wiki actually stores. A recipe that parses
 * wrong is worse than one left as text: the reader gets a tidy grid of
 * confidently wrong quantities, and nothing on the page says so.
 */

describe('parseRecipe', () => {
  it('reads the ordinary case', () => {
    expect(parseRecipe('Finewood x10; Bronze x3')).toEqual([
      { display: 'Finewood', lookup: 'Finewood', quantity: 10 },
      { display: 'Bronze', lookup: 'Bronze', quantity: 3 },
    ]);
  });

  it('keeps the Spanish for the reader and the English for the lookup', () => {
    // The index is English, so a translated article can only be linked
    // through the gloss the translation carries.
    expect(parseRecipe('Madera (Wood) x5; Bronce (Bronze) x2')).toEqual([
      { display: 'Madera', lookup: 'Wood', quantity: 5 },
      { display: 'Bronce', lookup: 'Bronze', quantity: 2 },
    ]);
  });

  it('keeps a name that contains a colon', () => {
    expect(parseRecipe('Mead base: Anti-sting x1')).toEqual([
      { display: 'Mead base: Anti-sting', lookup: 'Mead base: Anti-sting', quantity: 1 },
    ]);
  });

  it('strips the yield the wiki ran into the first ingredient', () => {
    // `ceramic-plate` states what it produces and loses the separator.
    expect(parseRecipe('Crafts 5Black marble x5')).toEqual([
      { display: 'Black marble', lookup: 'Black marble', quantity: 5 },
    ]);
  });

  it('handles a four-ingredient recipe', () => {
    expect(parseRecipe('Finewood x10; Barber kit x1; Bronze nails x5; Troll hide x5')).toHaveLength(
      4,
    );
  });

  it('accepts the multiplication sign as well as the letter', () => {
    expect(parseRecipe('Wood ×5')).toEqual([{ display: 'Wood', lookup: 'Wood', quantity: 5 }]);
  });

  it.each(['', '   ', 'Some prose with no quantities', 'Wood x'])(
    'returns nothing for %s rather than inventing an ingredient',
    (value) => {
      expect(parseRecipe(value)).toEqual([]);
    },
  );
});

describe('ingredientKey', () => {
  it('ignores the differences that mean nothing to a reader', () => {
    // `Leather scraps` in a recipe, `Leather Scraps` as an article title.
    expect(ingredientKey('Leather Scraps')).toBe(ingredientKey('leather scraps'));
    expect(ingredientKey('  Iron   Nails ')).toBe('iron nails');
  });
});

describe('isRecipeLabel', () => {
  it.each(['Crafting Materials', 'crafting materials', 'Materiales de fabricación', 'Materials'])(
    'recognises %s',
    (label) => {
      expect(isRecipeLabel(label)).toBe(true);
    },
  );

  it.each(['Durability', 'Weight', 'Internal ID', 'Description'])(
    'leaves %s as an ordinary stat',
    (label) => {
      expect(isRecipeLabel(label)).toBe(false);
    },
  );
});

describe('recipeLookups', () => {
  it('collects every ingredient across the infobox for one query', () => {
    const groups = [
      {
        rows: [
          { label: 'Durability', value: '200' },
          { label: 'Crafting Materials', value: 'Wood x5; Bronze x2' },
        ],
      },
      { rows: [{ label: 'Materiales de fabricación', value: 'Hierro (Iron) x20' }] },
    ];

    expect(recipeLookups(groups)).toEqual(['Wood', 'Bronze', 'Iron']);
  });
});
