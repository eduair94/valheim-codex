import { describe, expect, it } from 'vitest';
import type { CategorySummary } from '@/lib/db/wiki-repo';
import { mainCategories, orderedBiomes, mainStations } from '@/lib/wiki/browse-groups';

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
    const kept = mainCategories(
      [group('Weapons', 158), group('Forge recipes', 50), group('Cooking recipes', 23)],
      10,
    );
    expect(kept.map((c) => c.name)).toEqual(['Weapons']);
  });

  it('takes the largest groups first, up to the limit', () => {
    const kept = mainCategories(
      [group('Materials', 165), group('Weapons', 158), group('Food', 79)],
      2,
    );
    expect(kept.map((c) => c.name)).toEqual(['Materials', 'Weapons']);
  });
});

describe('mainStations', () => {
  it('drops the levelled variants, which are the same bench upgraded', () => {
    const kept = mainStations(
      [group('Cauldron', 27), group('Cauldron (level 3)', 3), group('Artisan table level 2', 1)],
      10,
    );
    expect(kept.map((s) => s.name)).toEqual(['Cauldron']);
  });

  it('drops placeholder values that name no bench', () => {
    const kept = mainStations([group('Workbench', 94), group('n/a', 1), group('Crafting', 1)], 10);
    expect(kept.map((s) => s.name)).toEqual(['Workbench']);
  });
});
