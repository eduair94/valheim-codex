import { describe, expect, it } from 'vitest';
import {
  applyStrings,
  extractStrings,
  isIdentifierRow,
  worthTranslating,
  type Extraction,
} from '@/lib/wiki/translate';
import type { ArticleDoc } from '@/lib/wiki/article-types';

/**
 * The translator hands a model a list of strings, never the document, so that
 * the shape of the page stays in this file's hands rather than the model's.
 * These tests are that guarantee: every string reachable, every string put
 * back where it came from, and nothing numeric sent at all.
 *
 * They need no model, which is the point — the failure they guard against is a
 * silently smaller article, and that has to be impossible by construction
 * rather than unlikely in practice.
 */

const doc: ArticleDoc = {
  lead: 'The iron sword is the second sword.',
  blocks: [
    { kind: 'paragraph', section: 'Usage', text: 'Primary attack is a 3-hit combo.' },
    { kind: 'list', section: 'Notes', ordered: false, items: ['Cannot be repaired in the field', '20'] },
    {
      kind: 'table',
      section: 'Upgrade information',
      caption: 'Crafting costs',
      headers: ['Level', 'Wood', 'Iron'],
      rows: [
        ['1', '2', '20'],
        ['2', '1', '10'],
      ],
    },
  ],
  infobox: {
    title: 'Iron Sword',
    image: { url: 'https://example.test/sword.png', alt: 'Iron Sword' },
    common: [
      {
        label: 'Properties',
        rows: [
          { label: 'Description', value: 'The straight line between life and death.' },
          { label: 'Internal ID', value: 'SwordIron' },
          { label: 'Weight', value: '1.0' },
        ],
      },
    ],
    tabs: [
      {
        label: '1',
        groups: [{ label: 'Stats', rows: [{ label: 'Durability', value: '200' }] }],
      },
    ],
  },
  images: [{ url: 'https://example.test/a.png', alt: 'screenshot' }],
  facets: { biome: 'Swamp' },
};

describe('what gets sent to the model', () => {
  it.each([
    ['20', false],
    ['1.0', false],
    ['35%', false],
    ['1.5', false],
    ['SwordIron', true],
    ['', false],
    ['   ', false],
    ['Iron Sword', true],
    ['The straight line between life and death.', true],
    ['Level', true],
  ])('%s -> translatable: %s', (value, expected) => {
    // `SwordIron` is translatable by shape and must not be translated in fact:
    // it reads as two English words, so it is the row's label that saves it.
    expect(worthTranslating(value)).toBe(expected);
  });

  it.each([
    ['Internal ID', true],
    ['ID', true],
    ['Prefab', true],
    ['Description', false],
    ['Weight', false],
  ])('label %s marks an identifier row: %s', (label, expected) => {
    expect(isIdentifierRow(label)).toBe(expected);
  });

  it('leaves numbers, IDs and image data out entirely', () => {
    const { strings } = extractStrings(doc, 'Iron Sword');

    // A crafting cost that comes back as "veinte" is worse than one in English.
    expect(strings).not.toContain('20');
    expect(strings).not.toContain('1.0');
    expect(strings).not.toContain('SwordIron');
    expect(strings.some((s) => s.includes('example.test'))).toBe(false);
  });

  it('reaches every piece of prose, including inside tables and tabs', () => {
    const { strings } = extractStrings(doc, 'Iron Sword');

    expect(strings).toContain('Iron Sword');
    expect(strings).toContain('The iron sword is the second sword.');
    expect(strings).toContain('Primary attack is a 3-hit combo.');
    expect(strings).toContain('Cannot be repaired in the field');
    expect(strings).toContain('Crafting costs');
    expect(strings).toContain('Level');
    expect(strings).toContain('Description');
    expect(strings).toContain('Durability');
  });
});

describe('putting the translation back', () => {
  /** Marks each string so a value landing in the wrong slot is visible. */
  function translateAll(extraction: Extraction): string[] {
    return extraction.strings.map((s) => `ES:${s}`);
  }

  it('puts every string back where it came from', () => {
    const extraction = extractStrings(doc, 'Iron Sword');
    const { doc: out, title } = applyStrings(doc, 'Iron Sword', extraction, translateAll(extraction));

    expect(title).toBe('ES:Iron Sword');
    expect(out.lead).toBe('ES:The iron sword is the second sword.');

    const table = out.blocks[2];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.caption).toBe('ES:Crafting costs');
    expect(table.headers).toEqual(['ES:Level', 'ES:Wood', 'ES:Iron']);

    expect(out.infobox?.common[0]?.rows[0]?.label).toBe('ES:Description');
    expect(out.infobox?.tabs[0]?.groups[0]?.rows[0]?.label).toBe('ES:Durability');
  });

  it('keeps the structure identical', () => {
    const extraction = extractStrings(doc, 'Iron Sword');
    const { doc: out } = applyStrings(doc, 'Iron Sword', extraction, translateAll(extraction));

    // The failure this guards against is a translation that renders fine and
    // is quietly missing a row the wiki had.
    expect(out.blocks).toHaveLength(doc.blocks.length);
    const before = doc.blocks[2];
    const after = out.blocks[2];
    if (before?.kind !== 'table' || after?.kind !== 'table') throw new Error('expected tables');
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.rows[0]).toHaveLength(before.rows[0]!.length);
    expect(out.infobox?.tabs).toHaveLength(doc.infobox!.tabs.length);
  });

  it('leaves numbers untouched, because it never had them', () => {
    const extraction = extractStrings(doc, 'Iron Sword');
    const { doc: out } = applyStrings(doc, 'Iron Sword', extraction, translateAll(extraction));

    const table = out.blocks[2];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.rows).toEqual([
      ['1', '2', '20'],
      ['2', '1', '10'],
    ]);
    expect(out.infobox?.common[0]?.rows[1]?.value).toBe('SwordIron');
    expect(out.infobox?.common[0]?.rows[2]?.value).toBe('1.0');
  });

  it('does not touch the document it was given', () => {
    // The English document is shared and cached; mutating it would poison
    // every later reader of that object.
    const extraction = extractStrings(doc, 'Iron Sword');
    applyStrings(doc, 'Iron Sword', extraction, translateAll(extraction));

    expect(doc.lead).toBe('The iron sword is the second sword.');
  });

  it('keeps English for any string the model failed to return', () => {
    const extraction = extractStrings(doc, 'Iron Sword');
    // A batch that failed leaves its inputs untouched in the array.
    const partial = extraction.strings.map((s, i) => (i === 1 ? '' : `ES:${s}`));
    const { doc: out } = applyStrings(doc, 'Iron Sword', extraction, partial);

    expect(out.lead).toBe('The iron sword is the second sword.');
  });
});
