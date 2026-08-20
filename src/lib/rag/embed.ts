import { embed, embedMany } from 'ai';
import type { GoogleEmbeddingModelOptions } from '@ai-sdk/google';
import { gemini } from './gemini';
import type { EmbeddingProvider, EmbeddingProviderId } from './embed-types';
import { EMBEDDING_DIMENSIONS, normalise, toVectorLiteral } from './embed-types';

export { EMBEDDING_DIMENSIONS, normalise, toVectorLiteral };
export type { EmbeddingProvider, EmbeddingProviderId };

export const EMBEDDING_MODEL = 'gemini-embedding-001';

/** Texts per `embedMany` call. The provider batches up to 100 per HTTP request. */
const BATCH_SIZE = 64;
/** Concurrent in-flight embedding requests. */
const MAX_PARALLEL = 4;
/**
 * Per-call ceiling.
 *
 * `fetch` has no default timeout, so a stalled connection would hang the
 * ingest indefinitely. A bounded wait plus retries turns that into a slow
 * batch rather than a dead run.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;

function model() {
  return gemini().textEmbeddingModel(EMBEDDING_MODEL);
}

function providerOptions(taskType: GoogleEmbeddingModelOptions['taskType']) {
  return {
    google: {
      outputDimensionality: EMBEDDING_DIMENSIONS,
      taskType,
    } satisfies GoogleEmbeddingModelOptions,
  };
}

/**
 * Gemini embeddings.
 *
 * `RETRIEVAL_DOCUMENT` and `RETRIEVAL_QUERY` are an asymmetric pair: using one
 * task type on both sides measurably degrades recall, so the two entry points
 * stay separate rather than sharing a helper.
 *
 * `gemini-embedding-001` is a Matryoshka model, so truncating from its native
 * 3072 dimensions to 768 costs little quality and makes the HNSW index four
 * times smaller.
 */
export const geminiEmbeddingProvider: EmbeddingProvider = {
  id: 'gemini',
  label: `${EMBEDDING_MODEL} (Gemini API)`,
  dimensions: EMBEDDING_DIMENSIONS,

  async embedDocuments(texts) {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const { embeddings } = await embedMany({
        model: model(),
        values: texts.slice(i, i + BATCH_SIZE),
        maxParallelCalls: MAX_PARALLEL,
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        maxRetries: MAX_RETRIES,
        providerOptions: providerOptions('RETRIEVAL_DOCUMENT'),
      });
      for (const e of embeddings) out.push(normalise(e));
    }
    return out;
  },

  async embedQuery(text) {
    const { embedding } = await embed({
      model: model(),
      value: text,
      // A query embedding sits in the request path, so it gets a tighter
      // budget than an ingest batch: better a failed search than a hung page.
      abortSignal: AbortSignal.timeout(20_000),
      maxRetries: 2,
      providerOptions: providerOptions('RETRIEVAL_QUERY'),
    });
    return normalise(embedding);
  },
};

let cached: EmbeddingProvider | null = null;

/**
 * The configured embedding provider.
 *
 * Gemini is the default. `EMBEDDING_PROVIDER=local` switches to an on-CPU model
 * instead, which exists because the Gemini free tier permits 1,000 embedding
 * requests per day while indexing this wiki needs several thousand — enough to
 * make a full ingest impossible without billing enabled.
 *
 * Both providers output 768 dimensions, so switching requires re-embedding the
 * corpus (`pnpm ingest --full --reembed`) but never a migration. Vectors from
 * different providers are not comparable, so they must not be mixed.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;
  const requested = (process.env.EMBEDDING_PROVIDER ?? 'gemini') as EmbeddingProviderId;
  if (requested !== 'gemini' && requested !== 'local') {
    throw new Error(`Unknown EMBEDDING_PROVIDER "${requested}". Use "gemini" or "local".`);
  }
  cached = requested === 'local' ? lazyLocalProvider() : geminiEmbeddingProvider;
  return cached;
}

/** Test-only: forget the memoised provider so env changes take effect. */
export function resetEmbeddingProvider(): void {
  cached = null;
}

/**
 * Defers loading transformers.js until something actually embeds, so the
 * Gemini path never pays for importing it.
 */
function lazyLocalProvider(): EmbeddingProvider {
  const load = async () => (await import('./embed-local')).localEmbeddingProvider;
  return {
    id: 'local',
    label: 'multilingual-e5-base (local, CPU)',
    dimensions: EMBEDDING_DIMENSIONS,
    embedDocuments: async (texts) => (await load()).embedDocuments(texts),
    embedQuery: async (text) => (await load()).embedQuery(text),
  };
}

/** Embeds passages with the configured provider. */
export function embedDocuments(texts: string[]): Promise<number[][]> {
  return getEmbeddingProvider().embedDocuments(texts);
}

/** Embeds one query with the configured provider. */
export function embedQuery(text: string): Promise<number[]> {
  return getEmbeddingProvider().embedQuery(text);
}
