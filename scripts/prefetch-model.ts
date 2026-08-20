/**
 * Downloads the embedding model into the image at build time.
 *
 * Without this the model is fetched on first use: a container that has just
 * started would stall for ~30 seconds on the first question while it pulls
 * 283 MB, and would re-pull it on every deploy and every restart. Baking it in
 * makes the image bigger and the running app predictable, which is the right
 * trade for something you consult mid-game.
 *
 * Skipped when the Gemini provider is configured, so a build that does not need
 * the model does not pay for it.
 */
export {};

const provider = process.env.EMBEDDING_PROVIDER ?? 'gemini';

if (provider !== 'local') {
  console.log(`prefetch-model: EMBEDDING_PROVIDER=${provider}, nothing to download`);
  process.exit(0);
}

const started = Date.now();
console.log('prefetch-model: downloading multilingual-e5-base…');

const { localEmbeddingProvider } = await import('../src/lib/rag/embed-local');
const [vector] = await localEmbeddingProvider.embedDocuments(['warm the model cache']);

if (!vector || vector.length !== 768) {
  console.error(`prefetch-model: expected 768 dimensions, got ${vector?.length}`);
  process.exit(1);
}

console.log(`prefetch-model: ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
