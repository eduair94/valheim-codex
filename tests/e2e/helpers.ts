import { test } from '@playwright/test';

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
