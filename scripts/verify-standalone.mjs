/**
 * Proves the standalone bundle can actually embed, before the image ships.
 *
 * Run with the standalone directory as the working directory, so it resolves
 * modules exactly as the container will. Two things this catches that a
 * successful `next build` does not:
 *
 *   - dependency tracing is platform-specific. `onnxruntime-node` carries a
 *     native binary per platform, and the bundle gets only the build machine's.
 *     A build on the wrong architecture produces an image that starts fine and
 *     fails on the first question.
 *   - the model cache is not a traced dependency. If it was not copied into the
 *     bundle, the container downloads 283 MB on its first question instead.
 *
 * Both are silent until someone asks something. A build-time failure is the
 * cheapest place to find them.
 */

const EXPECTED_DIMENSIONS = 768;

console.log(`verify-standalone: cwd=${process.cwd()}`);

let pipeline;
let env;
try {
  ({ pipeline, env } = await import('@huggingface/transformers'));
  if (process.env.MODEL_CACHE_DIR) env.cacheDir = process.env.MODEL_CACHE_DIR;
} catch (error) {
  console.error('verify-standalone: the bundle cannot resolve @huggingface/transformers.');
  console.error(error.message);
  process.exit(1);
}

const started = Date.now();

let extractor;
try {
  extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-base', {
    dtype: 'q8',
    // Fail loudly instead of quietly downloading: a bundle that has to fetch
    // the model is a bundle that is missing it.
    local_files_only: true,
  });
} catch (error) {
  console.error('verify-standalone: the model is not in the bundle, or the native runtime failed.');
  console.error(error.message);
  process.exit(1);
}

const output = await extractor(['passage: warm the model'], { pooling: 'mean', normalize: true });
const [vector] = output.tolist();

if (!vector || vector.length !== EXPECTED_DIMENSIONS) {
  console.error(
    `verify-standalone: expected ${EXPECTED_DIMENSIONS} dimensions, got ${vector?.length}.`,
  );
  process.exit(1);
}

console.log(
  `verify-standalone: model loaded from the bundle and produced ${vector.length} dimensions ` +
    `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
