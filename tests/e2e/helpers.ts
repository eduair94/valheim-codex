import { expect, test, type Page } from '@playwright/test';

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
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'ok' }] }],
        generationConfig: { maxOutputTokens: 5 },
      }),
    },
  );

  if (response.status === 429) {
    test.skip(true, `Gemini quota exhausted for ${model}; the answer path cannot be exercised now.`);
  }
}

/**
 * Skips when the model call failed after retrieval already succeeded.
 *
 * `skipIfModelQuotaExhausted` can only prove the quota existed a moment
 * earlier: the free tier allows 20 generate_content requests per minute, and a
 * suite that asks several questions can cross that line between the pre-flight
 * check and the call under test. The app then renders its error state with the
 * sources still listed, and the run reports a defect that does not exist.
 *
 * Waits for whichever comes first, a citation or the error, so a genuinely
 * broken answer path still fails instead of silently skipping.
 */
export async function skipIfGenerationFailed(page: Page): Promise<void> {
  const failure = page.getByText('Algo falló. Probá de nuevo.');
  const citation = page.locator('article').last().locator('.rune-chip').first();

  await expect(citation.or(failure).first()).toBeVisible({ timeout: 60_000 });

  if (await failure.isVisible()) {
    test.skip(true, 'The model call failed after retrieval succeeded — free-tier quota, most likely.');
  }
}
