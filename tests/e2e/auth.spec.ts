import { expect, test, type Page } from '@playwright/test';

/**
 * The sign-in flow, exercised from a signed-out browser.
 *
 * Kept in its own project so the rest of the suite can reuse one session:
 * login is rate limited to 10 attempts per IP per 15 minutes, and these are
 * the only tests that need to spend one.
 */

const PASSWORD = process.env.E2E_PASSWORD ?? 'valheim-dev-2026';
const PROFILE = 'E2E Tester';

async function signIn(page: Page, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Tu nombre').fill(PROFILE);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

test.describe('access control', () => {
  test('an anonymous visitor is sent to the login page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Valheim Codex' })).toBeVisible();
  });

  test('the API refuses an unauthenticated request', async ({ request }) => {
    for (const path of ['/api/conversations', '/api/ingest', '/api/auth/session']) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
    const chat = await request.post('/api/chat', {
      data: {
        conversationId: 'x',
        lang: 'es',
        messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'hola' }] }],
      },
    });
    expect(chat.status()).toBe(401);
  });

  test('a forged session cookie does not get in', async ({ page, context }) => {
    // An "alg: none" token with an admin claim: rejected by signature checking,
    // not merely by shape.
    await context.addCookies([
      {
        name: 'wv_session',
        value: 'eyJhbGciOiJub25lIn0.eyJwcm9maWxlIjoiYWRtaW4ifQ.',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('a wrong password is rejected and says so', async ({ page }) => {
    await signIn(page, 'not-the-password');
    // Next renders its own role="alert" route announcer, so match on the text.
    await expect(page.getByText('Contraseña incorrecta')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('signing in works, and the app remembers who you are', async ({ page }) => {
    await signIn(page, PASSWORD);
    await expect(page.getByPlaceholder('Preguntá sobre Valheim…')).toBeVisible();
    await expect(page.getByText(PROFILE)).toBeVisible();
  });
});
