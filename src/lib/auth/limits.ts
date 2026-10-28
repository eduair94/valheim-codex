import type { ChatPrincipal } from './principal';
import type { QuotaBucket } from './quota';

/**
 * The ceilings, in one place.
 *
 * Every number can be overridden with the environment variable named next to
 * it, so a deployment can loosen or tighten them without a code change.
 *
 * Guests (own Gemini key, Puter) pay for their model but not for retrieval,
 * which runs here. Their limits are per identity, per client address and
 * global per day — per identity alone is no ceiling at all, since minting a
 * new Puter account or a new key is free.
 *
 * Password chat is operator-paid. It gets a generous per-address cap and a
 * global daily one: the password is shared among friends, and if it leaks, the
 * daily ceiling is what keeps the bill bounded until it is rotated.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Env = Record<string, string | undefined>;

function envInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function chatBuckets(principal: ChatPrincipal, ip: string, env: Env = process.env): QuotaBucket[] {
  if (principal.kind === 'password') {
    return [
      { name: `chat:pw-ip:${ip}`, limit: envInt(env, 'CHAT_PASSWORD_PER_10MIN', 40), windowMs: 10 * MINUTE },
      { name: `chat:pw-ip:${ip}`, limit: envInt(env, 'CHAT_PASSWORD_PER_DAY', 400), windowMs: DAY },
      { name: 'chat:pw-global', limit: envInt(env, 'CHAT_PASSWORD_GLOBAL_PER_DAY', 2000), windowMs: DAY },
    ];
  }
  return [
    { name: `chat:guest:${principal.profile}`, limit: envInt(env, 'CHAT_GUEST_PER_MINUTE', 6), windowMs: MINUTE },
    { name: `chat:guest:${principal.profile}`, limit: envInt(env, 'CHAT_GUEST_PER_DAY', 150), windowMs: DAY },
    { name: `chat:guest-ip:${ip}`, limit: envInt(env, 'CHAT_GUEST_IP_PER_MINUTE', 15), windowMs: MINUTE },
    { name: `chat:guest-ip:${ip}`, limit: envInt(env, 'CHAT_GUEST_IP_PER_DAY', 400), windowMs: DAY },
    { name: 'chat:guest-global', limit: envInt(env, 'CHAT_GUEST_GLOBAL_PER_DAY', 3000), windowMs: DAY },
  ];
}

/**
 * Saving a Gemini key asks Google whether it works. Without a ceiling this
 * route would be a free validity oracle for stolen keys.
 */
export function byokRegisterBuckets(ip: string, env: Env = process.env): QuotaBucket[] {
  return [
    { name: `byok:register-ip:${ip}`, limit: envInt(env, 'BYOK_REGISTER_PER_MINUTE', 5), windowMs: MINUTE },
    { name: `byok:register-ip:${ip}`, limit: envInt(env, 'BYOK_REGISTER_PER_DAY', 30), windowMs: DAY },
  ];
}

/** Each Puter sign-in costs two calls to Puter's API. */
export function puterExchangeBuckets(ip: string, env: Env = process.env): QuotaBucket[] {
  return [
    { name: `puter:exchange-ip:${ip}`, limit: envInt(env, 'PUTER_EXCHANGE_PER_MINUTE', 10), windowMs: MINUTE },
    { name: `puter:exchange-ip:${ip}`, limit: envInt(env, 'PUTER_EXCHANGE_PER_DAY', 100), windowMs: DAY },
  ];
}

/**
 * Translating an article for a reader who is not signed in with the password.
 *
 * Operator-paid, but each article is translated once and then served to every
 * reader, so a small daily allowance steadily fills in the untranslated part
 * of the wiki. `PUBLIC_TRANSLATIONS_PER_DAY=0` turns it off.
 */
export function publicTranslationBuckets(ip: string, env: Env = process.env): QuotaBucket[] {
  return [
    { name: `translate:public-ip:${ip}`, limit: envInt(env, 'PUBLIC_TRANSLATIONS_PER_IP_PER_HOUR', 6), windowMs: HOUR },
    { name: 'translate:public-global', limit: envInt(env, 'PUBLIC_TRANSLATIONS_PER_DAY', 30), windowMs: DAY },
  ];
}

/** Password-session translation warm-ups: generous, but not unbounded. */
export function sessionTranslationBuckets(profile: string, env: Env = process.env): QuotaBucket[] {
  return [
    { name: `translate:pw:${profile}`, limit: envInt(env, 'SESSION_TRANSLATIONS_PER_HOUR', 60), windowMs: HOUR },
    { name: 'translate:pw-global', limit: envInt(env, 'SESSION_TRANSLATIONS_PER_DAY', 400), windowMs: DAY },
  ];
}
