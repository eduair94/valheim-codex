import type { Lang } from './strings';

export const LANG_COOKIE = 'wv_lang';

export function parseLang(value: string | undefined | null): Lang {
  return value === 'en' ? 'en' : 'es';
}

/**
 * The language a `Cookie` string asks for, or `null` when it names none.
 *
 * `null` rather than the Spanish default, so a caller can tell "the reader
 * chose Spanish" from "nobody has chosen yet".
 */
export function langFromCookieString(cookies: string): Lang | null {
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.split('=');
    if (name?.trim() !== LANG_COOKIE) continue;
    const value = rest.join('=').trim();
    return value === 'en' || value === 'es' ? value : null;
  }
  return null;
}

/** The language this browser's cookie holds right now (client only). */
export function readLangCookie(): Lang | null {
  try {
    return langFromCookieString(document.cookie);
  } catch {
    // A sandboxed document can refuse cookie access; nothing chosen, then.
    return null;
  }
}

/**
 * Persists the language in a cookie rather than localStorage so the server
 * component can read it during render. Reading it on the client instead would
 * mean the first paint is always Spanish and then flips, and would force a
 * state update inside an effect.
 *
 * It also moves `<html lang>` at once. The reader re-renders the root layout
 * on its refresh and would get there anyway, but the chat switches language
 * without asking the server, so without this a screen reader kept voicing
 * English answers with Spanish pronunciation for the rest of the visit.
 *
 * Finally it tells the service worker, which keeps a copy of the search page
 * to open when the network is gone: that copy should be in the language the
 * reader now reads in.
 */
export function setLangCookie(lang: Lang): void {
  const oneYear = 60 * 60 * 24 * 365;
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=${oneYear}; samesite=lax${secure}`;
  setDocumentLang(lang);
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'lang', lang });
  } catch {
    // No worker, or storage blocked: there is no offline copy to refresh.
  }
}

/** Marks the whole document as being in `lang`, for assistive technology and hyphenation. */
export function setDocumentLang(lang: Lang): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}
