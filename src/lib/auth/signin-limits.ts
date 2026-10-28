import type { QuotaBucket } from './quota';

/**
 * Global daily ceilings for the two guest sign-ins, counted alongside the
 * per-address buckets of `limits.ts` in the same `consumeQuota` call.
 *
 * Per address alone, one IPv6 /48 is 65,536 "addresses": about two million
 * Gemini key checks a day, each made from this server's address with two
 * calls to Google, which makes the route the free, anonymising validity
 * oracle for stolen keys that its per-address limit was meant to prevent —
 * and puts the abuse on the address the operator's own key calls from. Puter
 * sign-ins are the same shape against Puter's API.
 *
 * The ceilings are far above real use (a Gemini key is registered once and
 * lasts 30 days; a Puter session lasts a day) and overridable. Reaching one
 * pauses that sign-in for everyone until the day turns, which is the trade
 * for a bound; neither touches the password or sessions already issued.
 *
 * Here rather than in `limits.ts` only because that file belongs to another
 * area while this work is in flight.
 */

const DAY = 24 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

function envInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function byokRegisterGlobalBuckets(env: Env = process.env): QuotaBucket[] {
  return [{ name: 'byok:register-global', limit: envInt(env, 'BYOK_REGISTER_GLOBAL_PER_DAY', 500), windowMs: DAY }];
}

export function puterExchangeGlobalBuckets(env: Env = process.env): QuotaBucket[] {
  return [{ name: 'puter:exchange-global', limit: envInt(env, 'PUTER_EXCHANGE_GLOBAL_PER_DAY', 1000), windowMs: DAY }];
}
