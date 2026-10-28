import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { QuietBoundary } from '@/components/shell/quiet-boundary';
import { ServiceWorkerRegistration } from '@/components/shell/service-worker';
import { InstallPrompt } from '@/components/wiki/install-prompt';
import { OfflineBanner } from '@/components/wiki/offline-banner';
import { TabBar } from '@/components/wiki/tab-bar';
import { getChatPrincipal } from '@/lib/auth/principal-server';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings } from '@/lib/i18n/strings';

/**
 * The frame every reader page sits in: skip link, nav, notices, then the page.
 *
 * Document order is reading order at every width. The nav comes first even on
 * a phone, where it is fixed to the bottom edge; the notices sit above the
 * page, where they are seen, rather than after it.
 *
 * Shared by the wiki layout and the root 404 page, which Next renders outside
 * that layout and would otherwise leave as a bare page with no way back.
 */
export async function WikiFrame({ children }: { children: React.ReactNode }) {
  // No gate: the reader is public. Who is asking is still read, because the
  // chat tab leads to the chat for anyone signed in, by any method, and to the
  // sign-in page for everyone else. A broken cookie must never take the
  // reader down with it, so a failure reads as signed out.
  const [principal, cookieStore] = await Promise.all([getChatPrincipal().catch(() => null), cookies()]);
  const lang = parseLang(cookieStore.get(LANG_COOKIE)?.value);
  const t = strings(lang);

  return (
    // The top inset only matters when an installed app draws the status bar
    // over the page; `env()` is 0 in a browser tab. From 640px up the nav
    // carries it instead. The bottom padding keeps the end of every page
    // clear of the fixed tab bar on phones.
    <div className="flex min-h-dvh flex-col bg-bog pt-[env(safe-area-inset-top)] pb-(--tabbar-h) sm:pt-0">
      <a href="#main" className="skip-link">
        {t.shellSkipToContent}
      </a>
      {/*
       * In an installed iOS app the status bar is drawn over the page, so on
       * a phone, where the nav is at the bottom, the page scrolled under the
       * clock. This paints the bar's strip; it has no height in a tab.
       */}
      <div
        aria-hidden="true"
        className="fixed inset-x-0 top-0 z-40 h-[env(safe-area-inset-top)] bg-bog print:hidden sm:hidden"
      />
      <TabBar lang={lang} signedIn={principal !== null} />
      <QuietBoundary>
        <Suspense fallback={null}>
          <OfflineBanner lang={lang} />
        </Suspense>
        <InstallPrompt lang={lang} />
      </QuietBoundary>
      <main id="main" tabIndex={-1} className="shell-container flex-1 pt-5 pb-8 sm:pt-8">
        {children}
      </main>
      <ServiceWorkerRegistration />
    </div>
  );
}
