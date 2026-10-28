import { NextResponse } from 'next/server';
import { BYOK_COOKIE } from './byok';
import { PUTER_COOKIE } from './puter';
import { authCookieOptions, clearedCookieOptions, LEGACY_AUTH_COOKIES, SESSION_COOKIE } from './session';

/**
 * Response and cookie plumbing shared by the sign-in routes.
 *
 * Every answer about who someone is must never be stored by a browser or a
 * CDN cache: a cached `Set-Cookie`, or a cached "signed in as …", would hand
 * one reader's session to the next. `next.config.ts` sets the same header on
 * these paths; the routes set it too so it holds wherever they are mounted.
 */

const NO_STORE = 'private, no-store';

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** A JSON answer that no cache may keep. */
export function authJson(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': NO_STORE, ...headers } });
}

/** `{ error: code, ...extra }`, the shape every route's failures share. */
export function authError(error: string, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return authJson({ error, ...extra }, status);
}

/** Re-sends a response built elsewhere (the shared 429/413/415s) with `no-store`. */
export function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', NO_STORE);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Every cookie that identifies someone to the chat, current and legacy. Not
 * the known-browser cookie (`login-device.ts`) nor the record of which
 * history a Gemini key opens (`byok-owner.ts`): neither signs anyone in, and
 * both exist to outlast a sign-out.
 */
const ALL_AUTH_COOKIES = [SESSION_COOKIE, BYOK_COOKIE, PUTER_COOKIE, ...LEGACY_AUTH_COOKIES];

export function setAuthCookie(response: NextResponse, name: string, value: string, maxAgeSeconds: number): void {
  response.cookies.set(name, value, authCookieOptions(isProduction(), maxAgeSeconds));
}

/**
 * Expires every auth cookie except `keep`.
 *
 * Each sign-in clears the other kinds, so a browser holds one way of being
 * signed in at a time and switching method never leaves a stale credential
 * behind. Expired with the attributes they were set with, never
 * `cookies.delete(name)`: that writes no `Secure`, and the browser refuses
 * to touch a `__Host-` cookie without it.
 */
export function clearAuthCookies(response: NextResponse, keep?: string): void {
  for (const name of ALL_AUTH_COOKIES) {
    if (name !== keep) response.cookies.set(name, '', clearedCookieOptions(isProduction()));
  }
}

/** Expires a single auth cookie. */
export function clearAuthCookie(response: NextResponse, name: string): void {
  response.cookies.set(name, '', clearedCookieOptions(isProduction()));
}
