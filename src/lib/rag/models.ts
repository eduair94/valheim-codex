/**
 * Gemini model selection.
 *
 * `gemini-2.5-flash` — the model this project was specified with — returns
 * `404: no longer available to new users` on keys created recently, and Google
 * redirects callers to the 3.x line. `gemini-2.5-flash-lite` is the member of
 * the 2.5 Flash family that new keys can still use, and it is also the fastest
 * of the available options, which matters when a single answer costs one
 * rewrite call plus one generation call.
 *
 * Measured on this project's key, one short prompt each:
 *
 *   gemini-2.5-flash        404, unavailable
 *   gemini-2.5-flash-lite   0.5 s text / 0.9 s structured
 *   gemini-3-flash-preview  1.5 s text / 1.8 s structured
 *   gemini-3.6-flash        43 s text / 34 s structured  (heavy default reasoning)
 *
 * Both are overridable so a key with different access, or a preference for the
 * larger model, needs no code change.
 */

/** Generates the grounded answer. */
export const ANSWER_MODEL = process.env.GEMINI_ANSWER_MODEL ?? 'gemini-2.5-flash-lite';

/**
 * Rewrites a question into search queries. A mechanical transformation, so the
 * cheapest, fastest model is the right one even if the answer model is larger.
 */
export const REWRITE_MODEL = process.env.GEMINI_REWRITE_MODEL ?? 'gemini-2.5-flash-lite';
