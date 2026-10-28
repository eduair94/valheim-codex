import { describe, expect, it } from 'vitest';
import type { CategorySummary } from '@/lib/db/wiki-repo';
import {
  articleBiome,
  canonicalBiome,
  isMaintenanceCategory,
  mainCategories,
  mainStations,
  orderedBiomes,
  splitStationLevel,
} from '@/lib/wiki/browse-groups';

const group = (name: string, count: number): CategorySummary => ({ name, count, icon: null });

describe('orderedBiomes', () => {
  it('follows the game progression rather than the article count', () => {
    const ordered = orderedBiomes([
      group('Ashlands', 17),
      group('Black Forest', 13),
      group('Mistlands', 11),
      group('Meadows', 8),
    ]);

    expect(ordered.map((b) => b.name)).toEqual([
      'Meadows',
      'Black Forest',
      'Mistlands',
      'Ashlands',
    ]);
  });

  it('drops map features and dungeons, which would take a number in the ladder', () => {
    const ordered = orderedBiomes([
      group('Meadows', 8),
      group('Rivers', 1),
      group('Sealed tower', 1),
      group('Smouldering Tombs', 1),
    ]);
    expect(ordered.map((b) => b.name)).toEqual(['Meadows']);
  });

  it('drops compound values, which belong to no single rung', () => {
    const ordered = orderedBiomes([group('Meadows and Plains', 1), group('Plains', 8)]);
    expect(ordered.map((b) => b.name)).toEqual(['Plains']);
  });
});

describe('mainCategories', () => {
  it('drops the recipe categories, which the stations axis already answers', () => {
    const kept = mainCategories([
      group('Weapons', 158),
      group('Forge recipes', 50),
      group('Cooking recipes', 23),
    ]);
    expect(kept.map((c) => c.name)).toEqual(['Weapons']);
  });

  it('keeps the order it was given, which is largest first', () => {
    const kept = mainCategories([group('Materials', 165), group('Weapons', 158), group('Food', 79)]);
    expect(kept.map((c) => c.name)).toEqual(['Materials', 'Weapons', 'Food']);
  });

  it("drops the wiki's bookkeeping, which an older ingest stored as categories", () => {
    const kept = mainCategories([group('Weapons', 158), group('Unfinished', 10), group('Work in progress', 8)]);
    expect(kept.map((c) => c.name)).toEqual(['Weapons']);
  });
});

describe('isMaintenanceCategory', () => {
  it('knows every bookkeeping category the source lists, in any case', () => {
    for (const name of ['Unfinished', 'Stubs', 'Work in progress', 'Pages with broken file links', 'Candidates for deletion', 'Outdated', 'Disambiguations', 'Valheim Wiki']) {
      expect(isMaintenanceCategory(name)).toBe(true);
    }
    expect(isMaintenanceCategory(' unfinished ')).toBe(true);
    expect(isMaintenanceCategory('Weapons')).toBe(false);
    expect(isMaintenanceCategory('Tools')).toBe(false);
  });
});

describe('mainStations', () => {
  it('drops the levelled variants, which are the same bench upgraded', () => {
    const kept = mainStations([
      group('Cauldron', 27),
      group('Cauldron (level 3)', 3),
      group('Artisan table level 2', 1),
    ]);
    expect(kept.map((s) => s.name)).toEqual(['Cauldron']);
  });

  it('drops placeholder values that name no bench', () => {
    const kept = mainStations([
      group('Workbench', 94),
      group('n/a', 1),
      group('Crafting', 1),
      // Traders a stored row may still name, from before parser version 2.
      group('Hildir', 1),
      group('Haldor', 2),
    ]);
    expect(kept.map((s) => s.name)).toEqual(['Workbench']);
  });
});

describe('orderedBiomes, spellings', () => {
  it('makes "Mountain" and "Mountains" one rung, with their counts added', () => {
    const ordered = orderedBiomes([group('Mountains', 3), group('Meadows', 8), group('Mountain', 8)]);
    expect(ordered.map((b) => [b.name, b.count])).toEqual([
      ['Meadows', 8],
      ['Mountain', 11],
    ]);
  });
});

describe('canonicalBiome', () => {
  it('finds the biome a sentence names, as whole words', () => {
    expect(canonicalBiome('Fuling Village in the Plains biome.')).toBe('Plains');
    expect(canonicalBiome('Found in the Ashlands')).toBe('Ashlands');
    expect(canonicalBiome('Mountains')).toBe('Mountain');
    expect(canonicalBiome('meadows, black forest and plains')).toBe('Meadows');
  });

  it('does not read a biome into another word', () => {
    expect(canonicalBiome('Shorelines of rivers and oceans')).toBeNull();
    expect(canonicalBiome('Sealed tower')).toBeNull();
    expect(canonicalBiome('Swampy')).toBeNull();
    expect(canonicalBiome(null)).toBeNull();
  });
});

describe('articleBiome', () => {
  const none = { facet: null, location: null, source: null, craftable: false };

  it('prefers the facet, then Location, then Source', () => {
    expect(articleBiome({ ...none, facet: 'Swamp', location: 'Meadows' })).toBe('Swamp');
    expect(articleBiome({ ...none, location: 'Mistlands; Giant Remains', source: 'Plains' })).toBe('Mistlands');
    expect(articleBiome({ ...none, source: 'Found in the Ashlands' })).toBe('Ashlands');
  });

  it('reads past a facet that names no rung', () => {
    expect(articleBiome({ ...none, facet: 'Sealed tower', location: 'Plains' })).toBe('Plains');
  });

  it('ignores Source on something craftable, where it names a bench', () => {
    expect(articleBiome({ ...none, source: 'Forge in the Meadows', craftable: true })).toBeNull();
  });

  it('is null when nothing names a biome', () => {
    expect(articleBiome(none)).toBeNull();
  });
});

describe('splitStationLevel', () => {
  it('separates a bench from its level, in either spelling the wiki uses', () => {
    expect(splitStationLevel('Cauldron (level 3)')).toEqual({ base: 'Cauldron', level: 3 });
    expect(splitStationLevel('Artisan table level 2')).toEqual({ base: 'Artisan table', level: 2 });
    expect(splitStationLevel('Forge')).toEqual({ base: 'Forge', level: null });
  });
});
