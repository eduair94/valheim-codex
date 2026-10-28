import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

const operator = vi.hoisted(() => ({ calls: 0, list: [] as unknown[] }));
vi.mock('@/lib/rag/provider', () => ({
  rewriteCandidates: () => {
    operator.calls += 1;
    return operator.list;
  },
}));

import { deterministicQueries, REWRITE_INSTRUCTIONS, rewriteQueries } from '@/lib/rag/rewrite';

/**
 * The rewrite is the step that makes Spanish questions and follow-ups
 * searchable, and a failure there must degrade the answer, not end it — with
 * two exceptions: a reader's own key must rewrite on that key alone, and a
 * reader who left must stop the work instead of having it finished for them.
 */

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function answering(json: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(json) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });
}

/** A model that never answers until its call is aborted — like fetch, even if it already was. */
function stalling(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: (options) =>
      new Promise((_resolve, reject) => {
        const signal = options.abortSignal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason));
      }),
  });
}

afterEach(() => {
  operator.calls = 0;
  operator.list = [];
});

describe('rewriteQueries', () => {
  it('rewrites on the given model alone, never asking for the operator’s chain', async () => {
    const own = answering({ queries: ['Iron Sword recipe'] });
    const queries = await rewriteQueries({
      question: '¿Qué necesito para la espada de hierro?',
      model: { name: 'byok/gemini-3.5-flash-lite', model: own, maxRetries: 1 },
    });

    expect(queries).toEqual(['Iron Sword recipe']);
    expect(own.doGenerateCalls).toHaveLength(1);
    expect(operator.calls).toBe(0);
  });

  it('uses the operator’s chain when no model is given', async () => {
    operator.list = [{ name: 'mock/a', model: answering({ queries: ['Bonemass'] }) }];
    expect(await rewriteQueries({ question: '¿Cómo invoco a Bonemass?' })).toEqual(['Bonemass']);
    expect(operator.calls).toBe(1);
  });

  it('falls back to the raw question when the model stalls past its deadline', async () => {
    const started = Date.now();
    const queries = await rewriteQueries({
      question: '¿Dónde hay cobre?',
      model: { name: 'byok/x', model: stalling() },
      attemptTimeoutMs: 40,
      totalTimeoutMs: 2_000,
    });
    expect(queries).toEqual(['¿Dónde hay cobre?']);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('falls back when the whole rewrite runs out of time, however many providers remain', async () => {
    operator.list = [
      { name: 'mock/a', model: stalling() },
      { name: 'mock/b', model: stalling() },
    ];
    const queries = await rewriteQueries({ question: 'hierro', attemptTimeoutMs: 5_000, totalTimeoutMs: 60 });
    expect(queries).toEqual(['hierro']);
  });

  it('stops, rather than degrading, when the reader leaves', async () => {
    const reader = new AbortController();
    const pending = rewriteQueries({
      question: 'hierro',
      model: { name: 'byok/x', model: stalling() },
      abortSignal: reader.signal,
    });
    reader.abort(new DOMException('reader left', 'AbortError'));
    await expect(pending).rejects.toThrow(/reader left/);
  });

  it('folds recent history into the prompt, capped per turn', async () => {
    const own = answering({ queries: ['Iron Sword stats'] });
    await rewriteQueries({
      question: '¿y cuánto daño hace?',
      history: [
        { role: 'user', text: '¿Qué es la espada de hierro?' },
        { role: 'assistant', text: 'x'.repeat(5_000) },
      ],
      model: { name: 'byok/x', model: own },
    });
    const prompt = JSON.stringify(own.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('espada de hierro');
    expect(prompt).not.toContain('x'.repeat(501));
  });

  it('keeps the first three queries when a model writes one per thing for four things', async () => {
    // The schema has no upper bound on purpose: refusing the fourth would
    // throw away all four and search the raw question instead.
    const own = answering({ queries: ['Copper used for', 'Tin used for', 'Iron used for', 'Silver used for'] });
    const queries = await rewriteQueries({
      question: '¿Qué hago con cobre, estaño, hierro y plata?',
      model: { name: 'byok/x', model: own },
    });
    expect(queries).toEqual(['Copper used for', 'Tin used for', 'Iron used for']);
  });

  it('still falls back to the raw question when a model writes no query at all', async () => {
    const queries = await rewriteQueries({
      question: '¿Qué hago con la plata?',
      model: { name: 'byok/x', model: answering({ queries: [] }) },
    });
    expect(queries).toEqual(['¿Qué hago con la plata?']);
  });
});

/*
 * "Was kann ich mit Zinn und Bronze herstellen?" was rewritten to "Tin
 * crafting recipes" and "Bronze crafting recipes": how to make them, not what
 * they make, and "crafting" filled five of the eight excerpts with the
 * Crafting list pages. The words below were measured on the corpus; see the
 * comment on REWRITE_INSTRUCTIONS.
 */
describe('rewrite instructions', () => {
  it('reach the model as its instructions', async () => {
    const own = answering({ queries: ['Tin used for', 'Bronze used for'] });
    const queries = await rewriteQueries({
      question: '¿Qué puedo hacer con el estaño y el bronce?',
      model: { name: 'byok/x', model: own },
    });
    expect(queries).toEqual(['Tin used for', 'Bronze used for']);
    const system = own.doGenerateCalls[0]?.prompt.find((m) => m.role === 'system');
    expect(system?.content).toBe(REWRITE_INSTRUCTIONS);
  });

  it('name the wiki’s words for each intent, and never "crafting" or "usage"', () => {
    for (const words of ['"X used for"', '"X recipe"', 'never "crafting"', '"X how to obtain"', '"X spawning"', '"X stats"']) {
      expect(REWRITE_INSTRUCTIONS).toContain(words);
    }
    // "usage" is a word in 1,292 of 5,856 chunks: it floods the excerpts with
    // other articles' Usage sections.
    expect(REWRITE_INSTRUCTIONS).not.toMatch(/usage/i);
  });

  it('ask for one query per thing, keeping a name of several words whole', () => {
    expect(REWRITE_INSTRUCTIONS).toMatch(/one query per thing/);
    expect(REWRITE_INSTRUCTIONS).toMatch(/never split it/);
    expect(REWRITE_INSTRUCTIONS).toMatch(/Never more than three/);
  });

  it('use the names the wiki indexes', () => {
    // "Blackmetal" is in 12 chunks and no title; "Black metal" names several articles.
    expect(REWRITE_INSTRUCTIONS).toContain('Black metal');
    expect(REWRITE_INSTRUCTIONS).not.toContain('Blackmetal');
  });

  it('show examples in Spanish, English and German', () => {
    for (const example of [
      '¿Qué puedo hacer con pedernal y piedra? → ["Flint used for", "Stone used for"]',
      '¿Dónde consigo ojos de enano gris? → ["Greydwarf eye how to obtain"]',
      'How do I make a bronze axe? → ["Bronze axe recipe"]',
      'Was kann ich mit Lederresten bauen? → ["Leather scraps used for"]',
      'What is a Seeker? → ["Seeker"]',
    ]) {
      expect(REWRITE_INSTRUCTIONS).toContain(example);
    }
  });

  it('take no example from the eval, nor any thing it asks about', () => {
    // An example the eval also asks, or one that names the thing an eval
    // question is about, would measure memory, not the prompt. A German
    // example about resin once answered "¿Para qué sirve la resina?".
    const evalDir = fileURLToPath(new URL('../eval/', import.meta.url));
    const cases = readdirSync(evalDir)
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) => readFileSync(join(evalDir, file), 'utf8').split('\n'))
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { q: string; expect?: string[]; targets?: { title: string }[] });
    const name = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const questions = new Set(cases.map((c) => c.q.trim()));
    const things = new Set(cases.flatMap((c) => [...(c.expect ?? []), ...(c.targets ?? []).map((t) => t.title)]).map(name));
    expect(questions.size).toBeGreaterThan(0);
    expect(things.size).toBeGreaterThan(0);

    const examples = REWRITE_INSTRUCTIONS.split('Examples:\n')[1]!
      .split('\n')
      .map((line) => line.split(' → ') as [string, string]);
    expect(examples).toHaveLength(5);
    for (const [question, queries] of examples) {
      expect(questions).not.toContain(question);
      for (const query of JSON.parse(queries) as string[]) {
        // "Flint used for" is about Flint.
        expect(things).not.toContain(name(query.replace(/ (?:used for|recipe|how to obtain|spawning|stats)$/, '')));
      }
    }
    // Nor the failure that prompted these rules, so a re-run of it measures them.
    expect(REWRITE_INSTRUCTIONS).not.toMatch(/\bTin\b|estaño|Zinn/);
  });
});

describe('deterministicQueries', () => {
  it('searches the question alone at the start of a conversation', () => {
    expect(deterministicQueries('¿Dónde hay cobre?')).toEqual(['¿Dónde hay cobre?']);
  });

  it('folds the previous question in front of a follow-up', () => {
    expect(
      deterministicQueries('¿y dónde está?', [
        { role: 'user', text: '¿Qué es Bonemass?' },
        { role: 'assistant', text: 'Un jefe.' },
      ]),
    ).toEqual(['¿y dónde está?', '¿Qué es Bonemass? ¿y dónde está?']);
  });

  it('returns nothing for an empty question', () => {
    expect(deterministicQueries('   ')).toEqual([]);
  });
});
