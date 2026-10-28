import { describe, expect, it } from 'vitest';
import { compactIcon, expandIcon, fold, prepareTitleIndex, searchTitles } from '@/lib/wiki/title-search';
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
    // 20 keystrokes over a corpus larger than the real one, best of three
    // runs so a busy machine measures the code rather than the neighbours.
    expect(fastest(3, () => {
      for (let i = 0; i < 20; i += 1) searchTitles(big, 'article');
    })).toBeLessThan(250);
  });
});

/** The quickest of `runs` timings of `work`, in milliseconds. */
function fastest(runs: number, work: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * The index as the search downloads it: Spanish names (`e`) from the stored
 * translations or the vocabulary, and the other names readers use (`a`).
 */
const BILINGUAL: TitleIndexEntry[] = [
  { s: 'iron', t: 'Iron', e: 'Hierro', c: ['Materials', 'Metals'], y: 'Metal' },
  { s: 'iron-sword', t: 'Iron Sword', e: 'Espada de hierro', c: ['Weapons', 'Swords'], y: 'Sword' },
  { s: 'surtling-core', t: 'Surtling Core', e: 'Núcleo de Surtling', c: ['Materials'] },
  { s: 'surtling', t: 'Surtling', c: ['Creatures'] },
  { s: 'boar', t: 'Boar', e: 'Jabalí', c: ['Creatures'] },
  { s: 'boar-meat', t: 'Boar Meat', e: 'Carne de jabalí', c: ['Food'] },
  { s: 'deer', t: 'Deer', e: 'Ciervo', c: ['Creatures'] },
  { s: 'workbench', t: 'Workbench', e: 'Banco de trabajo', a: ['Mesa de trabajo'], c: ['Crafting structures'] },
  { s: 'black-forest', t: 'Black Forest', e: 'Bosque negro', a: ['Selva negra'], c: ['Biomes'] },
  { s: 'trophies', t: 'Trophies', e: 'Trofeos', c: ['Items'] },
  { s: 'bows', t: 'Bows', e: 'Arcos', c: ['Weapons', 'Bows'] },
  { s: 'charcoal-kiln', t: 'Charcoal Kiln', e: 'Horno de carbón', c: ['Crafting structures'] },
  { s: 'smelter', t: 'Smelter', e: 'Fundidora', c: ['Crafting structures'] },
  { s: 'greydwarf', t: 'Greydwarf', c: ['Creatures'] },
  { s: 'bonemass', t: 'Bonemass', c: ['Creatures', 'Bosses'] },
  { s: 'mistlands', t: 'Mistlands', e: 'Tierras brumosas', a: ['Tierras de la niebla'], c: ['Biomes'] },
];
const PREPARED = prepareTitleIndex(BILINGUAL);
const found = (q: string): string[] => searchTitles(PREPARED, q).map((m) => m.entry.s);

describe('searchTitles, bilingual', () => {
  it.each([
    ['hierro', 'iron'],
    ['espada de hierro', 'iron-sword'],
    ['Espada De Hierro', 'iron-sword'],
    ['nucleo de surtling', 'surtling-core'],
    ['núcleo de surtling', 'surtling-core'],
    ['jabali', 'boar'],
    ['jabalí', 'boar'],
    ['carne de jabali', 'boar-meat'],
    ['banco de trabajo', 'workbench'],
    ['mesa de trabajo', 'workbench'],
    ['selva negra', 'black-forest'],
    ['tierras de la niebla', 'mistlands'],
    ['bonemass', 'bonemass'],
    ['Bonemass', 'bonemass'],
    ['iron sword', 'iron-sword'],
    ['surtling', 'surtling'],
  ])('puts the intended article first for %j', (query, slug) => {
    expect(found(query)[0]).toBe(slug);
  });

  it('drops articles and prepositions between real words, so "de" does not have to match', () => {
    const results = found('espada de hierro');
    expect(results).toContain('iron-sword');
    // And still offers the material itself, below the sword.
    expect(results.indexOf('iron')).toBeGreaterThan(results.indexOf('iron-sword'));
  });

  it('keeps a lone stop word, which is how a name starts being typed', () => {
    expect(found('de')).toContain('deer');
  });

  it('accepts a plural the title does not have, and the reverse', () => {
    expect(found('trophy')).toContain('trophies');
    expect(found('trofeo')).toContain('trophies');
    expect(found('arco')[0]).toBe('bows');
  });

  it('keeps matching inside an English title, below every word-start match', () => {
    expect(found('dwarf')).toContain('greydwarf');
    expect(found('mass')).toContain('bonemass');
    // "arco" is inside "Charcoal": still found, but after Arcos.
    expect(found('arco').indexOf('charcoal-kiln')).toBeGreaterThan(found('arco').indexOf('bows'));
  });

  it('reads the query through the glossary for articles that only match in English', () => {
    // "horno" is a kiln or a smelter.
    expect(found('horno')).toEqual(expect.arrayContaining(['smelter', 'charcoal-kiln']));
  });

  it('falls back to Spanish category names', () => {
    expect(found('armas')).toEqual(expect.arrayContaining(['iron-sword', 'bows']));
  });

  describe('a glossary reading matches whole words of the English title only', () => {
    // The reader typed the Spanish word; the English one is not half-typed.
    const NEIGHBOURS: TitleIndexEntry[] = [
      { s: 'bat', t: 'Bat', e: 'Murciélago', c: ['Creatures'] },
      { s: 'battleaxe', t: 'Battleaxe', e: 'Hacha de batalla', c: ['Weapons'] },
      { s: 'battering-ram', t: 'Battering Ram', e: 'Ariete', c: ['Siege'] },
      { s: 'muckshake', t: 'Muckshake', e: 'Batido de cieno', c: ['Food'] },
      { s: 'queen-bee', t: 'Queen Bee', e: 'Abeja reina', c: ['Materials'] },
      { s: 'beech', t: 'Beech', e: 'Haya', c: ['Trees'] },
      { s: 'raft', t: 'Raft', e: 'Balsa', c: ['Transport'] },
      { s: 'crafting', t: 'Crafting', e: 'Fabricación', c: ['Game mechanics'] },
      { s: 'dvergr-lighthouse', t: 'Dvergr Lighthouse', e: 'Faro dvergr', c: ['Structures'] },
      { s: 'boards', t: 'Rolling Pins and Cutting Boards', c: ['Furniture'] },
      { s: 'boar', t: 'Boar', e: 'Jabalí', c: ['Creatures'] },
      { s: 'bees', t: 'Bees', c: ['Creatures'] },
    ];
    const near = prepareTitleIndex(NEIGHBOURS);
    const hits = (q: string) => searchTitles(near, q).map((m) => m.entry.s);

    it.each([
      ['murcielago', ['bat'], ['battleaxe', 'battering-ram', 'muckshake']],
      ['abeja', ['queen-bee', 'bees'], ['beech']],
      ['balsa', ['raft'], ['crafting']],
      ['casa', [], ['dvergr-lighthouse']],
      ['cerdo', ['boar'], ['boards']],
    ])('%j finds %j and not %j', (query, wanted, unwanted) => {
      const results = hits(query);
      for (const slug of wanted) expect(results).toContain(slug);
      for (const slug of unwanted) expect(results).not.toContain(slug);
    });

    it('keeps the prefix for what was typed', () => {
      expect(hits('bat')).toEqual(expect.arrayContaining(['bat', 'battleaxe', 'battering-ram', 'muckshake']));
      expect(hits('murci')).toEqual(['bat']);
    });
  });

  describe('a query that mixes the names, or says them as the translations do', () => {
    // As the index has them: the Greydwarf has no Spanish name, its eye and
    // its nest have two different ones, and the hides are "cuero".
    const MIXED: TitleIndexEntry[] = [
      { s: 'greydwarf', t: 'Greydwarf', c: ['Creatures'] },
      { s: 'greydwarf-eye', t: 'Greydwarf Eye', e: 'Ojo de trasgo gris', c: ['Materials'] },
      { s: 'greydwarf-nest', t: 'Greydwarf Nest', e: 'Nido de enano gris', c: ['Points of interest'] },
      { s: 'troll', t: 'Troll', c: ['Creatures'] },
      { s: 'troll-hide', t: 'Troll Hide', e: 'Cuero de trol', c: ['Materials'] },
      { s: 'deer', t: 'Deer', e: 'Ciervo', c: ['Creatures'] },
      { s: 'deer-hide', t: 'Deer Hide', e: 'Cuero de ciervo', c: ['Materials'] },
      { s: 'leather-scraps', t: 'Leather Scraps', e: 'Recortes de cuero', c: ['Materials'] },
      { s: 'giant-remains', t: 'Giant Remains', e: 'Restos de gigante', c: ['Materials'] },
    ];
    const mixed = prepareTitleIndex(MIXED);
    const hits = (q: string) => searchTitles(mixed, q).map((m) => m.entry.s);

    it.each([
      // Half the Spanish name, half the English one.
      ['ojo de greydwarf', 'greydwarf-eye'],
      ['nido de greydwarf', 'greydwarf-nest'],
      ['cuero de troll', 'troll-hide'],
      // The translations' own words, through the glossary.
      ['ojo de enano gris', 'greydwarf-eye'],
      ['piel de ciervo', 'deer-hide'],
      ['piel de troll', 'troll-hide'],
      ['piel de trol', 'troll-hide'],
      ['retazos de cuero', 'leather-scraps'],
      ['restos de cuero', 'leather-scraps'],
    ])('puts the thing first for %j, which is what Enter opens', (query, slug) => {
      expect(hits(query)[0]).toBe(slug);
    });

    it('still offers the creature a name contains, below the thing itself', () => {
      const results = hits('ojo de greydwarf');
      expect(results.indexOf('greydwarf')).toBeGreaterThan(results.indexOf('greydwarf-eye'));
    });

    it('needs every word in one of the names: one word of each is not a match', () => {
      // "ojo" is only in the eye's name, "nido" only in the nest's.
      expect(hits('ojo nido')).toEqual([]);
      // And "restos" alone is the giant's remains, not the leather scraps.
      expect(hits('restos')).toEqual(['giant-remains']);
    });

    it('ranks one name holding every word above two names sharing them', () => {
      const score = (q: string) => searchTitles(mixed, q).find((m) => m.entry.s === 'greydwarf-eye')!.score;
      expect(score('eye greydwarf')).toBeGreaterThan(score('ojo de greydwarf'));
    });
  });

  it('gives the same answer from the raw index and from a prepared one', () => {
    expect(searchTitles(BILINGUAL, 'espada')).toEqual(searchTitles(PREPARED, 'espada'));
  });

  it('stays fast enough to run on every keystroke once prepared', () => {
    const big = prepareTitleIndex(
      Array.from({ length: 1200 }, (_, i) => ({
        s: `a-${i}`,
        t: `Article number ${i}`,
        e: `Artículo número ${i}`,
        c: ['Materials', 'Weapons'],
        y: 'Material',
      })),
    );
    // Typing a word letter by letter, three times over, best of three runs.
    expect(fastest(3, () => {
      for (const q of ['a', 'ar', 'art', 'arti', 'articulo', 'articulo de', 'articulo de numero', 'hierro']) {
        for (let i = 0; i < 3; i += 1) searchTitles(big, q);
      }
    })).toBeLessThan(250);
  });
});

describe('icon paths', () => {
  const url =
    'https://static.wikia.nocookie.net/valheim/images/b/b6/Black_Metal_Axe.png/revision/latest?cb=20210215131319';

  it('sends a Fandom icon as a path, and rebuilds the same URL', () => {
    expect(compactIcon(url)).toBe('b/b6/Black_Metal_Axe.png?cb=20210215131319');
    expect(expandIcon(compactIcon(url)!)).toBe(url);
  });

  it('drops a stored size, which the page asks for itself', () => {
    const scaled =
      'https://static.wikia.nocookie.net/valheim/images/5/52/Biome_meadows.png/revision/latest/scale-to-width-down/268?cb=20210215131217';
    expect(compactIcon(scaled)).toBe('5/52/Biome_meadows.png?cb=20210215131217');
    expect(expandIcon('5/52/Biome_meadows.png?cb=20210215131217')).toBe(
      'https://static.wikia.nocookie.net/valheim/images/5/52/Biome_meadows.png/revision/latest?cb=20210215131217',
    );
  });

  it('leaves out a picture that is not one, and passes full URLs through', () => {
    expect(compactIcon('https://services.fandom.com/mathoid-facade/v1/media/math/render/svg/9a4e')).toBeNull();
    expect(expandIcon(url)).toBe(url);
  });
});
