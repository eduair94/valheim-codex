import { chromium, type FullConfig } from '@playwright/test';

export const STORAGE_STATE = 'tests/e2e/.auth/state.json';

/**
 * Signs in once and saves the session for the whole run.
 *
 * The app rate limits login to 10 attempts per IP per 15 minutes, and a suite
 * that logged in per test tripped its own defence — every test after the tenth
 * failed with a 429 that looked like a broken login. Reusing a session is also
 * how the app is actually used, so this is the more faithful test as well as
 * the passing one.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL ?? 'http://127.0.0.1:3100';
  const password = process.env.E2E_PASSWORD ?? 'valheim-dev-2026';

  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });

  await page.goto('/login');
  await page.getByLabel('Tu nombre').fill('E2E Tester');
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForSelector('[placeholder="Preguntá sobre Valheim…"]', { timeout: 30_000 });

  await page.context().storageState({ path: STORAGE_STATE });
  await browser.close();
}
