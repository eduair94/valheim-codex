import { publicTranslationBuckets, sessionTranslationBuckets } from '@/lib/auth/limits';
import { isOperatorPaid, type ChatPrincipal } from '@/lib/auth/principal';
import type { QuotaBucket } from '@/lib/auth/quota';

type Env = Record<string, string | undefined>;

/**
 * How many unusable replies a string is worth to each kind of reader.
 *
 * Signed-out readers share one small daily allowance. A string no model will
 * translate would otherwise take a unit of it on every Spanish view of its
 * page, for ever: after two attempts a public request leaves it out, and a
 * page with only such strings left is answered from what is stored, at no
 * cost. Password sessions try twice more; the bulk script tries everything
 * still missing on every run. The article page judges whether a request could
 * still help by the public figure, since its payload is the same for everyone.
 */
export const TRANSLATION_MAX_FAILURES = { public: 2, session: 4 } as const;

/**
 * Whose allowance a translation is counted against.
 *
 * Every translation is paid by the operator, whoever asks: a reader's own
 * Gemini key or Puter balance pays for their chat, never for the shared wiki.
 * What differs is the allowance. A password session gets the generous one; any
 * other reader — signed out, or signed in as a guest — shares a small public
 * one per address and per day. That is enough to fill in the untranslated part
 * of the wiki steadily, since each article is translated once and then served
 * to everyone, and too little to be worth abusing.
 */
export function translationBuckets(principal: ChatPrincipal | null, ip: string, env: Env = process.env): QuotaBucket[] {
  return isOperatorPaid(principal)
    ? sessionTranslationBuckets(principal.profile, env)
    : publicTranslationBuckets(ip, env);
}

/**
 * False when this deployment has turned translation off for this kind of
 * reader (a zero limit, e.g. `PUBLIC_TRANSLATIONS_PER_DAY=0`). A page can ask
 * before rendering anything that would request one, instead of making a
 * request that is certain to be refused.
 */
export function canRequestTranslation(principal: ChatPrincipal | null, env: Env = process.env): boolean {
  return translationBuckets(principal, 'unknown', env).every((bucket) => bucket.limit > 0);
}
