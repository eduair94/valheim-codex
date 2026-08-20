/**
 * Dimensionality of every stored embedding.
 *
 * Must match the `vector(768)` column in drizzle/0000_init.sql. Both supported
 * providers are configured to produce exactly this, so switching providers
 * needs a re-ingest but never a migration.
 */
export const EMBEDDING_DIMENSIONS = 768;

export type EmbeddingProviderId = 'gemini' | 'local';

export type EmbeddingProvider = {
  id: EmbeddingProviderId;
  /** Human label, shown by the ingest script so a run is self-documenting. */
  label: string;
  dimensions: number;
  /** Embeds passages for storage. */
  embedDocuments: (texts: string[]) => Promise<number[][]>;
  /** Embeds one search query. */
  embedQuery: (text: string) => Promise<number[]>;
};

/**
 * Scales a vector to unit length.
 *
 * pgvector's cosine operator assumes nothing about magnitude, and Gemini
 * embeddings are not unit-length once truncated below their native
 * dimensionality. Normalising on the way in keeps `1 - (a <=> b)` a true
 * cosine similarity and keeps vectors comparable across providers and runs.
 */
export function normalise(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

/** pgvector literal form: `[0.1,0.2,...]`. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
