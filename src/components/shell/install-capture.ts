/**
 * Catching Chrome's install offer before React is there to hear it.
 *
 * Chrome fires `beforeinstallprompt` once per page load, as soon as the page
 * qualifies, and on a repeat visit (manifest and worker already cached) that
 * can be before hydration. A listener added in an effect then misses it, and
 * the install button never appears for the people most likely to want it.
 *
 * So the root layout runs a few lines inline, while the HTML is parsed, that
 * keep the event on `window` and announce it. `InstallPrompt` reads from there.
 * The script is plain ES5 because it runs before any bundle loads.
 */

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

declare global {
  interface Window {
    __wvInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

/** Remembered per browser: whoever closed the banner once already chose. */
export const INSTALL_DISMISSED_KEY = 'wv-install-dismissed';
/** Fired on `window` whenever the kept event appears or is used up. */
export const INSTALL_CHANGE_EVENT = 'wv-install-change';

/**
 * Storage that is blocked or missing (Safari's "Block All Cookies", Chrome's
 * "block site data", an Android WebView with DOM storage off) throws on
 * access, and an uncaught throw here takes the whole reader down. Unreadable
 * counts as dismissed: a dismissal could never be saved there, so the banner
 * would otherwise return on every single page load.
 */
export function readInstallDismissed(): boolean {
  try {
    return window.localStorage.getItem(INSTALL_DISMISSED_KEY) === '1';
  } catch {
    return true;
  }
}

export function rememberInstallDismissed(): void {
  try {
    window.localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
  } catch {
    // Not saved; the banner is still closed for this visit.
  }
}

/**
 * Where the install banner lives: the reader, whose frame renders it.
 * Matches `/wiki` and everything under it, not look-alikes such as `/wikis`.
 */
const INSTALL_BANNER_PATH = /^\/wiki(\/|$)/;

/**
 * The inline script.
 *
 * It does nothing when the app is already installed or the banner was
 * dismissed, leaving the browser's own install affordance alone in those
 * cases, exactly as before. Nor does it take the offer anywhere but the
 * reader: the root layout runs it on every page, and catching the offer on
 * the chat or the sign-in page would only hide Chrome's own install bar where
 * nothing replaces it. The address is checked when the offer arrives rather
 * than when the page loads, because the reader can move between the two
 * without a page load. `appinstalled` covers an install made from the browser
 * menu instead of the banner: the offer is spent, and the banner should not
 * keep asking.
 */
export const INSTALL_CAPTURE_SCRIPT = `(function(){try{
var k=${JSON.stringify(INSTALL_DISMISSED_KEY)},n=${JSON.stringify(INSTALL_CHANGE_EVENT)},p=${INSTALL_BANNER_PATH.toString()};
if(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)return;
try{if(window.localStorage.getItem(k)==='1')return;}catch(e){return;}
function tell(){try{window.dispatchEvent(new Event(n));}catch(e){}}
window.addEventListener('beforeinstallprompt',function(e){if(!p.test(window.location.pathname))return;e.preventDefault();window.__wvInstallPrompt=e;tell();});
window.addEventListener('appinstalled',function(){window.__wvInstallPrompt=null;try{window.localStorage.setItem(k,'1');}catch(e){}tell();});
}catch(e){}})();`;
