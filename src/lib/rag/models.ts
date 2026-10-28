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
 * company that serves open-weight models on its own inference chips.
 *
 * Measured on a free account: 200,000 tokens per day for this model, which at
 * roughly 3–4k tokens a question is fifty-odd questions. That is a different
 * shape of limit from Gemini's twenty requests a minute rather than a bigger
 * one — Gemini refuses in bursts and recovers within the minute, Groq is
 * steady until the day's budget is gone. Having both means the bursty limit
 * and the daily one rarely bite at the same moment.
 *
 * `gpt-oss-120b` because it was the one that worked: measured on this
 * project's prompt it answered in Spanish, cited correctly and honoured a
 * strict JSON schema, in about 900 ms. `qwen3.6-27b` on the same account
 * leaked its chain of thought into the reply.
 */

/** Generates the grounded answer. */
export const GROQ_ANSWER_MODEL = process.env.GROQ_ANSWER_MODEL ?? 'openai/gpt-oss-120b';

/** Rewrites a question into search queries. */
export const GROQ_REWRITE_MODEL = process.env.GROQ_REWRITE_MODEL ?? 'openai/gpt-oss-120b';

/*
 * Cerebras — the same open model on different silicon.
 *
 * Serves `gpt-oss-120b` too, which is what makes it worth having: if Groq is
 * saturated the chain reaches the identical model elsewhere, so the answer
 * does not change character when the provider does. Free tier, like Groq.
 */

/** Generates the grounded answer. */
export const CEREBRAS_ANSWER_MODEL = process.env.CEREBRAS_ANSWER_MODEL ?? 'gpt-oss-120b';

/** Rewrites a question into search queries. */
export const CEREBRAS_REWRITE_MODEL = process.env.CEREBRAS_REWRITE_MODEL ?? 'gpt-oss-120b';

/*
 * Deadlines and ceilings.
 *
 * Node's fetch gives up on a silent provider after 300 seconds, per provider,
 * and never on one that keeps the connection alive with SSE comments. That is
 * not a timeout a reader can wait out, and it kept the fallback chain from
 * ever engaging. So every model call carries its own deadline, and missing it
 * moves on to the next provider (or, for a reader's own key, ends the answer
 * with a timeout the reader can retry).
 *
 * The first-text deadline is generous on purpose: it covers connecting, the
 * prompt's time in the provider's queue and any thinking before the first
 * word. The default models answer in about a second; `gemini-3.6-flash`
 * measured 43 s above, so a deployment that selects a thinking model should
 * raise it.
 */

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Until the first word of an answer, per provider. */
export const FIRST_TEXT_TIMEOUT_MS = envMs('CHAT_FIRST_TEXT_TIMEOUT_MS', 15_000);

/** Between two pieces of an answer once it is flowing. */
export const CHUNK_TIMEOUT_MS = envMs('CHAT_CHUNK_TIMEOUT_MS', 20_000);

/** One provider's attempt at rewriting a question into search queries. */
export const REWRITE_ATTEMPT_TIMEOUT_MS = envMs('CHAT_REWRITE_TIMEOUT_MS', 6_000);

/**
 * The whole rewrite, every provider included. Past it the raw question is
 * searched instead: a slower or slightly worse answer beats none.
 */
export const REWRITE_TOTAL_TIMEOUT_MS = envMs('CHAT_REWRITE_TOTAL_TIMEOUT_MS', 10_000);

/**
 * Output ceiling for one answer. Grounded answers run a few hundred tokens;
 * this only bounds a runaway generation. Room is left for the reasoning
 * tokens gpt-oss spends before it writes, which count against the same limit.
 */
export const MAX_ANSWER_TOKENS = 4096;
