import { describe, expect, it } from 'vitest';
import {
  buildContext,
  buildSystemPrompt,
  buildUserPrompt,
  noContextAnswer,
} from '@/lib/rag/prompt';
import type { ScoredChunk } from '@/lib/rag/retrieve';

function chunk(overrides: Partial<ScoredChunk> = {}): ScoredChunk {
  return {
    id: 'c1',
    title: 'Iron Sword',
    url: 'https://valheim.fandom.com/wiki/Iron_Sword',
    sectionPath: 'Level 1',
    kind: 'infobox',
    content: 'Iron Sword › Level 1: Crafting Materials: Wood x2; Iron x20',
    source: 'fandom',
    sourceRank: 0,
    slug: 'iron-sword',
    score: 0.5,
    ranks: { 'vector:0': 1 },
    ...overrides,
  };
}

describe('buildContext', () => {
  it('numbers excerpts from 1 and matches them to citations', () => {
    const { context, citations } = buildContext([
      chunk({ id: 'a', title: 'A' }),
      chunk({ id: 'b', title: 'B' }),
      chunk({ id: 'c', title: 'C' }),
    ]);

    expect(citations.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(citations.map((c) => c.title)).toEqual(['A', 'B', 'C']);
    expect(context).toContain('[1] A');
    expect(context).toContain('[2] B');
    expect(context).toContain('[3] C');
  });

  it('is the only source of the numbering the model cites against', () => {
    const chunks = [chunk({ id: 'x', title: 'X' }), chunk({ id: 'y', title: 'Y' })];
    const { context, citations } = buildContext(chunks);
    // Every marker present in the context must exist as a citation, or the UI
    // would render a chip that points nowhere.
    const markers = [...context.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    for (const n of markers) {
      expect(citations.some((c) => c.n === n)).toBe(true);
    }
  });

  it('carries the section into the excerpt heading', () => {
    const { context } = buildContext([chunk({ sectionPath: 'Usage > Crafting' })]);
    expect(context).toContain('Iron Sword › Usage > Crafting');
  });

  it('keeps the url and source for the citation card', () => {
    const { citations } = buildContext([chunk()]);
    expect(citations[0]).toMatchObject({
      url: 'https://valheim.fandom.com/wiki/Iron_Sword',
      source: 'fandom',
      sectionPath: 'Level 1',
    });
  });

  it('carries the article slug so a citation can open the in-app page', () => {
    const { citations } = buildContext([chunk()]);
    expect(citations[0]!.slug).toBe('iron-sword');
  });

  it('leaves the slug null when the page has no reading document', () => {
    const { citations } = buildContext([chunk({ slug: null })]);
    expect(citations[0]!.slug).toBeNull();
  });

  it('rounds the score rather than storing full float noise', () => {
    const { citations } = buildContext([chunk({ score: 0.123456789 })]);
    expect(citations[0]!.score).toBe(0.123457);
  });

  it('returns empty output for no chunks', () => {
    expect(buildContext([])).toEqual({ context: '', citations: [] });
  });
});

describe('buildSystemPrompt', () => {
  it('forbids answering from the model own knowledge', () => {
    const prompt = buildSystemPrompt('es');
    expect(prompt).toMatch(/ONLY the numbered excerpts/);
    expect(prompt).toMatch(/Never use your own knowledge/);
    expect(prompt).toMatch(/Never invent numbers/);
  });

  it('requires a citation on every claim', () => {
    expect(buildSystemPrompt('en')).toMatch(/Cite every factual claim/);
  });

  it('sets the answer language and keeps in-game names in English', () => {
    expect(buildSystemPrompt('es')).toMatch(/Responde SIEMPRE en español/);
    expect(buildSystemPrompt('es')).toMatch(/nombres propios del juego en inglés/);
    expect(buildSystemPrompt('en')).toMatch(/Always answer in English/);
  });
});

describe('buildUserPrompt', () => {
  it('puts the excerpts before the question', () => {
    const prompt = buildUserPrompt('¿Cuánto hierro?', '[1] Iron Sword\nIron x20');
    expect(prompt.indexOf('Iron x20')).toBeLessThan(prompt.indexOf('¿Cuánto hierro?'));
  });

  it('sends the bare question when there is no context', () => {
    expect(buildUserPrompt('hola', '')).toBe('hola');
  });
});

describe('noContextAnswer', () => {
  it('says nothing was found and suggests the in-game name', () => {
    expect(noContextAnswer('es')).toMatch(/No encontré/);
    expect(noContextAnswer('es')).toMatch(/Surtling core/);
    expect(noContextAnswer('en')).toMatch(/could not find/i);
  });
});

describe('citation style rules', () => {
  it('tells the model not to repeat markers on every bullet', () => {
    // Without this the model cites [2][5][8] on each line of a crafting list,
    // which triples the markers and reads as noise.
    expect(buildSystemPrompt('es')).toMatch(/cite once after the line that introduces it/);
  });

  it('asks for the most specific excerpt rather than all of them', () => {
    expect(buildSystemPrompt('en')).toMatch(/most specific excerpt/);
  });
});
