import { errorFromResponse } from './errors';

/**
 * Who the chat is answering, as the browser may know it.
 *
 * Built on the server from the principal, field by field: a reader's Gemini
 * key never leaves the server, only its last four characters (`keyHint`).
 * `profile` owns the history (`byok:<uuid>` and `puter:<uuid>` for guests).
 */
export type ChatAccount =
  | { mode: 'password'; profile: string }
  | {
      mode: 'byok';
      profile: string;
      keyHint: string;
      model: string;
      /** The models this server runs on a reader's key, and its default. */
      models: string[];
      defaultModel: string;
    }
  | { mode: 'puter'; profile: string; name: string };

export type ChatMode = ChatAccount['mode'];

export type ActionResult = { ok: true } | { ok: false; code: string; retryAfter?: number };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function send(
  path: string,
  init: { method: 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
  fetchImpl: FetchLike,
): Promise<{ ok: true; body: unknown } | { ok: false; code: string; retryAfter?: number }> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: init.method,
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    return { ok: false, code: 'network' };
  }
  if (!response.ok) {
    const error = await errorFromResponse(response);
    return { ok: false, code: error.code, retryAfter: error.retryAfter };
  }
  return { ok: true, body: await response.json().catch(() => null) };
}

/** Re-seals the reader's key with another model. Google is not asked again; a model the key cannot run shows on the next answer. */
export async function changeByokModel(
  model: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; model: string } | { ok: false; code: string; retryAfter?: number }> {
  const result = await send('/api/auth/byok', { method: 'PATCH', body: { model } }, fetchImpl);
  if (!result.ok) return result;
  const saved = (result.body as { model?: unknown } | null)?.model;
  return { ok: true, model: typeof saved === 'string' ? saved : model };
}

/** Deletes the cookie that was the key's only copy. */
export async function forgetByokKey(fetchImpl: FetchLike = fetch): Promise<ActionResult> {
  const result = await send('/api/auth/byok', { method: 'DELETE' }, fetchImpl);
  return result.ok ? { ok: true } : result;
}

/** Signs out of every method at once (`/api/auth/logout`). */
export async function signOutEverywhere(fetchImpl: FetchLike = fetch): Promise<ActionResult> {
  const result = await send('/api/auth/logout', { method: 'POST' }, fetchImpl);
  return result.ok ? { ok: true } : result;
}
