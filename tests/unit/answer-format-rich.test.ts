import { describe, expect, it } from 'vitest';
import { parseAnswer } from '@/lib/answer-format';

/**
 * Tables and images, the two constructs an answer needs that prose does not
 * provide: upgrade levels are a grid, and "what does a Bonemass look like" is
 * a picture. Both are also the two easiest to get wrong — a stray pipe turning
 * a sentence into a table, or an image marker resolving to nothing.
 */

describe('tables', () => {
  it('parses a header, its rule and its rows', () => {
    const blocks = parseAnswer(
      ['| Nivel | Madera | Hierro |', '| --- | --- | --- |', '| 1 | 2 | 20 |', '| 2 | 1 | 10 |'].join(
        '\n',
      ),
    );

    expect(blocks).toHaveLength(1);
    const table = blocks[0];
    if (table?.type !== 'table') throw new Error('expected a table');

    expect(table.header.map((cell) => cell.map((s) => ('text' in s ? s.text : '')).join(''))).toEqual([
      'Nivel',
      'Madera',
      'Hierro',
    ]);
    expect(table.rows).toHaveLength(2);
  });

  it('keeps citations inside cells rather than dropping them', () => {
    const blocks = parseAnswer(['| Nivel | Hierro |', '| --- | --- |', '| 1 | 20 [3] |'].join('\n'));
    const table = blocks[0];
    if (table?.type !== 'table') throw new Error('expected a table');

    expect(table.rows[0]?.[1]).toContainEqual({ type: 'citation', n: 3 });
  });

  it('does not turn a sentence containing a pipe into a table', () => {
    // The rule under the header is what makes a table a table. Without this
    // check, prose about "damage | blunt" silently becomes a one-row grid.
    const blocks = parseAnswer('El daño es contundente | perforante según el arma.');
    expect(blocks[0]?.type).toBe('paragraph');
  });

  it('returns to prose after the table ends', () => {
    const blocks = parseAnswer(
      ['| A | B |', '| --- | --- |', '| 1 | 2 |', '', 'Y eso es todo [1].'].join('\n'),
    );

    expect(blocks.map((b) => b.type)).toEqual(['table', 'paragraph']);
  });
});

describe('images', () => {
  it('parses a marker on its own line', () => {
    const blocks = parseAnswer(['Bonemass vive en el pantano [2].', '', '[img:2]'].join('\n'));
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'image']);
    expect(blocks[1]).toEqual({ type: 'image', n: 2 });
  });

  it('leaves an inline mention as text, because only a whole line is a figure', () => {
    const blocks = parseAnswer('Mirá la imagen [img:2] de arriba.');
    expect(blocks[0]?.type).toBe('paragraph');
  });

  it('still parses ordinary citations, which look almost identical', () => {
    const blocks = parseAnswer('Necesitás hierro [2].');
    const paragraph = blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('expected a paragraph');
    expect(paragraph.segments).toContainEqual({ type: 'citation', n: 2 });
  });
});

describe('mixed answers', () => {
  it('handles prose, a list, a table and an image in one answer', () => {
    const blocks = parseAnswer(
      [
        'Necesitás madera, hierro y cuero [1].',
        '',
        '- Madera',
        '- Hierro',
        '',
        '| Nivel | Hierro |',
        '| --- | --- |',
        '| 1 | 20 |',
        '',
        '[img:1]',
      ].join('\n'),
    );

    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'bullets', 'table', 'image']);
  });
});

describe('bracket variants', () => {
  /*
   * Not hypothetical: gpt-oss-120b answered a real question on this corpus
   * with 【1】 rather than [1]. Left alone, every citation in that answer
   * renders as literal punctuation instead of a chip that links anywhere.
   */
  it('reads CJK lenticular brackets as citations', () => {
    const blocks = parseAnswer('Necesitás 20 de hierro【3】.');
    const paragraph = blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('expected a paragraph');
    expect(paragraph.segments).toContainEqual({ type: 'citation', n: 3 });
  });

  it('reads full-width square brackets as citations', () => {
    const blocks = parseAnswer('Bonemass vive en el pantano［5］.');
    const paragraph = blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('expected a paragraph');
    expect(paragraph.segments).toContainEqual({ type: 'citation', n: 5 });
  });

  it('normalises them inside table cells too', () => {
    const blocks = parseAnswer(['| Nivel | Hierro |', '| --- | --- |', '| 1 | 20【2】 |'].join('\n'));
    const table = blocks[0];
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(table.rows[0]?.[1]).toContainEqual({ type: 'citation', n: 2 });
  });

  it('leaves ordinary brackets alone', () => {
    const blocks = parseAnswer('Necesitás 20 de hierro [3].');
    const paragraph = blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('expected a paragraph');
    expect(paragraph.segments).toContainEqual({ type: 'citation', n: 3 });
  });
});
