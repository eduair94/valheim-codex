import { describe, expect, it } from 'vitest';
import {
  ingredientKey,
  isRecipeLabel,
  isWholeRecipe,
  pairRecipeSources,
  parseRecipe,
  parseRecipeCell,
  recipeLookups,
} from '@/lib/wiki/recipe';

/**
 * Every string here is one the wiki actually stores. A recipe that parses
 * wrong is worse than one left as text: the reader gets a tidy grid of
 * confidently wrong quantities, and nothing on the page says so.
 */

describe('parseRecipeCell', () => {
  it('reads name-first entries', () => {
    expect(parseRecipeCell('Wood x2; Iron x20; Leather scraps x3').entries).toEqual([
      { name: 'Wood', qty: 2 },
      { name: 'Iron', qty: 20 },
      { name: 'Leather scraps', qty: 3 },
    ]);
  });

  it('reads quantity-first entries, one per line', () => {
    // How every armor set writes its pieces' costs.
    expect(parseRecipeCell('5 Bronze\n2 Deer hide').entries).toEqual([
      { name: 'Bronze', qty: 5 },
      { name: 'Deer hide', qty: 2 },
    ]);
  });

  it('reads a quantity run into its name', () => {
    // Troll hide cape: `10<a>Bone fragments</a>`, with no space between.
    expect(parseRecipeCell('10 Troll hide\n10Bone fragments').entries).toEqual([
      { name: 'Troll hide', qty: 10 },
      { name: 'Bone fragments', qty: 10 },
    ]);
  });

  it('reads "x N" with a space', () => {
    expect(parseRecipeCell('Deer hide x 5').entries).toEqual([{ name: 'Deer hide', qty: 5 }]);
  });

  it('takes the yield from a Crafts line and never makes it an entry', () => {
    expect(parseRecipeCell('Crafts 20\nBronze x1')).toEqual({
      entries: [{ name: 'Bronze', qty: 1 }],
      yield: 20,
      notes: [],
    });
  });

  it('splits a yield glued to the first entry by the old parser', () => {
    expect(parseRecipeCell('Crafts 5Black marble x5')).toMatchObject({
      entries: [{ name: 'Black marble', qty: 5 }],
      yield: 5,
    });
  });

  it('keeps what it cannot read as notes, inventing nothing', () => {
    expect(parseRecipeCell('Pot shard x3, x4,')).toMatchObject({
      entries: [],
      notes: ['Pot shard x3, x4,'],
    });
    expect(parseRecipeCell('nil').entries).toEqual([]);
    expect(parseRecipeCell('n/a').entries).toEqual([]);
  });

  it('says nothing at all for the ways the wiki writes "none"', () => {
    for (const value of ['nil', 'n/a', 'N/A', '-', '—', 'none', '']) {
      expect(parseRecipeCell(value)).toEqual({ entries: [], yield: null, notes: [] });
    }
  });

  it('does not make a name out of two quantities', () => {
    // Read lazily, "Pot shard x3, x4" would be 4 of something called "Pot shard x3,".
    expect(parseRecipeCell('Pot shard x3, x4')).toEqual({
      entries: [],
      yield: null,
      notes: ['Pot shard x3, x4'],
    });
  });

  it('keeps headings and remarks as notes beside the entries they sit among', () => {
    expect(parseRecipeCell('Small:\nFinewood x2\n(Requires Stonecutter)')).toEqual({
      entries: [{ name: 'Finewood', qty: 2 }],
      yield: null,
      notes: ['Small:', '(Requires Stonecutter)'],
    });
  });

  it('notes a second yield that disagrees with the first instead of choosing', () => {
    expect(parseRecipeCell('Crafts 6\nCrafts 3\nHoney x10')).toEqual({
      entries: [{ name: 'Honey', qty: 10 }],
      yield: 6,
      notes: ['Crafts 3'],
    });
  });

  it('never reads a bare number or a lone "x" as a material', () => {
    expect(parseRecipeCell('3x').entries).toEqual([]);
    expect(parseRecipeCell('20').entries).toEqual([]);
    expect(parseRecipeCell('Wood x').entries).toEqual([]);
  });

  it('reads a yield in the words a translation gives it', () => {
    // The stored Spanish Ceramic plate: "Crafts 5Black marble x5", translated
    // with the yield still run into the first material.
    expect(parseRecipeCell('Fabrica 5Mármol negro x5')).toEqual({
      entries: [{ name: 'Mármol negro', qty: 5 }],
      yield: 5,
      notes: [],
    });
  });

  it('reads no count that is not one', () => {
    // Zero of something is no material, and a craft that takes none would
    // leave the planner dividing by it.
    for (const value of ['Wood x0', '0 Wood', 'Coins x 999999999999999999999']) {
      expect(parseRecipeCell(value)).toEqual({ entries: [], yield: null, notes: [value] });
    }
  });

  it('does not make a name out of the "x" of a count', () => {
    // "2xWood" is two Wood or two of something called "xWood"; the cell does not say which.
    expect(parseRecipeCell('2xWood')).toEqual({ entries: [], yield: null, notes: ['2xWood'] });
    expect(parseRecipeCell('2x Wood\n2 x Stone').entries).toEqual([
      { name: 'Wood', qty: 2 },
      { name: 'Stone', qty: 2 },
    ]);
  });

  it('does not take a remark with a count in it for part of the name', () => {
    // Five of "Bronze (or 10 Copper)" is a material no chest holds, and on the
    // article page a tile of five Bronze that hides the other way to pay.
    expect(parseRecipeCell('5 Bronze (or 10 Copper)')).toEqual({
      entries: [],
      yield: null,
      notes: ['5 Bronze (or 10 Copper)'],
    });
  });
});

