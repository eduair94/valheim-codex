/**
 * JSON responses for the chat and conversation routes.
 *
 * Every one is about a single reader's conversations, so none may be stored
 * by a shared cache or kept by the browser's: `private, no-store` on all of
 * them, errors included. Errors are `{ error: code, ...extra }`, the shape
 * every route uses, so the client can map a code to its own copy instead of
 * showing a body.
 */

export const PRIVATE_NO_STORE = 'private, no-store';

export function privateJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': PRIVATE_NO_STORE, ...headers } });
}

export function jsonError(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return privateJson({ error: code, ...extra }, status, headers);
}

/** The same response with `Cache-Control: private, no-store`, for responses built elsewhere. */
export function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', PRIVATE_NO_STORE);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
