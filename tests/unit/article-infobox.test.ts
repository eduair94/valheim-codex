import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractArticle } from '@/lib/wiki/article';
import {
  articleLayout,
  bodyUnits,
  infoboxUnits,
  mergeGroups,
  starCount,
  statLayout,
  tabSetKind,
  usefulTabs,
  valueLines,
} from '@/components/wiki/article/infobox-model';

describe('statLayout (LM-01)', () => {
  it('keeps a short value beside its label', () => {
    expect(statLayout('Durabilidad', '200')).toBe('inline');
    expect(statLayout('Velocidad de ataque', '1.84 s')).toBe('inline');
  });

  it('puts a value too wide for its column under the label', () => {
    // 27 monospaced characters do not fit in 60% of a phone's row.
    expect(statLayout('Velocidad de ataque', '2.46 s (0.86 + 0.70 + 0.90)')).toBe('stacked');
  });

  it('keeps a short value beside even a very long label, which then wraps', () => {
    // The row that hid its "No" on every phone.
    expect(statLayout('Teletransportable (¿Puede pasar por un portal de madera?)', 'No')).toBe('inline');
  });

  it('puts a sentence under its label', () => {
    expect(statLayout('Descripción', 'La línea recta entre la vida y la muerte corre a lo largo del filo de esta hoja.')).toBe(
      'stacked',
    );
  });

  it('weighs the label and the value together', () => {
    expect(statLayout('Teletransportable (¿Puede pasar por un portal de madera?)', 'Sí, salvo en barco')).toBe('stacked');
  });

  it('keeps a few short lines beside their label, and a list under it', () => {
    expect(statLayout('Block armor', '21 (0 skill)\n31.5 (100 skill)')).toBe('inline');
    expect(statLayout('Armadura de bloqueo', '21 (habilidad 0)\n31.5 (habilidad 100)')).toBe('stacked');
    expect(statLayout('Drops', 'Coins\nTroll hide\nTroll trophy\nTroll hide')).toBe('stacked');
    expect(statLayout('Improvements', 'Forge bellows\nAnvils\nGrinding wheel')).toBe('inline');
    expect(statLayout('Abilities', 'Unarmed:\nPunch (4s)\nGround slam (20s)\nThrow (10s)')).toBe('stacked');
  });

  it('reads a value line by line, ignoring blank lines', () => {
    expect(valueLines(' Fire \n\nFrost')).toEqual(['Fire', 'Frost']);
  });
});

describe('tabSetKind (BWR-11 / LD-20)', () => {
  it('calls numbered tabs upgrade levels', () => {
    expect(tabSetKind(['1', '2', '3', '4'])).toBe('levels');
  });

  it("calls a creature's star tabs star levels, trophy and all", () => {
    expect(tabSetKind(['0★', '1★', '2★', 'Trophy'])).toBe('stars');
    expect(tabSetKind(['0★', 'Trophy'])).toBe('stars');
    expect(tabSetKind(['0 Star', '1 Star'])).toBe('stars');
  });

  it('calls anything else variants', () => {
    expect(tabSetKind(['Raw', 'Cooked'])).toBe('variants');
    expect(tabSetKind(['Icon', 'Large'])).toBe('variants');
  });

  it('reads the star count from a star tab and nothing else', () => {
    expect(['0★', '2 ★', '1 Star', 'Trophy', '10'].map(starCount)).toEqual([0, 2, 1, null, null]);
  });
});

describe('usefulTabs', () => {
  it('drops tabs that hold no rows', () => {
    const tabs = usefulTabs([
      { label: 'Icon', groups: [{ label: '', rows: [] }] },
      { label: 'Large', groups: [] },
      { label: '1', groups: [{ label: 'Properties', rows: [{ label: 'Weight', value: '1' }] }] },
    ]);
    expect(tabs.map((t) => t.label)).toEqual(['1']);
  });
});

describe('mergeGroups', () => {
  it('joins consecutive groups with the same heading and skips empty ones', () => {
    const merged = mergeGroups([
      { label: 'Properties', rows: [{ label: 'Weight', value: '0.8' }] },
      { label: 'Properties', rows: [{ label: 'Durability', value: '200' }] },
      { label: 'Primary attack', rows: [] },
      { label: '', rows: [{ label: 'Block force', value: '20' }] },
    ]);
    expect(merged.map((g) => [g.label, g.rows.length])).toEqual([
      ['Properties', 2],
      ['', 1],
    ]);
  });

  it('never changes the groups it was given', () => {
    const source = [
      { label: 'A', rows: [{ label: 'x', value: '1' }] },
      { label: 'A', rows: [{ label: 'y', value: '2' }] },
    ];
    mergeGroups(source);
    expect(source[0]?.rows).toHaveLength(1);
  });
});

describe('articleLayout', () => {
  async function fixture(name: string) {
    const raw = await readFile(`tests/fixtures/${name}.json`, 'utf8');
    return extractArticle((JSON.parse(raw) as { parse: { text: string } }).parse.text);
  }

  it('spreads a tall infobox over a short text, and keeps it beside a long one', async () => {
    const sword = await fixture('Iron_Sword');
    const troll = await fixture('Troll');
    expect(articleLayout(sword, sword.infobox)).toBe('spread');
    expect(articleLayout(troll, troll.infobox)).toBe('side');
  });

  it('keeps a small infobox beside the text however short the text is', async () => {
    const burning = await fixture('Burning');
    expect(infoboxUnits(burning.infobox!)).toBeLessThan(bodyUnits(burning));
    expect(articleLayout({ ...burning, blocks: [] }, burning.infobox)).toBe('side');
  });

  it('gives the text the whole width when there is no infobox', async () => {
    const swords = await fixture('Swords');
    expect(articleLayout(swords, null)).toBe('single');
  });
});
