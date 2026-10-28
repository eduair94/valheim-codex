import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { strings, type Strings } from '../../src/lib/i18n/strings';

/**
 * Whether the Gemini free tier can serve a generation right now.
 *
 * The answer path depends on an external quota this suite does not control:
 * the free tier allows 20 generate_content requests per minute and a limited
 * daily budget. A test that fails because someone else used the quota reports
 * a defect that does not exist, so those tests skip with the reason instead.
 * Every test that does not need the model still runs.
 */
export async function skipIfModelQuotaExhausted(): Promise<void> {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!key) {
    test.skip(true, 'No Gemini API key configured.');
    return;
  }

  const model = process.env.GEMINI_ANSWER_MODEL ?? 'gemini-2.5-flash-lite';
  // The key goes in a header, never `?key=`: a URL ends up in error messages,
  // traces and logs, and the key with it.
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'ok' }] }],
      generationConfig: { maxOutputTokens: 5 },
    }),
  });

  if (response.status === 429) {
    test.skip(true, `Gemini quota exhausted for ${model}; the answer path cannot be exercised now.`);
  }
}

/**
 * The chat's error bar: the sentence above the question field when a
 * question failed (`Dock`, src/components/chat/dock.tsx).
 *
 * Inside `main`, and with words in it: Next renders a `role="alert"` of its
 * own, the route announcer, which is empty and outside the page's landmark.
 */
export function chatErrorBar(page: Page): Locator {
  return page.locator('main').getByRole('alert').filter({ hasText: /\S/ });
}

/**
 * The error bar's sentences that put a failure on the model providers of the
 * moment rather than on the app (`describeFailure`, src/lib/chat/errors.ts):
 * every provider at its limit (`providers_exhausted`), a rate limit, the
 * server unable to take the question, a model too slow or cut off, a model
 * with nothing to say, and a stream error with no code at all.
 */
const PROVIDER_FAILURES = [
  'errorRateLimited',
  'chatErrorRateLimited',
  'chatErrorRateLimitedWait',
  'chatErrorUnavailable',
  'chatErrorTimeout',
  'chatErrorInterrupted',
  'chatErrorEmptyAnswer',
  'errorGeneric',
] as const satisfies readonly (keyof Strings)[];

/** A sentence from the copy as a pattern; `{wait}` ("41 segundos") is any wait. */
function sentencePattern(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{wait\\}', '.+');
  return new RegExp(`^${escaped}$`);
}

function isProviderFailure(sentence: string): boolean {
  return (['es', 'en'] as const).some((lang) =>
    PROVIDER_FAILURES.some((key) => sentencePattern(strings(lang)[key]).test(sentence)),
  );
}

/**
 * Skips when the model call failed after retrieval already succeeded.
 *
 * `skipIfModelQuotaExhausted` can only prove the quota existed a moment
 * earlier: the free tier allows 20 generate_content requests per minute, and a
 * suite that asks several questions can cross that line between the pre-flight
 * check and the call under test. The app then shows its error bar with the
 * sources still listed, and the run would report a defect that does not exist.
 *
 * Waits for whichever comes first, a citation or the error bar. The bar names
 * what went wrong, so only a failure of the model providers skips (a quota, a
 * timeout, the server busy: `isProviderFailure`); any other sentence — the
 * session ended, the question refused — fails the test with that sentence, and
 * a genuinely broken answer path that shows neither still fails on the wait.
 */
export async function skipIfGenerationFailed(page: Page): Promise<void> {
  const failure = chatErrorBar(page);
  const citation = page.locator('article').last().locator('.rune-chip').first();

  await expect(citation.or(failure).first()).toBeVisible({ timeout: 60_000 });
  if (!(await failure.first().isVisible())) return;

  const sentence = ((await failure.first().textContent()) ?? '').trim();
  expect(isProviderFailure(sentence), `the chat refused the question: "${sentence}"`).toBe(true);
  test.skip(true, `The model call failed after retrieval succeeded ("${sentence}"): a provider's quota, most likely.`);
}

/**
 * Waits until React has hydrated `target`, so a click or a keystroke reaches
 * its handler.
 *
 * The server's HTML is on screen, and takes input, before the page's script
 * has run. Text typed then stays in the field without ever reaching the
 * component — React keeps it when it hydrates and takes it as the field's
 * value, so no change fires — and a click on a client-side control does
 * nothing at all. Under `next dev` a route can take seconds to hydrate after
 * its HTML is up. React marks each element it has hydrated with its props,
 * under `__reactProps$<id>`. `target` must match one element.
 */
export async function waitForHydration(target: Locator): Promise<void> {
  await target.waitFor({ state: 'attached' });
  await expect
    .poll(() => target.evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactProps$'))), {
      message: 'the page has hydrated',
      timeout: 60_000,
    })
    .toBe(true);
}

/**
 * Keeps the server from translating anything on a test's behalf.
 *
 * An untranslated article asks for its own translation once it is on screen,
 * for any reader allowed to (a password session, which most of these tests
 * run with), and the server then sends the article to a model provider: a
 * cost on the operator's accounts, for something no test here is about.
 * Answered in the browser instead, the way the server answers a spent
 * allowance, which the page takes as "not now" and does not repeat. Reads
 * (`GET`) go through.
 */
export async function refuseTranslations(context: BrowserContext): Promise<void> {
  await context.route(/\/api\/wiki\/translate(?:\?|$)/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'Retry-After': '3600' },
          body: JSON.stringify({ error: 'rate_limited', retryAfter: 3600 }),
        })
      : route.continue(),
  );
}
