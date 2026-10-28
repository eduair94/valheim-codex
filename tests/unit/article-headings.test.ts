import { describe, expect, it } from 'vitest';
import { headingTag, sectionHeadings } from '@/components/wiki/article/headings';

const blocks = (...sections: string[]) => sections.map((section) => ({ section }));

describe('sectionHeadings (BWR-08)', () => {
  it('opens a parent that has no text of its own', () => {
    // Ashlands: every block sits under a subsection.
    const out = sectionHeadings(blocks('Creatures > Hostile', 'Creatures > Passive', 'Resources > From terrain'));
    expect(out).toEqual([
      [
        { depth: 0, text: 'Creatures', english: false },
        { depth: 1, text: 'Hostile', english: false },
      ],
      [{ depth: 1, text: 'Passive', english: false }],
      [
        { depth: 0, text: 'Resources', english: false },
        { depth: 1, text: 'From terrain', english: false },
      ],
    ]);
  });

  it('keeps two subsections of the same name apart by their parents', () => {
    // Barley: "Farming" under Availability and again under Usage.
    const out = sectionHeadings(blocks('Availability > Farming', 'Usage > Farming'));
    expect(out[1]?.map((h) => [h.depth, h.text])).toEqual([
      [0, 'Usage'],
      [1, 'Farming'],
    ]);
  });

  it('opens nothing for blocks before the first heading, or when a path returns to its parent', () => {
    const out = sectionHeadings(blocks('', '', 'Attacks > Punch', 'Attacks'));
    expect(out[0]).toEqual([]);
    expect(out[1]).toEqual([]);
    expect(out[3]).toEqual([]);
  });

  it('decides the breaks from the English and takes the words from the translation', () => {
    // /wiki/a/death: one English section translated two ways in a row.
    const out = sectionHeadings(blocks('Lápida (Tombstone)', 'Lápida', 'Notas'), blocks('Tombstone', 'Tombstone', 'Notes'));
    expect(out.map((h) => h.map((x) => x.text))).toEqual([['Lápida (Tombstone)'], [], ['Notas']]);
  });

  it('falls back to the English words where the translated path does not line up', () => {
    const out = sectionHeadings(blocks('Usos y Granja'), blocks('Usage > Farming'));
    expect(out[0]).toEqual([
      { depth: 0, text: 'Usage', english: true },
      { depth: 1, text: 'Farming', english: true },
    ]);
  });

  it('uses the shown paths when the translation has a different number of blocks', () => {
    const out = sectionHeadings(blocks('Uso', 'Notas'), blocks('Usage'));
    expect(out.map((h) => h.map((x) => x.text))).toEqual([['Uso'], ['Notas']]);
  });
});

describe('headingTag', () => {
  it('maps depth to h2, h3 and h4, and never past h6', () => {
    expect([0, 1, 2, 9].map(headingTag)).toEqual(['h2', 'h3', 'h4', 'h6']);
  });
});
