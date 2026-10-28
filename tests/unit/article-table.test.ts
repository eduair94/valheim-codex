import { describe, expect, it } from 'vitest';
import { tableModel } from '@/components/wiki/article/table-model';
import type { TableBlock } from '@/lib/wiki/article-types';

function table(headers: string[], rows: string[][], extra: Partial<TableBlock> = {}): TableBlock {
  return { kind: 'table', section: '', caption: '', headers, rows, ...extra };
}

describe('tableModel — columns', () => {
  it('keeps quantities on one line and lets sentences wrap', () => {
    // Swords' "Properties" table (parser v1).
    const model = tableModel(
      table(
        ['Attack type', 'Stamina', 'Range', 'Attack speed', 'Notes'],
        [
          ['Swords (primary)', '1x', '2.4 m', '2.46 s (0.86 + 0.70 + 0.90)', 'Player moves forward 0.66 m with each swing. 90 degree arc. No multitarget penalty.'],
          ['Swords (secondary)', '2x', '2.7 m', '1.84 s', 'Player moves forward 0.33 m. 10 degree arc.'],
        ],
      ),
    );
    expect(model.columns.map((c) => c.kind)).toEqual(['short', 'number', 'number', 'text', 'long']);
  });

  it('reads ranges, percentages and units as quantities', () => {
    const model = tableModel(
      table(['Item', 'Chance', 'Coins', 'Weight'], [
        ['Troll trophy', '50%', '20-29', '2 kg'],
        ['Troll hide', '100%', '40–58', '0.8'],
      ]),
    );
    expect(model.columns.slice(1).map((c) => c.kind)).toEqual(['number', 'number', 'number']);
  });

  it('judges a multi-line cell by its longest line', () => {
    // Iron Sword's crafting row: three short entries, one per line.
    const model = tableModel(
      table(['Quality', '1', '2'], [
        ['Slash', '55', '61'],
        ['Crafting', '2 Wood\n20 Iron\n3 Leather scraps', '1 Wood\n10 Iron\n2 Leather scraps'],
      ]),
    );
    expect(model.columns[1]?.kind).toBe('short');
  });

  it('drops columns that are empty in every row, including an empty first one', () => {
    // An older row: an icon column the parser could not read, first.
    const model = tableModel(
      table(['Icon', 'Name', 'Materials', ''], [
        ['', 'Forge cooler', '25 Finewood 10 Copper', ''],
        ['', 'Anvils', '5 Wood 2 Bronze', ''],
      ]),
    );
    expect(model.columns.map((c) => c.label)).toEqual(['Name', 'Materials']);
    expect(model.rows[0]).toEqual({ kind: 'row', cells: ['Forge cooler', '25 Finewood 10 Copper'] });
  });

  it('never shows a heading an older parser invented', () => {
    const model = tableModel(table(['Column 1', 'Column 2'], [['Meadows', 'Yes']]));
    expect(model.columns.map((c) => c.label)).toEqual(['', '']);
    expect(model.hasHeader).toBe(false);
  });

  it('has no header row when the table states none', () => {
    // Birch's "Allowed Biomes" (parser v1: headers []).
    const model = tableModel(table([], [['Meadows', 'Yes'], ['Swamp', 'No']], { caption: ' Allowed Biomes: ' }));
    expect(model.hasHeader).toBe(false);
    expect(model.caption).toBe('Allowed Biomes:');
    expect(model.rows).toHaveLength(2);
  });

  it('puts a heading too long for the label column on its own line in a phone card', () => {
    const model = tableModel(
      table(['Bow', 'Puñalada por la espalda', 'Ruido de ataque', 'Dispersión'], [['Arco de cuerno', '3x', '15 m', '50 m/s']]),
    );
    expect(model.columns.map((c) => c.wideLabel)).toEqual([false, true, true, false]);
  });
});

describe('tableModel — row headings (LD-01)', () => {
  it('pins short row headings', () => {
    const model = tableModel(table(['Item', '0 Star'], [['Deathsquito trophy', '5%'], ['Needle', '1']]));
    expect(model.stickyFirst).toBe(true);
  });

  it('never pins a column of sentences, which would cover the rest of the table', () => {
    const inscription = 'Here lies the warrior who '.repeat(40);
    const model = tableModel(table(['Description', 'Biome', 'Notes'], [[inscription, 'Meadows', 'Near spawn']]));
    expect(model.stickyFirst).toBe(false);
    expect(model.columns[0]?.kind).toBe('long');
  });

  it('pins nothing in a one-column table', () => {
    expect(tableModel(table(['Line'], [['Welcome']])).stickyFirst).toBe(false);
  });
});

describe('tableModel — group rows', () => {
  it('takes the marked rows as full-width sub-headings', () => {
    // Swords' list (parser v1): "One-handed" and "Two-handed" head their rows.
    const model = tableModel(
      table(
        ['Name', 'Damage', 'Stamina (primary)'],
        [
          ['One-handed', '', ''],
          ['Bronze sword', 'Slash: 35/53', '8'],
          ['Two-handed', '', ''],
          ['Krom', 'Slash: 120/160', '20'],
        ],
        { groupRows: [0, 2] },
      ),
    );
    expect(model.rows.map((r) => r.kind)).toEqual(['group', 'row', 'group', 'row']);
    expect(model.rows[0]).toEqual({ kind: 'group', text: 'One-handed' });
  });

  it('keeps an unmarked lone name as a row whose values are unknown', () => {
    // Parser v1 marks group rows; an unmarked one is data.
    const model = tableModel(table(['Biome', 'Spawns', 'Notes'], [['Swamp', '', ''], ['Plains', 'Yes', 'At night']], { groupRows: [] }));
    expect(model.rows[0]?.kind).toBe('row');
  });

  it('recognises an older row that announces what follows', () => {
    const model = tableModel(
      table(['Amount', 'Item', 'Chance'], [
        ['10 of the following:', '', ''],
        ['1', 'Wood', '50%'],
      ]),
    );
    expect(model.rows[0]).toEqual({ kind: 'group', text: '10 of the following:' });
    // The group row's text does not keep an otherwise empty column alive.
    expect(model.columns).toHaveLength(3);
  });

  it('judges columns by their data rows only', () => {
    const model = tableModel(
      table(['Amount', 'Item'], [
        ['50% chance to drop between X and 2 of:', ''],
        ['1', 'Wood'],
      ], { groupRows: [0] }),
    );
    expect(model.columns[0]?.kind).toBe('number');
  });
});

describe('tableModel — older rows and phone labels', () => {
  it('judges a run-together cell of quantities by its repaired lines', () => {
    const model = tableModel(
      table(['Name', 'Materials'], [['Forge cooler', '25 Finewood10 Copper'], ['Anvils', '5 Wood2 Bronze']]),
    );
    expect(model.columns[1]?.kind).toBe('short');
  });

  it('gives one-word labels a narrow column on a phone card', () => {
    expect(tableModel(table(['Quality', '1', '2', 'Total'], [['Slash', '55', '61', '']])).shortLabels).toBe(true);
    expect(tableModel(table(['Item', 'Chance', 'Average per Tree'], [['Wood', '50%', '10']])).shortLabels).toBe(false);
    expect(tableModel(table([], [['Meadows', 'Yes']])).shortLabels).toBe(false);
  });
});
