/**
 * Model selection, per provider.
 *
 * Grok is tried first and Gemini second; see `provider.ts` for why there are
 * two. Every id is overridable so a key with different access, or a taste for
 * a larger model, needs no code change.
 *
 * ---
 *
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

/*
 * Grok.
 *
 * The non-reasoning variant on purpose. This is retrieval-augmented answering:
 * the facts arrive in the prompt already, so the work is reading a supplied
 * context and citing it, not deliberating. Reasoning variants spend seconds of
 * latency on a question that does not need them — the same trap that made
 * `gemini-3.6-flash` take 43 s above.
 */

/** Generates the grounded answer. */
export const GROK_ANSWER_MODEL = process.env.GROK_ANSWER_MODEL ?? 'grok-4.20-non-reasoning';

/** Rewrites a question into search queries. Mechanical, so the same fast model. */
export const GROK_REWRITE_MODEL = process.env.GROK_REWRITE_MODEL ?? 'grok-4.20-non-reasoning';

/*
 * OpenRouter — one key, every model, priced per token.
 *
 * Deliberately pointed at a paid model rather than a free one. The free tier
 * was measured and is not fit for this app:
 *
 *   openrouter/free              routes by availability, not capability — it
 *                                answered once from a coding model and once
 *                                from a content-safety classifier, which
 *                                replied "User Safety: safe"
 *   nemotron-3-nano-30b-a3b:free clean Spanish on a bare prompt, but leaks its
 *                                chain of thought on a RAG-shaped one, even
 *                                when told not to
 *   glm-5.2:free, gemma-4:free   429 "temporarily rate-limited upstream"
 *
 * A wrong answer is recoverable; raw reasoning rendered as the answer is not
 * something to ship. So this tier stays pointed at a real model: with no
 * credit on the key it returns 402 and the chain simply moves on, and the day
 * credit is added it becomes the strongest tier without a code change.
 */

/** Generates the grounded answer. */
export const OPENROUTER_ANSWER_MODEL = process.env.OPENROUTER_ANSWER_MODEL ?? 'x-ai/grok-4.3';

/** Rewrites a question into search queries. */
export const OPENROUTER_REWRITE_MODEL = process.env.OPENROUTER_REWRITE_MODEL ?? 'x-ai/grok-4.3';

/*
 * Groq — the free tier worth having alongside Gemini.
 *
 * Not to be confused with Grok, which is xAI's model; Groq is a hardware
 * company that serves open-weight models on its own inference chips. That is
 * the whole appeal here: it is genuinely fast, its free tier is measured in
 * thousands of requests a day rather than twenty a minute, and it honours JSON
 * mode, which the rewrite needs and the free models on OpenRouter did not.
 *
 * Llama 3.3 70B rather than a smaller one: this answers in Spanish from
 * English sources, and the small models tested for that job either translated
 * badly or ignored the instruction to cite.
 */

/** Generates the grounded answer. */
export const GROQ_ANSWER_MODEL = process.env.GROQ_ANSWER_MODEL ?? 'llama-3.3-70b-versatile';

/** Rewrites a question into search queries. */
export const GROQ_REWRITE_MODEL = process.env.GROQ_REWRITE_MODEL ?? 'llama-3.3-70b-versatile';
