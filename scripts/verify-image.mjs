/**
 * Proves the image can actually embed, before it is considered built.
 *
 * Runs in the final stage, so it resolves modules and reads the model exactly
 * as the running container will. Two things this catches that a successful
 * `next build` does not:
 *
 *   - `onnxruntime-node` carries a native binary per platform, and an image
 *     built for the wrong architecture starts fine and fails on the first
 *     question;
 *   - the model cache is not a dependency, so a wrong copy path leaves the
 *     container to download 283 MB on its first question instead — which is
 *     exactly what happened when this path still carried the package version.
 *
 * Both are silent until someone asks something. A build failure is the cheapest
 * place to find them.
 */

const EXPECTED_DIMENSIONS = 768;

console.log(`verify-image: cwd=${process.cwd()}`);

let pipeline;
let env;
try {
  ({ pipeline, env } = await import('@huggingface/transformers'));
  if (process.env.MODEL_CACHE_DIR) env.cacheDir = process.env.MODEL_CACHE_DIR;
} catch (error) {
  console.error('verify-image: cannot resolve @huggingface/transformers.');
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
  console.error('verify-image: the model is not in the image, or the native runtime failed.');
  console.error(error.message);
  process.exit(1);
}

const output = await extractor(['passage: warm the model'], { pooling: 'mean', normalize: true });
const [vector] = output.tolist();

if (!vector || vector.length !== EXPECTED_DIMENSIONS) {
  console.error(
    `verify-image: expected ${EXPECTED_DIMENSIONS} dimensions, got ${vector?.length}.`,
  );
  process.exit(1);
}

console.log(
  `verify-image: model loaded from the image and produced ${vector.length} dimensions ` +
    `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
