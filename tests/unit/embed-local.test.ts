import { afterEach, describe, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({ loads: 0, failFirst: true, inputs: [] as string[][] }));

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: async () => {
    model.loads += 1;
    if (model.failFirst && model.loads === 1) throw new Error('download dropped');
    return async (texts: string[]) => {
      model.inputs.push(texts);
      return { tolist: () => texts.map(() => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))) };
    };
  },
}));

import { embedQueriesLocally, localEmbeddingProvider, resetLocalExtractor } from '@/lib/rag/embed-local';

afterEach(() => {
  resetLocalExtractor();
  model.loads = 0;
  model.failFirst = true;
  model.inputs = [];
});

describe('local embeddings', () => {
  /*
   * The load promise used to be memoised even when it rejected, so one
   * dropped download or one bad moment during ONNX start-up failed every
   * question afterwards until the process was restarted.
   */
  it('loads the model again after a failed load instead of failing forever', async () => {
    await expect(localEmbeddingProvider.embedQuery('hierro')).rejects.toThrow(/download dropped/);
    const vector = await localEmbeddingProvider.embedQuery('hierro');
    expect(vector).toHaveLength(768);
    expect(model.loads).toBe(2);
  });

  it('keeps a model that loaded, rather than loading it per call', async () => {
    model.failFirst = false;
    await localEmbeddingProvider.embedQuery('uno');
    await localEmbeddingProvider.embedQuery('dos');
    expect(model.loads).toBe(1);
  });

  it('embeds several queries in one forward pass, with the query prefix', async () => {
    model.failFirst = false;
    const vectors = await embedQueriesLocally(['iron sword', 'smelter']);
    expect(vectors).toHaveLength(2);
    expect(model.inputs).toEqual([['query: iron sword', 'query: smelter']]);
  });

  it('caps what the tokenizer is handed', async () => {
    model.failFirst = false;
    await localEmbeddingProvider.embedQuery('x'.repeat(50_000));
    await embedQueriesLocally(['y'.repeat(50_000)]);
    for (const batch of model.inputs) {
      for (const text of batch) expect(text.length).toBeLessThanOrEqual('query: '.length + 2_000);
    }
  });
});
