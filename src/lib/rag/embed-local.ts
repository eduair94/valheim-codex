import type { EmbeddingProvider } from './embed-types';
import { EMBEDDING_DIMENSIONS, normalise } from './embed-types';

/**
 * `multilingual-e5-base` chosen for three reasons: it is genuinely multilingual
 * (a Spanish question has to find English wiki text), it is retrieval-tuned
 * with an asymmetric query/passage convention that mirrors Gemini's task
 * types, and it outputs exactly 768 dimensions — so it drops into the existing
 * `vector(768)` column with no migration.
 */
const MODEL_ID = 'Xenova/multilingual-e5-base';

/**
 * E5 models are trained with these literal prefixes. Dropping them is not a
 * small quality tweak: the model was never trained on bare text, and recall
 * degrades noticeably without them.
 */
const QUERY_PREFIX = 'query: ';
const PASSAGE_PREFIX = 'passage: ';

/** Texts per forward pass. Larger batches trade memory for throughput. */
const BATCH_SIZE = 16;

type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

let extractorPromise: Promise<Extractor> | null = null;

/**
 * Loads the model once per process.
 *
 * The first call downloads roughly 280 MB to the transformers.js cache; every
 * later call, and every later run, reuses it.
 */
async function getExtractor(): Promise<Extractor> {
  extractorPromise ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');

    /*
     * By default the model is cached inside the installed package directory,
     * whose path contains the package version. A container image that copies
     * that path breaks silently on the next dependency bump — the build still
     * succeeds and the running app re-downloads 283 MB on its first question.
     * `MODEL_CACHE_DIR` pins it somewhere the image controls.
     */
    const cacheDir = process.env.MODEL_CACHE_DIR;
    if (cacheDir) env.cacheDir = cacheDir;

    const extractor = await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
    });
    return extractor as unknown as Extractor;
  })();
  return extractorPromise;
}

async function embedBatched(texts: string[], prefix: string): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => prefix + t);
    const output = await extractor(batch, { pooling: 'mean', normalize: true });
    for (const vector of output.tolist()) {
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `${MODEL_ID} returned ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. ` +
            'The schema column and the model must agree.',
        );
      }
      out.push(normalise(vector));
    }
  }
  return out;
}

/**
 * Local embeddings, computed on the CPU with no API and no quota.
 *
 * This exists because the Gemini free tier allows 1,000 embedding requests per
 * day, and indexing the wiki takes several thousand. On a paid key the Gemini
 * provider is the better choice; this one lets the index be built, re-built and
 * evaluated at no cost and with no rate limit.
 */
export const localEmbeddingProvider: EmbeddingProvider = {
  id: 'local',
  label: `${MODEL_ID} (local, CPU)`,
  dimensions: EMBEDDING_DIMENSIONS,
  embedDocuments: (texts) => embedBatched(texts, PASSAGE_PREFIX),
  embedQuery: async (text) => {
    const [vector] = await embedBatched([text], QUERY_PREFIX);
    if (!vector) throw new Error('Local embedder returned no vector');
    return vector;
  },
};
