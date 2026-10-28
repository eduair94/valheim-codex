import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
/*
 * Against `next dev`, set E2E_BASE_URL=http://localhost:3100: the dev server
 * refuses its hot-reload socket to any other host, and without it no page
 * hydrates. A production build answers on either.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 120_000,
  expect: { timeout: 20_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  globalSetup: './tests/e2e/global-setup.ts',

  projects: [
    // Signed in via the session saved by globalSetup.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'tests/e2e/.auth/state.json' },
      testIgnore: /auth\.spec\.ts/,
    },
    // The sign-in flow itself, which must start signed out.
    {
      name: 'auth',
      use: { ...devices['Desktop Chrome'], storageState: { cookies: [], origins: [] } },
      testMatch: /auth\.spec\.ts/,
    },
  ],

  webServer: {
    // Production build: dev-mode compilation makes the first navigation slow
    // enough to look like a hang, and this is the artifact that ships anyway.
    command: `pnpm build && pnpm start --port ${PORT}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
