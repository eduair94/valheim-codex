import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

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
    baseURL: `http://127.0.0.1:${PORT}`,
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
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
