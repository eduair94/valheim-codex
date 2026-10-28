import type { Strings } from '@/lib/i18n/strings';
import { waitPhrase } from './errors';

/**
 * The connect page's decisions, kept out of the components so they can be
 * tested without a DOM.
 *
 * Three ways to chat, each offered only when this server says it is
 * available (`/api/auth/session` → `modes`):
 *
 * - `password`: the shared password of a crew; the server's models answer.
 * - `byok`: the reader's own Gemini API key; their Google account pays.
 * - `puter`: the reader's Puter account; the model runs in their browser.
 */

export type ConnectMethod = 'password' | 'byok' | 'puter';

/** Display order. The password first: it is what this site's own crew uses, and their browsers remember it. */
export const CONNECT_METHODS: readonly ConnectMethod[] = ['password', 'byok', 'puter'];

export type ConnectModes = Record<ConnectMethod, boolean>;

export function isConnectMethod(value: unknown): value is ConnectMethod {
  return typeof value === 'string' && (CONNECT_METHODS as readonly string[]).includes(value);
}

export function availableMethods(modes: ConnectModes): ConnectMethod[] {
  return CONNECT_METHODS.filter((method) => modes[method]);
}

/** The cookie naming the method this browser connected with last. */
export const CONNECT_METHOD_COOKIE = 'wv_connect';

const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * The cookie that remembers how this browser connected, so the connect page
 * opens on that method next time.
 *
 * A cookie, not storage, because the page is rendered on the server: a
 * choice only the browser could read put the password form on screen first
 * and switched panels after hydration, with its fields focusable — and typed
 * into, and thrown away — meanwhile, and the Puter SDK's preload starting
 * late. Sent to `/login` only, the one page that reads it; a preference, not
 * a credential, so it is not `httpOnly`.
 */
export function connectMethodCookie(method: ConnectMethod, secure: boolean): string {
  return `${CONNECT_METHOD_COOKIE}=${method}; path=/login; max-age=${ONE_YEAR}; samesite=lax${secure ? '; secure' : ''}`;
}

/** Remembers how this browser connected (`connectMethodCookie`). */
export function rememberConnectMethod(method: ConnectMethod): void {
  try {
    document.cookie = connectMethodCookie(method, location.protocol === 'https:');
  } catch {
    // A sandboxed document can refuse cookies: the page then opens on the first method.
  }
}

/** The remembered method a request's cookie names, or undefined. */
export function rememberedConnectMethod(value: string | undefined): ConnectMethod | undefined {
  return isConnectMethod(value) ? value : undefined;
}

/**
 * The connect page: `?switch=1` lets someone already connected in (the proxy
 * sends them on to `next` otherwise), `?method=` opens on one method, and
 * `next` is where to go afterwards, `/` when left out.
 */
