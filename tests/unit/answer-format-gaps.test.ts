import { describe, expect, it } from 'vitest';
import { parseAnswer, parseInline } from '@/lib/answer-format';

/**
 * Markdown the models write although the prompt never asks for it. Each of
 * these rendered as literal punctuation in a real answer shape: a heading run
 * into the next sentence, a citation stuck inside bold text, a citation list,
 * a lenticular image marker, an image marker mid-sentence.
 */

describe('headings', () => {
  it('keeps a heading on its own line instead of merging it into the next paragraph', () => {
    const blocks = parseAnswer('### Materiales\nNecesitás hierro [1].');
    expect(blocks).toEqual([
      { type: 'heading', level: 3, segments: [{ type: 'text', text: 'Materiales' }] },
      {
        type: 'paragraph',
        segments: [
          { type: 'text', text: 'Necesitás hierro ' },
          { type: 'citation', n: 1 },
          { type: 'text', text: '.' },
        ],
      },
    ]);
  });

  it('reads every level and drops closing hashes', () => {
    expect(parseAnswer('# Uno')[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(parseAnswer('###### Seis ##')[0]).toEqual({
      type: 'heading',
      level: 6,
      segments: [{ type: 'text', text: 'Seis' }],
    });
  });

  it('keeps citations inside a heading', () => {
    expect(parseAnswer('## Bonemass [2]')[0]).toEqual({
      type: 'heading',
      level: 2,
      segments: [
        { type: 'text', text: 'Bonemass ' },
        { type: 'citation', n: 2 },
      ],
    });
  });

  it('ends a list when a heading follows it', () => {
    expect(parseAnswer('- uno\n- dos\n## Después').map((b) => b.type)).toEqual(['bullets', 'heading']);
  });

  it('does not take a hashtag or a number sign for a heading', () => {
    expect(parseAnswer('#hierro es la etiqueta')[0]?.type).toBe('paragraph');
  });
});

describe('citations inside bold', () => {
  it('pulls the marker out as a chip and keeps the rest bold', () => {
    expect(parseInline('**Espada de hierro [1]**')).toEqual([
      { type: 'bold', text: 'Espada de hierro ' },
      { type: 'citation', n: 1 },
    ]);
  });

  it('handles a marker between two bold words', () => {
    expect(parseInline('**Hierro [2] y cobre**')).toEqual([
      { type: 'bold', text: 'Hierro ' },
      { type: 'citation', n: 2 },
      { type: 'bold', text: ' y cobre' },
    ]);
  });
});

describe('citation lists and ranges', () => {
  it('expands a comma list into one chip per source', () => {
    expect(parseInline('Está en las Llanuras [1, 2].')).toEqual([
      { type: 'text', text: 'Está en las Llanuras ' },
      { type: 'citation', n: 1 },
      { type: 'citation', n: 2 },
      { type: 'text', text: '.' },
    ]);
  });

  it('expands a range, with a hyphen or an en dash', () => {
    const cited = (text: string) =>
      parseInline(text)
        .filter((s) => s.type === 'citation')
        .map((s) => (s.type === 'citation' ? s.n : 0));
    expect(cited('Ver [1–3].')).toEqual([1, 2, 3]);
    expect(cited('Ver [2-4].')).toEqual([2, 3, 4]);
    expect(cited('Ver [1，3]')).toEqual([1, 3]);
  });

  it('cites a repeated source once', () => {
    expect(parseInline('[2, 2]')).toEqual([{ type: 'citation', n: 2 }]);
  });

  it('leaves a reversed or absurd range as text', () => {
    expect(parseInline('[5-2]')).toEqual([{ type: 'text', text: '[5-2]' }]);
    expect(parseInline('[1-500]')).toEqual([{ type: 'text', text: '[1-500]' }]);
  });

  it('reads a lenticular list too', () => {
    const blocks = parseAnswer('Necesitás hierro【1, 2】.');
    const paragraph = blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('expected a paragraph');
    expect(paragraph.segments.filter((s) => s.type === 'citation')).toEqual([
      { type: 'citation', n: 1 },
      { type: 'citation', n: 2 },
    ]);
  });
});

describe('image markers', () => {
  it('reads a lenticular image marker as a figure', () => {
    expect(parseAnswer('【img:1】')).toEqual([{ type: 'image', n: 1 }]);
    expect(parseAnswer('［img: 2］')).toEqual([{ type: 'image', n: 2 }]);
  });

  it('tolerates spaces and capitals in an image marker', () => {
    expect(parseAnswer('[IMG: 3]')).toEqual([{ type: 'image', n: 3 }]);
  });

  it('places a figure lifted from the end of a sentence after its paragraph', () => {
    const blocks = parseAnswer('Bonemass vive en el pantano [1]. [img:1]\n\nEs verde.');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph']);
    expect(blocks[1]).toEqual({ type: 'image', n: 1 });
    const first = blocks[0];
    if (first?.type !== 'paragraph') throw new Error('expected a paragraph');
    expect(first.segments.at(-1)).toEqual({ type: 'text', text: '.' });
  });

  it('places a figure lifted from a list after the list', () => {
    const blocks = parseAnswer('- Hierro [img:2]\n- Cobre');
    expect(blocks.map((b) => b.type)).toEqual(['bullets', 'image']);
  });

  it('places a figure lifted from a table cell after the table', () => {
    const blocks = parseAnswer(['| Jefe | Bioma |', '| --- | --- |', '| Bonemass [img:4] | Pantano |'].join('\n'));
    expect(blocks.map((b) => b.type)).toEqual(['table', 'image']);
    const table = blocks[0];
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(table.rows[0]?.[0]).toEqual([{ type: 'text', text: 'Bonemass' }]);
  });

  it('shows a picture once even when the marker repeats', () => {
    expect(parseAnswer('Uno [img:1] y otro [img:1].').filter((b) => b.type === 'image')).toHaveLength(1);
  });
});
