import type { NextRequest } from 'next/server';
import { isSameOriginRequest } from '@/lib/auth/origin';
import { authError, authJson, clearAuthCookies } from '@/lib/auth/responses';

export const runtime = 'nodejs';

/**
 * Signs out of every method at once: the password session, a saved Gemini
 * key, a Puter session, and the pre-`__Host-` session cookie an older browser
 * may still carry.
 *
 * Two cookies stay, because they authorise nothing: the known-browser one
 * (`login-device.ts`), and the record of which history each Gemini key opens
 * (`byok-owner.ts`), which is how the same key, typed in again here, finds
 * its conversations.
 *
 * Checked for origin although it needs no cookie: a cross-site form could
 * otherwise sign anyone out at will.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return authError('forbidden_origin', 403);
  const response = authJson({ ok: true });
  clearAuthCookies(response);
  return response;
}
