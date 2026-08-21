'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { AUTHENTICATED_HOME, loginHref } from '@/lib/auth/access';
import { LangToggle } from '@/components/lang-toggle';
import { strings, type Lang } from '@/lib/i18n/strings';

/**
 * Primary navigation.
 *
 * A bottom bar on phones because that is where a thumb rests, and the whole
 * point of this reader is that it is usable one-handed mid-game. It becomes a
 * top bar on wider screens, where reaching the bottom edge is not a virtue.
 */
export function TabBar({ lang, authenticated }: { lang: Lang; authenticated: boolean }) {
  const t = strings(lang);
  const pathname = usePathname();

  /*
   * Reading needs no account; asking does. For a signed-out visitor the chat
   * tab goes to the login form rather than to the chat, which would only
   * bounce them back here — and it says so, so the password is not a surprise
   * sprung after the click.
   */
  const chatHref = (authenticated ? AUTHENTICATED_HOME : loginHref(AUTHENTICATED_HOME)) as Route;

  const tabs = [
    { key: 'search', href: '/wiki' as Route, label: t.wikiSearch, icon: '⌕', locked: false },
    { key: 'browse', href: '/wiki/browse' as Route, label: t.wikiBrowse, icon: '☰', locked: false },
    { key: 'chat', href: chatHref, label: t.wikiChat, icon: '✦', locked: !authenticated },
  ];

  const isActive = (key: string, href: string): boolean =>
    key === 'chat' ? pathname === AUTHENTICATED_HOME : pathname.startsWith(href);

  return (
    <nav
      aria-label={t.wiki}
      className="sticky bottom-0 z-30 border-t border-moss bg-peat/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:top-0 sm:bottom-auto sm:border-b sm:border-t-0 sm:pb-0"
    >
      <div className="mx-auto flex max-w-3xl items-center">
        <ul className="flex flex-1">
        {tabs.map((tab) => (
          <li key={tab.key} className="flex-1">
            <Link
              href={tab.href}
              aria-current={isActive(tab.key, tab.href) ? 'page' : undefined}
              className={`flex min-h-11 flex-col items-center justify-center gap-0.5 py-2.5 text-[0.7rem] transition-colors sm:min-h-0 sm:flex-row sm:gap-2 sm:text-sm ${
                isActive(tab.key, tab.href) ? 'text-forge' : 'text-ash hover:text-birch'
              }`}
            >
              <span aria-hidden="true" className="text-base leading-none">
                {tab.icon}
              </span>
              <span className="flex items-center gap-1">
                {tab.label}
                {tab.locked ? (
                  <span aria-hidden="true" className="text-[0.65rem] opacity-70">
                    🔒
                  </span>
                ) : null}
              </span>
              {tab.locked ? <span className="sr-only">{t.wikiChatLocked}</span> : null}
            </Link>
          </li>
        ))}
        </ul>

        {/*
         * Pinned to the end rather than made a fourth tab: it switches the
         * language of everything, it is not somewhere to navigate to.
         */}
        <LangToggle lang={lang} className="mr-3 ml-2 shrink-0 sm:mr-4" />
      </div>
    </nav>
  );
}
