import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    // PGlite boots a WASM Postgres per suite; the default 5s is far too tight.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
