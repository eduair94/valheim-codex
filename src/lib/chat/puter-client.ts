import { errorFromResponse } from './errors';
import { puterSignInErrorCode } from './puter-errors';
import { readStoredStrict, removeStored, type StorageLike } from './storage';

/**
 * puter.js, loaded only when the reader chooses Puter.
 *
 * The SDK is about 140 KB compressed and has side effects on import: it
 * installs `globalThis.puter`, listens to every `message` event and, unless
 * told otherwise, opens a socket to Puter for file-system events this app
 * never uses. So it is never part of a page bundle: it is imported on demand,
 * in the browser only, with the socket switched off first. The version is
 * pinned in package.json (2.6.4); the CDN script changes without notice.
 *
 * `PuterLike` is the slice of the SDK the chat uses, so the transport can be
 * tested against a stand-in, and so a page that already has an SDK instance
 * (a test's stub, or the script-tag build) reuses it instead of loading a
 * second one.
 */

export type PuterChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type PuterChatOptions = {
  model: string;
  stream: true;
  temperature: number;
  max_tokens: number;
  /** Not forwarded by puter.js 2.6.4; passed for when it is. The transport stops reading on abort itself. */
  signal?: AbortSignal;
};

/** One streamed chunk: `text`, `reasoning`, `usage`, `error`, … (`ChatResponseChunk`). */
export type PuterChatChunk = {
  type?: string;
  text?: string;
  message?: string;
  code?: string;
  status?: number;
  finish_reason?: string;
  stopReason?: string;
};

export type PuterSignInResult = { success?: boolean; token?: string; username?: string; error?: string; msg?: string };

export type PuterLike = {
  /** The app-under-user token puter.js holds for this site, once signed in. */
  authToken?: string | null;
  auth: {
    signIn(options?: { attempt_temp_user_creation?: boolean; request_auth?: boolean }): Promise<PuterSignInResult>;
    /** Synchronous; only says a token is stored, not that it is still valid. */
    isSignedIn(): boolean;
    /** Forgets the token in this browser; nothing is revoked at Puter. */
    signOut(): void;
  };
  ai: {
    chat(messages: PuterChatMessage[], options: PuterChatOptions): Promise<AsyncIterable<PuterChatChunk>>;
  };
};

export function isPuterLike(value: unknown): value is PuterLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { auth?: { signIn?: unknown; isSignedIn?: unknown }; ai?: { chat?: unknown } };
  return (
    typeof candidate.auth?.signIn === 'function' &&
    typeof candidate.auth.isSignedIn === 'function' &&
    typeof candidate.ai?.chat === 'function'
  );
}

let loading: Promise<PuterLike> | null = null;
let loaded: PuterLike | null = null;

/**
 * The SDK, loading it on first use. Call it early — on pointer-enter or focus
 * of the Puter button — so that by the click it is in memory and
 * `signIn()` can open its popup inside the click, where browsers allow it.
 */
export function loadPuter(): Promise<PuterLike> {
  if (typeof window === 'undefined') return Promise.reject(new Error('puter.js runs in the browser only'));
  if (!loading) {
    loading = (async () => {
      const existing = (globalThis as { puter?: unknown }).puter;
      if (isPuterLike(existing)) return existing;
      // Read by the SDK's constructor (`socketEnabled`), so it must be set before the import runs.
      (globalThis as { puter_socket_enabled?: boolean }).puter_socket_enabled = false;
      const sdk = await import('@heyputer/puter.js');
      // The SDK's overloaded signatures are wider than the slice used here.
      return sdk.puter as unknown as PuterLike;
    })().then(
      (puter) => {
        loaded = puter;
        return puter;
      },
      (error: unknown) => {
        // A failed chunk load (offline, a deploy in between) may succeed later.
        loading = null;
        throw error;
      },
    );
  }
  return loading;
}

/** The SDK if it has already loaded, without starting a load. */
export function loadedPuter(): PuterLike | null {
  return loaded;
}

