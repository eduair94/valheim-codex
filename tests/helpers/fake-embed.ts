import { EMBEDDING_DIMENSIONS, normalise } from '@/lib/rag/embed';

/**
 * Deterministic bag-of-words embedder used instead of calling Gemini in tests.
 *
 * Texts sharing words land close together and unrelated texts land far apart,
 * which is the only property the retrieval tests depend on. Being deterministic
 * also keeps those tests from flaking on model updates.
 */
export function fakeEmbed(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  for (const word of words) {
    let hash = 2166136261;
    for (let i = 0; i < word.length; i += 1) {
      hash ^= word.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % EMBEDDING_DIMENSIONS;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  return normalise(vector);
}

export const fakeEmbedAsync = async (text: string): Promise<number[]> => fakeEmbed(text);
