import { describe, expect, it } from 'vitest';
import type { CraftRef, CraftUse, CraftView } from '@/lib/craft/data';
import { groupUses, USES_SHOWN } from '@/components/wiki/craft/used-in-model';

/*
 * "Usado en" on a material's article (`used-in-model.ts`): the groups by
 * station, each showing its first six uses and keeping the rest for a
 * `<details>`, as Wood's 84 uses at the Workbench need.
 */

const ref = (id: string): CraftRef => ({ id, name: id, en: id, slug: id.toLowerCase(), anchor: null, icon: null });

function use(id: string, station: CraftRef | null): CraftUse {
  return {
    ...ref(id),
    quality: 1,
    qty: 1,
    method: 'craft',
    station,
    stationLevel: 1,
    yield: 1,
    yieldKnown: true,
    ownPage: true,
    inputs: [{ ...ref('Wood'), qty: 1 }],
  };
}

function group(station: CraftRef | null, count: number, prefix: string): CraftView['usedIn'][number] {
  return { station, items: Array.from({ length: count }, (_, i) => use(`${prefix}${i + 1}`, station)) };
}

describe('groupUses', () => {
  it('shows the first six uses of a group and keeps the rest behind its toggle', () => {
    const [wood] = groupUses([group(ref('Workbench'), 84, 'Piece')]);
    // Two full rows of the desktop's three columns, three of its two beside the stats.
    expect(USES_SHOWN).toBe(6);
    expect(wood!.shown).toHaveLength(6);
    expect(wood!.hidden).toHaveLength(78);
    expect(wood!.shown.map((u) => u.id)).toEqual(['Piece1', 'Piece2', 'Piece3', 'Piece4', 'Piece5', 'Piece6']);
    expect(wood!.hidden[0]!.id).toBe('Piece7');
  });

  it('hides nothing in a group of six or fewer', () => {
    const [forge] = groupUses([group(ref('Forge'), 6, 'Sword')]);
    expect(forge!.shown).toHaveLength(6);
    expect(forge!.hidden).toEqual([]);
  });

  it('never keeps a single use behind a toggle: the toggle would take its room to hide it', () => {
    const [seven] = groupUses([group(ref('Workbench'), 7, 'W')]);
    expect(seven!.shown).toHaveLength(7);
    expect(seven!.hidden).toEqual([]);
    const [eight] = groupUses([group(ref('Workbench'), 8, 'W')]);
    expect([eight!.shown.length, eight!.hidden.length]).toEqual([6, 2]);
  });

  it('keeps the groups in the order the view gives, by hand last', () => {
    const groups = groupUses([group(ref('Forge'), 3, 'F'), group(ref('Workbench'), 12, 'W'), group(null, 20, 'H')]);
    expect(groups.map((g) => [g.station?.id ?? null, g.shown.length, g.hidden.length])).toEqual([
      ['Forge', 3, 0],
      ['Workbench', 6, 6],
      [null, 6, 14],
    ]);
  });

  it('takes how many to show', () => {
    expect(groupUses([group(ref('Forge'), 5, 'F')], 2).map((g) => [g.shown.length, g.hidden.length])).toEqual([[2, 3]]);
  });

  it('is nothing for a material that goes into nothing', () => {
    expect(groupUses([])).toEqual([]);
    expect(groupUses([{ station: ref('Forge'), items: [] }])).toEqual([]);
  });
});