/**
 * Where puter.js 2.6.4 keeps this site's Puter token on a web page
 * (`STORAGE_KEY_V2` and `STORAGE_KEY_ORIGIN_V2` in its `src/index.js`).
 *
 * Each tab's SDK reads the token from there once, when it loads, and from
 * then on uses its own copy in memory: a sign-out in another tab removes the
 * stored one and never reaches the others (the SDK has no `storage`
 * listener). What is stored is therefore what this browser holds now; a
 * tab's copy may be stale.
 */
export const PUTER_TOKEN_KEY = 'puter.auth.token.v2';
const PUTER_TOKEN_ORIGIN_KEY = 'puter.auth.token.origin.v2';

/**
 * The Puter token this browser holds now, shared by every tab: null when
 * there is none, undefined where storage cannot be read (then each tab's
 * SDK has only its own copy, and nothing is shared to compare it with).
 */
export function storedPuterToken(storage?: StorageLike | null): string | null | undefined {
  return readStoredStrict(PUTER_TOKEN_KEY, storage);
}

/**
 * Forgets the Puter token in this browser: in this tab's SDK, if it has
 * loaded, and in storage, which every other tab and the next page load read,
 * even when this tab never loaded the SDK. Nothing is revoked at Puter.
 */
export function forgetPuterToken(storage?: Pick<Storage, 'removeItem'> | null): void {
  try {
    loadedPuter()?.auth.signOut();
  } catch {
    // The stored copy below is the one that matters to other tabs.
  }
  removeStored(PUTER_TOKEN_KEY, storage);
  removeStored(PUTER_TOKEN_ORIGIN_KEY, storage);
}

export type PuterConnectResult = { ok: true; name: string } | { ok: false; code: string; retryAfter?: number };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Hands a Puter token to this site, which checks it with Puter (who it
 * belongs to, and that it was issued to this site) and answers with its own
 * cookie. The token itself is not kept on the server.
 */
export async function exchangePuterToken(token: string, fetchImpl: FetchLike = fetch): Promise<PuterConnectResult> {
  let response: Response;
  try {
    response = await fetchImpl('/api/auth/puter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { ok: false, code: 'network' };
  }
  if (!response.ok) {
    const error = await errorFromResponse(response);
    return { ok: false, code: error.code, retryAfter: error.retryAfter };
  }
  const body = (await response.json().catch(() => null)) as { name?: unknown } | null;
  return { ok: true, name: typeof body?.name === 'string' ? body.name : '' };
}

/**
 * Signs in to Puter and connects this site to that account.
 *
 * `signIn()` is the first thing this does, synchronously, so when it is
 * called from a click handler the popup opens within the click. Any `await`
 * before it would spend the browser's user activation and get the popup
 * blocked (puter.js then falls back to a consent dialog of its own: one more
 * tap). `requestAuth` lets the reader pick another account, for when the one
 * Puter remembered is a guest account this site refuses.
 */
export async function connectPuter(
  puter: PuterLike,
  options: { requestAuth?: boolean; fetchImpl?: FetchLike } = {},
): Promise<PuterConnectResult> {
  let token: string | undefined;
  try {
    // `signIn` is evaluated before the first `await` suspends: still inside the click.
    token = (await puter.auth.signIn(options.requestAuth ? { request_auth: true } : undefined))?.token;
  } catch (error) {
    return { ok: false, code: puterSignInErrorCode(error) };
  }
  if (!token) return { ok: false, code: 'puter_failed' };
  return exchangePuterToken(token, options.fetchImpl);
}

/**
 * True in an installed app (home-screen PWA), where the sign-in popup is the
 * weak point: iOS has broken `window.opener` for such popups since 17.5, and
 * Android opens new windows in an in-app browser. There the reader is offered
 * the chat in the browser instead.
 */
export function isStandaloneDisplay(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return (
      window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (navigator as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}
