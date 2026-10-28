/**
 * Proves `next start` will run with the configuration the image was built
 * with, before the image is considered built.
 *
 * `next build` records the configuration it used in
 * .next/required-server-files.json, but `next start` does not run on that
 * record: it loads next.config.* again from its working directory when it
 * boots and, when it finds none, runs on Next's defaults without a word.
 * Headers and redirects were compiled into the build, so they survive that.
 * The options only the running server reads do not, and in this app those are
 * hardening: no X-Powered-By, no image optimizer for anyone on the internet to
 * drive, request bodies buffered to 64 KB rather than 10 MB. Until this check
 * existed the image did ship without next.config.ts, and nothing failed: on
 * Next's defaults the container starts, answers and passes its health check.
 *
 * Runs in the final stage, so Next loads and transpiles the file exactly as
 * the container will: a missing SWC binary, or a file that does not parse,
 * fails here too.
 *
 * Usage: node verify-next-config.mjs [app directory; default: the current one]
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/**
 * Options `next start` takes from the file it loads at boot, never from the
 * build. `configFileName` alone tells whether a file was found at all
 * ("next.config.js" is the name Next reports when there is none); the others
 * tell whether it is the one the build used.
 */
const RUNTIME_OPTIONS = [
  'configFileName',
  'poweredByHeader',
  'compress',
  'generateEtags',
  'images',
  'experimental.proxyClientMaxBodySize',
];

const appDir = path.resolve(process.argv[2] ?? process.cwd());

// `next start` sets this before it loads the configuration, and the file may read it.
process.env.NODE_ENV ??= 'production';

// The Next beside this script: /app/node_modules in the image, the copy the
// container boots, loaded the way `next start` loads its configuration.
const require = createRequire(import.meta.url);
const loadConfig = require('next/dist/server/config.js').default;
const { PHASE_PRODUCTION_SERVER } = require('next/dist/shared/lib/constants.js');

const pick = (config, option) => option.split('.').reduce((value, key) => value?.[key], config);

/** As it would be written to JSON, the form the build recorded it in. */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Each value that differs, down to the leaf, as [option, built, live]. */
function differences(option, built, live) {
  if (isObject(built) && isObject(live)) {
    const keys = new Set([...Object.keys(built), ...Object.keys(live)]);
    return [...keys].flatMap((key) => differences(`${option}.${key}`, built[key], live[key]));
  }
  return isDeepStrictEqual(built, live) ? [] : [[option, built, live]];
}

let built;
try {
  built = JSON.parse(readFileSync(path.join(appDir, '.next', 'required-server-files.json'), 'utf8')).config;
} catch (error) {
  console.error('verify-next-config: cannot read .next/required-server-files.json, the configuration the build used.');
  console.error(error.message);
  process.exit(1);
}

const fileName = built?.configFileName ?? 'next.config';

let live;
try {
  live = await loadConfig(PHASE_PRODUCTION_SERVER, appDir, { silent: true });
} catch (error) {
  console.error(`verify-next-config: next start cannot load ${fileName} in ${appDir}.`);
  console.error(error.message);
  process.exit(1);
}

const drift = RUNTIME_OPTIONS.flatMap((option) =>
  differences(option, plain(pick(built, option)), plain(pick(live, option))),
);

if (drift.length > 0) {
  console.error(`verify-next-config: next start in ${appDir} would not run with the configuration the build used.`);
  for (const [option, was, would] of drift) {
    // With no file, Next still reports a name: the one it would have looked for first.
    const instead = option === 'configFileName' && !live.configFile ? 'finds no file' : `would use ${JSON.stringify(would)}`;
    console.error(`  ${option}: the build used ${JSON.stringify(was)}; next start ${instead}`);
  }
  console.error(`next start reads ${fileName} when it boots: copy the builder's ${fileName} next to package.json.`);
  process.exit(1);
}

console.log(`verify-next-config: next start loads ${live.configFileName} in ${appDir} with the options the build used`);
