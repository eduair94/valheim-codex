import { describe, expect, it } from 'vitest';
import { parseAnswer, parseInline } from '@/lib/answer-format';

describe('parseInline', () => {
  it('turns a citation marker into a citation segment', () => {
    expect(parseInline('Necesitás 20 de hierro [1].')).toEqual([
      { type: 'text', text: 'Necesitás 20 de hierro ' },
      { type: 'citation', n: 1 },
      { type: 'text', text: '.' },
    ]);
  });

  it('handles a run of markers, which is how the model cites two sources', () => {
    const segments = parseInline('Está en las Llanuras [2][3].');
    expect(segments.filter((s) => s.type === 'citation')).toEqual([
      { type: 'citation', n: 2 },
      { type: 'citation', n: 3 },
    ]);
  });

  it('reads bold and inline code', () => {
    expect(parseInline('Usá **Iron x20** y `SwordIron`')).toEqual([
      { type: 'text', text: 'Usá ' },
      { type: 'bold', text: 'Iron x20' },
      { type: 'text', text: ' y ' },
      { type: 'code', text: 'SwordIron' },
    ]);
  });

  it('leaves unmatched punctuation alone rather than eating it', () => {
    expect(parseInline('un * asterisco y un ` acento')).toEqual([
      { type: 'text', text: 'un * asterisco y un ` acento' },
    ]);
  });

  it('does not treat a bracketed word as a citation', () => {
    expect(parseInline('[nota] al margen')).toEqual([{ type: 'text', text: '[nota] al margen' }]);
  });

  it('returns nothing for an empty line', () => {
    expect(parseInline('')).toEqual([]);
  });
});

describe('parseAnswer', () => {
  it('splits paragraphs on blank lines', () => {
    const blocks = parseAnswer('Primero.\n\nSegundo.');
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.type === 'paragraph')).toBe(true);
  });

  it('joins wrapped lines into one paragraph', () => {
    const blocks = parseAnswer('una frase\ncontinuada');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'paragraph',
      segments: [{ type: 'text', text: 'una frase continuada' }],
    });
  });

  it('reads a bullet list, which is how crafting materials arrive', () => {
    const blocks = parseAnswer('Necesitás:\n- Wood x2\n- Iron x20\n* Leather scraps x3');
    expect(blocks[0]!.type).toBe('paragraph');
    expect(blocks[1]).toMatchObject({ type: 'bullets' });
    if (blocks[1]?.type !== 'bullets') throw new Error('unreachable');
    expect(blocks[1].items).toHaveLength(3);
    expect(blocks[1].items[1]).toEqual([{ type: 'text', text: 'Iron x20' }]);
  });

  it('reads a numbered list', () => {
    const blocks = parseAnswer('1. Conseguí el trofeo\n2) Llevalo al altar');
    expect(blocks[0]).toMatchObject({ type: 'numbers' });
    if (blocks[0]?.type !== 'numbers') throw new Error('unreachable');
    expect(blocks[0].items).toHaveLength(2);
  });

  it('keeps citations inside list items', () => {
    const blocks = parseAnswer('- Iron x20 [1]');
    if (blocks[0]?.type !== 'bullets') throw new Error('unreachable');
    expect(blocks[0].items[0]).toContainEqual({ type: 'citation', n: 1 });
  });

  it('ends a list when prose resumes', () => {
    const blocks = parseAnswer('- uno\n- dos\nY después texto.');
    expect(blocks.map((b) => b.type)).toEqual(['bullets', 'paragraph']);
  });

  it('handles an empty answer', () => {
    expect(parseAnswer('')).toEqual([]);
    expect(parseAnswer('\n\n  \n')).toEqual([]);
  });

  it('survives a partial answer mid-stream', () => {
    // Streaming means the renderer sees truncated text on every frame; it must
    // never throw on a half-written marker or an unclosed bold run.
    for (const partial of ['Necesitás 20 de hie', 'Necesitás **Iron', 'Está en [', 'Está en [1']) {
      expect(() => parseAnswer(partial)).not.toThrow();
      expect(parseAnswer(partial).length).toBeGreaterThan(0);
    }
  });
});