describe('isWholeRecipe', () => {
  it('takes a remark in brackets as a remark', () => {
    expect(isWholeRecipe(parseRecipeCell('Wood x2\n(Requires Stonecutter)'))).toBe(true);
    expect(isWholeRecipe(parseRecipeCell('Crafts 20\nBronze x1'))).toBe(true);
  });

  it('knows a recipe with a line nobody could read is only part of one', () => {
    // Pots: one count per size of pot, then the resin all sizes share.
    expect(isWholeRecipe(parseRecipeCell('Pot shard x3, x4, x5\nCharcoal resin x1'))).toBe(false);
    // Yuleklapp: three sizes, each under its heading.
    expect(isWholeRecipe(parseRecipeCell('Small:\nFinewood x2\nMedium:\nFinewood x3'))).toBe(false);
  });

  it('does not take a yield in other words for one', () => {
    // Ignored, "Makes 20" would make every craft one, and a Karve 80 bronze.
    expect(isWholeRecipe(parseRecipeCell('Makes 20\nBronze x1'))).toBe(false);
  });
});

describe('parseRecipe', () => {
  it('reads the ordinary case', () => {
    expect(parseRecipe('Finewood x10; Bronze x3')).toEqual([
      { display: 'Finewood', lookup: 'Finewood', quantity: 10 },
      { display: 'Bronze', lookup: 'Bronze', quantity: 3 },
    ]);
  });

  it('reads one entry per line, as infobox values are now stored', () => {
    expect(parseRecipe('Finewood x10\nBronze x3')).toEqual([
      { display: 'Finewood', lookup: 'Finewood', quantity: 10 },
      { display: 'Bronze', lookup: 'Bronze', quantity: 3 },
    ]);
    // A yield on a line of its own is not an ingredient.
    expect(parseRecipe('Crafts 5\nBlack marble x5')).toEqual([
      { display: 'Black marble', lookup: 'Black marble', quantity: 5 },
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

  it('reads the armor sets, which put the quantity first', () => {
    // 16 sets did, and their pieces showed the recipe as a plain paragraph.
    expect(parseRecipe('5 Bronze\n2 Deer hide')).toEqual([
      { display: 'Bronze', lookup: 'Bronze', quantity: 5 },
      { display: 'Deer hide', lookup: 'Deer hide', quantity: 2 },
    ]);
    expect(parseRecipe('5 Bronce (Bronze)')).toEqual([
      { display: 'Bronce', lookup: 'Bronze', quantity: 5 },
    ]);
  });

  it.each(['', '   ', 'Some prose with no quantities', 'Wood x'])(
    'returns nothing for %s rather than inventing an ingredient',
    (value) => {
      expect(parseRecipe(value)).toEqual([]);
    },
  );

  it('shows the wiki its own words rather than half a recipe', () => {
    // An empty list makes the page show the value as written: all three
    // pot sizes, instead of a tile of resin and no shards.
    expect(parseRecipe('Pot shard x3, x4, x5\nCharcoal resin x1')).toEqual([]);
    expect(parseRecipe('Small:\nFinewood x2\nMedium:\nFinewood x3')).toEqual([]);
    expect(parseRecipe('Wood x2\n(Requires Stonecutter)')).toEqual([{ display: 'Wood', lookup: 'Wood', quantity: 2 }]);
  });

  it('keeps a translated yield out of the first tile', () => {
    // The stored Spanish Ceramic plate, whose tile read "Fabrica 5Mármol negro".
    expect(parseRecipe('Fabrica 5Mármol negro x5')).toEqual([
      { display: 'Mármol negro', lookup: 'Mármol negro', quantity: 5 },
    ]);
    // Rows that keep the yield on a line of its own translate the same way.
    expect(parseRecipe('Fabrica 20\nBronce (Bronze) x1')).toEqual([
      { display: 'Bronce', lookup: 'Bronze', quantity: 1 },
    ]);
  });

  it('shows the text of a recipe with a line it cannot read, translated or not', () => {
    // A material written without its "x" is not a yield: tiles of the rest
    // would be a recipe one material short.
    expect(parseRecipe('Finewood x10\nBronze 3')).toEqual([]);
    expect(parseRecipe('Madera (Wood) x10\nCarbón 5')).toEqual([]);
  });
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

describe('pairRecipeSources', () => {
  const english = [
    {
      rows: [
        { label: 'Durability', value: '250' },
        { label: 'Crafting Materials', value: 'Finewood x10; Barber kit x1' },
      ],
    },
  ];

  it('pairs a translated recipe with the English it came from', () => {
    // The barber station really did come back with one gloss dropped, and
    // with it went that ingredient's icon and link.
    const translated = [
      {
        rows: [
          { label: 'Durabilidad', value: '250' },
          {
            label: 'Materiales de fabricación',
            value: 'Madera fina (Finewood) x10; Kit de peluquería x1',
          },
        ],
      },
    ];

    expect(pairRecipeSources(translated, english)).toEqual({
      'Madera fina (Finewood) x10; Kit de peluquería x1': 'Finewood x10; Barber kit x1',
    });
  });

  it('refuses to pair a recipe with a row that is not one', () => {
    // A shifted infobox would otherwise hand a recipe somebody else's stat,
    // and every ingredient would get the wrong picture.
    const shifted = [
      { rows: [{ label: 'Materiales de fabricación', value: 'Madera (Wood) x1' }] },
    ];
    const other = [{ rows: [{ label: 'Durability', value: '250' }] }];

    expect(pairRecipeSources(shifted, other)).toEqual({});
  });

  it('ignores rows that are not recipes', () => {
    const translated = [{ rows: [{ label: 'Durabilidad', value: '250' }] }];
    expect(pairRecipeSources(translated, english)).toEqual({});
  });
});
