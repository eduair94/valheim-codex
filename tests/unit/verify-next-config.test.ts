import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `next start` loads next.config.ts again when it boots instead of reading
 * the copy the build recorded, so a final image without the file runs on
 * Next's defaults and nothing notices. Two halves: the Dockerfile ships the
 * file and runs scripts/verify-next-config.mjs, and that script, run for real
 * against folders laid out like the image's /app, refuses exactly when
 * `next start` would drift from the build.
 *
 * Next does all the loading, so this also proves the repo's next.config.ts
 * loads the way `next start` loads it: no tsconfig, no TypeScript, only
 * Next's own SWC.
 */

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'verify-next-config.mjs');
const REPO_CONFIG = readFileSync(join(ROOT, 'next.config.ts'), 'utf8');
// As in the image, where `next build` and `next start` both run in production.
const ENV: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };

/**
 * What `next build` records in .next/required-server-files.json: the
 * configuration it loaded, less the path of the file. Made by Next's own
 * loader in the build phase, so the fixture follows Next's defaults rather
 * than freezing today's.
 */
const RECORD_BUILD = `
  const loadConfig = require('next/dist/server/config.js').default;
  const { PHASE_PRODUCTION_BUILD } = require('next/dist/shared/lib/constants.js');
  loadConfig(PHASE_PRODUCTION_BUILD, process.argv[1], { silent: true }).then((config) => {
    const { configFile, ...recorded } = config;
    process.stdout.write(JSON.stringify({ version: 1, config: recorded }));
  });
`;

let scratch = '';
let manifest = '';

beforeAll(() => {
  // In the system's temp folder, never inside the repo: Next looks for a
  // config file in every parent folder as well, and would find the repo's.
  scratch = mkdtempSync(join(tmpdir(), 'wv-next-config-'));
  const builder = join(scratch, 'builder');
  mkdirSync(builder);
  copyFileSync(join(ROOT, 'next.config.ts'), join(builder, 'next.config.ts'));
  copyFileSync(join(ROOT, 'package.json'), join(builder, 'package.json'));
  manifest = execFileSync(process.execPath, ['-e', RECORD_BUILD, builder], { cwd: ROOT, env: ENV, encoding: 'utf8' });
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** A folder laid out like the image's /app: package.json, the build's record, and maybe a config file. */
function app(files: { config?: string; manifest?: string | null } = {}): string {
  const dir = mkdtempSync(join(scratch, 'app-'));
  copyFileSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  mkdirSync(join(dir, '.next'));
  const recorded = files.manifest === undefined ? manifest : files.manifest;
  if (recorded !== null) writeFileSync(join(dir, '.next', 'required-server-files.json'), recorded);
  if (files.config !== undefined) writeFileSync(join(dir, 'next.config.ts'), files.config);
  return dir;
}

/** Runs the check the way the Dockerfile does: from the app folder, with no arguments. */
function verify(dir: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, env: ENV, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('verify-next-config.mjs', () => {
  it('passes an image that carries the next.config.ts it was built with', () => {
    const { status, output } = verify(app({ config: REPO_CONFIG }));
    expect(output).toContain('next start loads next.config.ts');
    expect(status).toBe(0);
  });

  it('fails an image without next.config.ts, naming the hardening the server would run without', () => {
    const { status, output } = verify(app());
    expect(status).toBe(1);
    expect(output).toContain('configFileName: the build used "next.config.ts"; next start finds no file');
    // What next.config.ts is there for: no X-Powered-By, no public image
    // optimizer, request bodies held to 64 KB.
    expect(output).toContain('poweredByHeader:');
    expect(output).toContain('images.unoptimized:');
    expect(output).toContain('experimental.proxyClientMaxBodySize:');
    expect(output).toContain("copy the builder's next.config.ts next to package.json");
  });

  it('fails an image whose next.config.ts is not the one the build used', () => {
    // The build's record changes rather than the file, so this holds whatever the repo's config sets.
    const recorded = JSON.parse(manifest) as { config: { generateEtags: boolean } };
    recorded.config.generateEtags = !recorded.config.generateEtags;
    const { status, output } = verify(app({ config: REPO_CONFIG, manifest: JSON.stringify(recorded) }));
    expect(status).toBe(1);
    expect(output).toContain(`generateEtags: the build used ${recorded.config.generateEtags}`);
    expect(output).not.toContain('configFileName:');
  });

  it('fails an image whose next.config.ts the server cannot load', () => {
    const { status, output } = verify(app({ config: 'export default {' }));
    expect(status).toBe(1);
    expect(output).toContain('next start cannot load next.config.ts');
  });

  it('fails, rather than passing unchecked, when the build left no record to compare with', () => {
    const { status, output } = verify(app({ config: REPO_CONFIG, manifest: null }));
    expect(status).toBe(1);
    expect(output).toContain('cannot read .next/required-server-files.json');
  });
});

/** The final stage's instructions, one per entry: comments dropped, continued lines joined, spaces collapsed. */
function runnerStage(): string[] {
  const lines = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line !== '' && !line.startsWith('#'));
  const start = lines.findIndex((line) => /^FROM \S+ AS runner$/i.test(line));
  expect(start, 'a stage named runner').toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('FROM '));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** Where in the final stage an instruction matching `pattern` sits; fails when there is none. */
function position(stage: string[], pattern: RegExp): number {
  const index = stage.findIndex((line) => pattern.test(line));
  expect(index, String(pattern)).toBeGreaterThan(-1);
  return index;
}

describe('the Dockerfile', () => {
  const COPY_CONFIG = /^COPY --from=builder (--chown=\S+ )?\/app\/next\.config\.ts \.\/next\.config\.ts$/;

  it('ships next.config.ts in the final stage, in the folder next start runs from', () => {
    const runner = runnerStage();
    expect(runner).toContain('WORKDIR /app');
    position(runner, COPY_CONFIG);
    position(runner, /^CMD \["node", "node_modules\/next\/dist\/bin\/next", "start"\]$/);
  });

  it('checks the configuration once everything next start reads is in place', () => {
    const runner = runnerStage();
    const check = position(runner, /^RUN node verify-next-config\.mjs\b/);
    expect(check).toBeGreaterThan(
      position(runner, /^COPY --from=builder (--chown=\S+ )?\/app\/scripts\/verify-next-config\.mjs \.\/verify-next-config\.mjs$/),
    );
    expect(check).toBeGreaterThan(position(runner, COPY_CONFIG));
    expect(check).toBeGreaterThan(position(runner, /^COPY --from=builder (--chown=\S+ )?\/app\/\.next \.\/\.next$/));
    expect(check).toBeGreaterThan(position(runner, /^COPY --from=proddeps (--chown=\S+ )?\/app\/node_modules \.\/node_modules$/));
  });
});
