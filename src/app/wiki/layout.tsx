import { cookies } from 'next/headers';
import { OfflineBanner } from '@/components/wiki/offline-banner';
import { TabBar } from '@/components/wiki/tab-bar';
import { getSession } from '@/lib/auth/server';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';

export const dynamic = 'force-dynamic';

export default async function WikiLayout({ children }: { children: React.ReactNode }) {
  // No gate: the reader is public. The session is still read, because the nav
  // needs to know whether the chat tab leads to the chat or to the password.
  const [session, cookieStore] = await Promise.all([getSession(), cookies()]);
  const lang = parseLang(cookieStore.get(LANG_COOKIE)?.value);

  return (
    <div className="flex min-h-dvh flex-col bg-bog sm:flex-col-reverse sm:justify-end">
      <OfflineBanner lang={lang} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-5 sm:px-6">{children}</main>
      <TabBar lang={lang} authenticated={session !== null} />
    </div>
  );
}