export function connectPageHref(options: { next?: string; method?: ConnectMethod; switching?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (options.switching) params.set('switch', '1');
  if (options.method) params.set('method', options.method);
  if (options.next && options.next !== '/') params.set('next', options.next);
  const query = params.toString();
  return query ? `/login?${query}` : '/login';
}

/**
 * The method shown first: the one a link asked for (`?method=byok` from
 * "change key"), else the one this browser connected with last, else the
 * first on offer.
 */
export function initialMethod(input: {
  available: ConnectMethod[];
  requested?: unknown;
  remembered?: unknown;
}): ConnectMethod | null {
  const { available } = input;
  if (isConnectMethod(input.requested) && available.includes(input.requested)) return input.requested;
  if (isConnectMethod(input.remembered) && available.includes(input.remembered)) return input.remembered;
  return available[0] ?? null;
}

/**
 * The sentence for a sign-in failure, one per code the sign-in routes answer
 * with (header of `src/lib/i18n/copy/auth.ts`), plus the browser's own: the
 * network, and Puter's popup outcomes.
 */
export function connectErrorText(code: string, t: Strings, retryAfter?: number): string {
  switch (code) {
    case 'network':
      return t.errorNetwork;
    case 'rate_limited':
      return retryAfter ? t.authErrorRateLimited.replace('{wait}', waitPhrase(retryAfter, t)) : t.loginRateLimited;
    case 'invalid_credentials':
      return t.loginBadCredentials;
    case 'invalid_profile':
      return t.loginBadProfile;
    case 'server_misconfigured':
      return t.loginMisconfigured;
    case 'forbidden_origin':
      return t.authErrorForbiddenOrigin;
    case 'unavailable':
      return t.authErrorUnavailable;
    case 'unauthorized':
      return t.authErrorUnauthorized;
    case 'byok_disabled':
      return t.authErrorByokDisabled;
    case 'byok_key_invalid':
      return t.authErrorByokKeyInvalid;
    case 'byok_model_unavailable':
      return t.authErrorByokModelUnavailable;
    case 'byok_key_rate_limited':
      return t.authErrorByokKeyRateLimited;
    case 'byok_region_unavailable':
      return t.authErrorByokRegionUnavailable;
    case 'byok_unreachable':
      return t.authErrorByokUnreachable;
    case 'puter_disabled':
      return t.authErrorPuterDisabled;
    case 'puter_token_invalid':
      return t.authErrorPuterTokenInvalid;
    case 'wrong_audience':
      return t.authErrorPuterWrongAudience;
    case 'puter_account_required':
      return t.authErrorPuterAccountRequired;
    case 'puter_unreachable':
    case 'puter_unavailable':
      return t.authErrorPuterUnreachable;
    case 'puter_popup_blocked':
      return t.authErrorPuterPopupBlocked;
    case 'puter_auth_closed':
      return t.authErrorPuterWindowClosed;
    case 'puter_unsupported':
      return t.authErrorPuterUnsupported;
    case 'puter_auth_timeout':
      return t.authErrorPuterTimeout;
    case 'puter_load_failed':
      return t.authErrorPuterLoad;
    case 'puter_failed':
      return t.authErrorPuterFailed;
    default:
      return t.errorGeneric;
  }
}

/**
 * What the Puter panel offers after a failure, besides the message.
 *
 * - `other-account`: Puter remembered an account this site will not take (a
 *   guest one, or one issued to another site), so the popup is asked to let
 *   the reader pick another.
 * - `open-browser`: in an installed app the popup is the weak point (iOS
 *   breaks `window.opener` for home-screen apps, Android opens an in-app
 *   browser), so the chat is offered in the browser instead.
 * - `retry`: anything else worth a second try.
 */
export type PuterFollowUp = 'retry' | 'other-account' | 'open-browser';

export function puterFollowUps(code: string, standalone: boolean): PuterFollowUp[] {
  if (code === 'puter_account_required' || code === 'wrong_audience') return ['other-account'];
  if (code === 'puter_unsupported') return ['open-browser'];
  if (code === 'puter_disabled' || code === 'forbidden_origin') return [];
  const popup = code === 'puter_popup_blocked' || code === 'puter_auth_closed' || code === 'puter_auth_timeout';
  return popup && standalone ? ['retry', 'open-browser'] : ['retry'];
}

/** What the Puter panel's main button says and does. */
export type PuterButton = { label: 'connect' | 'retry' | 'other-account'; requestAuth: boolean };

/**
 * The main button, before any failure (`null`) or after one.
 *
 * After an account this site refuses (a guest one, or one issued to another
 * site), the same sign-in would hand back the same account — Puter skips its
 * account prompt for a site it has seen before — so the button itself asks
 * Puter to let the reader pick another (`request_auth`). It used to repeat
 * the refused sign-in, with the way out a small secondary button.
 */
export function puterButton(code: string | null): PuterButton {
  if (code === null) return { label: 'connect', requestAuth: false };
  const followUps = puterFollowUps(code, false);
  if (followUps.includes('other-account')) return { label: 'other-account', requestAuth: true };
  if (followUps.includes('retry')) return { label: 'retry', requestAuth: false };
  return { label: 'connect', requestAuth: false };
}
