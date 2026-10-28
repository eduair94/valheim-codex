import type { Route } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ConnectView, type CurrentConnection } from '@/components/connect/connect-view';
import { safeNext } from '@/lib/auth/access';
import { keyHint } from '@/lib/auth/byok';
import type { ChatPrincipal } from '@/lib/auth/principal';
import { getChatPrincipal } from '@/lib/auth/principal-server';
import { signInOptions } from '@/lib/auth/sign-in-options';
import { CONNECT_METHOD_COOKIE, rememberedConnectMethod } from '@/lib/chat/connect';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';

export const dynamic = 'force-dynamic';

function currentConnection(principal: ChatPrincipal): CurrentConnection {
  switch (principal.kind) {
    case 'password':
      return { mode: 'password', label: principal.profile };
    case 'byok':
      return { mode: 'byok', label: keyHint(principal.apiKey) };
    case 'puter':
      return { mode: 'puter', label: principal.name };
  }
}

/**
 * The connect page: the shared password, the reader's own Gemini key, or
 * their Puter account — each offered only when this server has it on.
 *
 * Someone already connected is sent on to `next`, unless they came to change
 * method (`?switch=1`, from the chat's "Cambiar método"). `next` was already
 * replaced by the proxy if it pointed off the site; it is checked again here
 * because this page, not the proxy, is what the browser follows afterwards.
 *
 * The method shown first is chosen here, not after hydration: `?method=`,
 * then the one this browser connected with last (`CONNECT_METHOD_COOKIE`).
 * The methods on offer are `GET /api/auth/session`'s, from the same helper
 * (`signInOptions`).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; switch?: string | string[]; method?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const principal = await getChatPrincipal();
  // A path on this site by construction (`safeNext`), which typed routes cannot see.
  if (principal && params.switch === undefined) redirect(next as Route);

  const [options, cookieStore] = await Promise.all([signInOptions(), cookies()]);

  return (
    <ConnectView
      lang={parseLang(cookieStore.get(LANG_COOKIE)?.value)}
      next={next}
      options={options}
      current={principal ? currentConnection(principal) : null}
      requestedMethod={typeof params.method === 'string' ? params.method : undefined}
      rememberedMethod={rememberedConnectMethod(cookieStore.get(CONNECT_METHOD_COOKIE)?.value)}
    />
  );
}
