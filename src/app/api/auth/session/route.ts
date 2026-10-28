import type { NextRequest } from 'next/server';
import { keyHint } from '@/lib/auth/byok';
import { resolvePrincipal } from '@/lib/auth/principal';
import { authJson } from '@/lib/auth/responses';
import { signInOptions } from '@/lib/auth/sign-in-options';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who the browser is signed in as, and which ways of signing in this server
 * offers — enough for the connect page and the chat header to render without
 * ever seeing a token or a key.
 *
 * Always 200: "nobody" is an answer, not an error, and a 401 here used to read
 * as a broken request in every client that only wanted to know.
 *
 * `name` is the display name when there is one: the profile for a password
 * session, the Puter username for Puter. `keyHint` is the last four
 * characters of a saved Gemini key — never more.
 *
 * `modes`, `byokModels` and `defaultByokModel` come from `signInOptions`,
 * which the connect page renders from too.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const [principal, { modes, byokModels, defaultByokModel }] = await Promise.all([
    resolvePrincipal((name) => request.cookies.get(name)?.value),
    signInOptions(),
  ]);

  return authJson({
    authenticated: principal !== null,
    mode: principal?.kind ?? null,
    profile: principal?.profile ?? null,
    name: principal?.kind === 'puter' ? principal.name : principal?.kind === 'password' ? principal.profile : null,
    keyHint: principal?.kind === 'byok' ? keyHint(principal.apiKey) : null,
    model: principal?.kind === 'byok' ? principal.model : null,
    modes,
    byokModels,
    defaultByokModel,
  });
}
