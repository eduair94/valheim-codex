import 'server-only';

import { cookies } from 'next/headers';
import { resolvePrincipal, type ChatPrincipal } from './principal';

/**
 * The chat principal for the current request, read from its cookies.
 *
 * Like `getSession`, every route handler and page calls this for itself; the
 * proxy's check is a convenience, never the boundary.
 */
export async function getChatPrincipal(): Promise<ChatPrincipal | null> {
  const store = await cookies();
  return resolvePrincipal((name) => store.get(name)?.value);
}
