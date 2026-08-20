'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { strings, type Lang } from '@/lib/i18n/strings';

/**
 * Primary navigation.
 *
 * A bottom bar on phones because that is where a thumb rests, and the whole
 * point of this reader is that it is usable one-handed mid-game. It becomes a
 * top bar on wider screens, where reaching the bottom edge is not a virtue.
 */
export function TabBar({ lang }: { lang: Lang }) {
  const t = strings(lang);
  const pathname = usePathname();

  const tabs = [
    { href: '/wiki' as const, label: t.wikiSearch, icon: '⌕' },
    { href: '/wiki/browse' as const, label: t.wikiBrowse, icon: '☰' },
    { href: '/' as const, label: t.wikiChat, icon: '✦' },
  ];

  const isActive = (href: string): boolean =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <nav
      aria-label={t.wiki}
      className="sticky bottom-0 z-30 border-t border-moss bg-peat/95 backdrop-blur sm:top-0 sm:bottom-auto sm:border-b sm:border-t-0"
    >
      <ul className="mx-auto flex max-w-3xl">
        {tabs.map((tab) => (
          <li key={tab.href} className="flex-1">
            <Link
              href={tab.href}
              aria-current={isActive(tab.href) ? 'page' : undefined}
              className={`flex flex-col items-center gap-0.5 py-2.5 text-[0.7rem] transition-colors sm:flex-row sm:justify-center sm:gap-2 sm:text-sm ${
                isActive(tab.href) ? 'text-forge' : 'text-ash hover:text-birch'
              }`}
            >
              <span aria-hidden="true" className="text-base leading-none">
                {tab.icon}
              </span>
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
