import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TitleIndexEntry } from '@/lib/db/wiki-repo';
import { titleLinker } from '@/lib/rag/intent';
import { planQueries, rewriteModeFrom, type PlanInput } from '@/lib/rag/plan';

const INDEX: TitleIndexEntry[] = [
  { s: 'resin', t: 'Resin', c: [], e: 'Resina' },
  { s: 'tin', t: 'Tin', c: [], e: 'Estaño' },
  { s: 'bronze', t: 'Bronze', c: [], e: 'Bronce' },
];

const REWRITTEN = ['Resin used for'];

function setup(overrides: Partial<PlanInput> = {}) {
  const load = vi.fn(async () => INDEX);
  const rewrite = vi.fn(async () => REWRITTEN);
  const input: PlanInput = {
    question: '¿Para qué sirve la resina?',
    history: [],
    rewrite,
    linker: titleLinker(load),
    mode: 'auto',
    ...overrides,
  };
  return { input, load, rewrite };
}

describe('planQueries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('searches a first question about a linked thing as asked, without a model', async () => {
    const { input, rewrite } = setup();
    expect(await planQueries(input)).toEqual({ queries: ['¿Para qué sirve la resina?'], rewritten: false });
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('does the same for a where question', async () => {
    const { input, rewrite } = setup({ question: '¿Dónde encuentro estaño?' });
    expect(await planQueries(input)).toEqual({ queries: ['¿Dónde encuentro estaño?'], rewritten: false });
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('does the same for a question about several things, every one of them linked', async () => {
    const { input, rewrite } = setup({ question: '¿Qué puedo hacer con el estaño y el bronce?' });
    expect((await planQueries(input)).rewritten).toBe(false);
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('rewrites a question that names one thing the index does not, beside one it does', async () => {
    // Bronze links, "Zinn" does not: searched as asked, Tin would be neither
    // translated nor pinned.
    const { input, rewrite } = setup({ question: 'Was kann ich mit Zinn und Bronze herstellen?' });
    expect(await planQueries(input)).toEqual({ queries: REWRITTEN, rewritten: true });
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('rewrites a follow-up, which needs the conversation folded in', async () => {
    const { input, rewrite } = setup({
      history: [
        { role: 'user', text: '¿Qué es el estaño?' },
        { role: 'assistant', text: 'Un metal [1].' },
      ],
    });
    expect(await planQueries(input)).toEqual({ queries: REWRITTEN, rewritten: true });
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('rewrites a question whose thing the index does not name', async () => {
    const { input, rewrite } = setup({ question: 'Was kann ich mit Zinn herstellen?' });
    expect(await planQueries(input)).toEqual({ queries: REWRITTEN, rewritten: true });
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('rewrites any other question, without reading the index for it', async () => {
    const { input, rewrite, load } = setup({ question: '¿Cómo invoco a Bonemass?' });
    expect(await planQueries(input)).toEqual({ queries: REWRITTEN, rewritten: true });
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it('rewrites when the index cannot be read, as it always did', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { input, rewrite } = setup({
      linker: titleLinker(async () => {
        throw new Error('database down');
      }),
    });
    expect((await planQueries(input)).rewritten).toBe(true);
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('rewrites without a linker to link with', async () => {
    const { input, rewrite } = setup({ linker: undefined });
    expect((await planQueries(input)).rewritten).toBe(true);
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('rewrites every question when the mode is always', async () => {
    const { input, rewrite } = setup({ mode: 'always' });
    expect(await planQueries(input)).toEqual({ queries: REWRITTEN, rewritten: true });
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('rewrites none when the mode is off, folding the previous question into a follow-up', async () => {
    const { input, rewrite } = setup({
      mode: 'off',
      question: '¿y dónde está?',
      history: [
        { role: 'user', text: '¿Qué es el estaño?' },
        { role: 'assistant', text: 'Un metal [1].' },
      ],
    });
    expect(await planQueries(input)).toEqual({
      queries: ['¿y dónde está?', '¿Qué es el estaño? ¿y dónde está?'],
      rewritten: false,
    });
    expect(rewrite).not.toHaveBeenCalled();
  });
});

describe('rewriteModeFrom', () => {
  it('reads the three modes, in any case', () => {
    expect(rewriteModeFrom('off')).toBe('off');
    expect(rewriteModeFrom(' ALWAYS ')).toBe('always');
    expect(rewriteModeFrom('auto')).toBe('auto');
  });

  it('is auto when unset or unknown', () => {
    expect(rewriteModeFrom(undefined)).toBe('auto');
    expect(rewriteModeFrom('')).toBe('auto');
    expect(rewriteModeFrom('sometimes')).toBe('auto');
  });
});
