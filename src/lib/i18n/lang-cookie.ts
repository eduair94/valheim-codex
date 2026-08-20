import type { Lang } from './strings';

export const LANG_COOKIE = 'wv_lang';

export function parseLang(value: string | undefined | null): Lang {
  return value === 'en' ? 'en' : 'es';
}

/**
 * Persists the language in a cookie rather than localStorage so the server
 * component can read it during render. Reading it on the client instead would
 * mean the first paint is always Spanish and then flips, and would force a
 * state update inside an effect.
 */
export function setLangCookie(lang: Lang): void {
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=${oneYear}; samesite=lax`;
}
