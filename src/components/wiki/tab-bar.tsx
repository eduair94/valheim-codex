'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { LangToggle } from '@/components/lang-toggle';
import { NAV_SEARCH_ID, NavSearch } from '@/components/shell/nav-search';
import {
  BROWSE_HREF,
  chatHref,
  CRAFT_HREF,
  currentTab,
  GUIDE_HREF,
  SEARCH_HREF,
  type TabKey,
} from '@/components/shell/nav-model';
import { useStrings } from '@/components/shell/lang-context';
import { CRAFT_PLANNER_LIVE } from '@/lib/craft/feature';
import { plannerStore } from '@/lib/craft/planner-store';
import type { Lang } from '@/lib/i18n/strings';
import { useLocalStore } from '@/lib/local-store';

/** The search page's own field (`search-view.tsx`), which `/` prefers when it is there. */
const PAGE_SEARCH_ID = 'wiki-search';

const NO_BREAK_SPACE = String.fromCharCode(0xa0);

/**
 * Primary navigation.
 *
 * A bottom bar on phones because that is where a thumb rests, and the whole
 * point of this reader is that it is usable one-handed mid-game. From 640px it
 * is a top bar instead, where reaching the bottom edge is not a virtue, and
 * there is room to say whose app this is and to search from any page.
 *
 * It is first in the document at every width: on a phone it is fixed to the
 * bottom edge rather than moved there by reversing the page, which used to
 * drag the offline notice below the article and put the nav last in the tab
 * order.
 */
export function TabBar({ lang, signedIn }: { lang: Lang; signedIn: boolean }) {
  const t = useStrings(lang);
  const pathname = usePathname();
  const here = currentTab(pathname);
  // "Codex" alone until there is room: the installed app's own short name.
  const brandCut = t.appName.lastIndexOf(' ');
  /*
   * How many things the planner's list holds on this device. Null on the
   * server, which has no list, and in the browser's first render, which must
   * match the server's HTML; the count appears once the page has hydrated,
   * and follows the list in this tab and in others.
   */
  const planned = useLocalStore(plannerStore)?.items.length ?? 0;

  useSlashFocusesSearch();

  /*
   * Reading needs no account; asking does. A signed-out reader's chat tab
   * goes to the sign-in page and says so, so signing in is not a surprise
   * sprung after the tap.
   */
  const tabs: { key: TabKey; href: string; label: string; icon: string }[] = [
    { key: 'search', href: SEARCH_HREF, label: t.wikiSearch, icon: '⌕' },
    { key: 'browse', href: BROWSE_HREF, label: t.wikiBrowse, icon: '☰' },
    /*
     * ᚳ, the Anglo-Saxon cēn, "torch": the meaning of kenaz, the forge's
     * light. Not kenaz itself (ᚲ), which is already the sixth ordinal rune
     * (`rune(6)`: the Mistlands in the guide, an answer's sixth source).
     */
    ...(CRAFT_PLANNER_LIVE ? [{ key: 'craft' as const, href: CRAFT_HREF, label: t.shellCraft, icon: 'ᚳ' }] : []),
    // The rune the guide card on the home page already wears.
    { key: 'guide', href: GUIDE_HREF, label: t.shellGuide, icon: 'ᛦ' },
    { key: 'chat', href: chatHref(signedIn), label: t.wikiChat, icon: '✦' },
  ];

  return (
    <nav
      aria-label={t.wiki}
      className="fixed inset-x-0 bottom-0 z-30 h-(--tabbar-h) border-t border-moss bg-peat/95 pb-[env(safe-area-inset-bottom)] backdrop-blur print:hidden sm:sticky sm:top-0 sm:bottom-auto sm:h-(--nav-h) sm:border-t-0 sm:border-b sm:pt-[env(safe-area-inset-top)] sm:pb-0"
    >
      <div className="shell-container flex h-full items-center gap-1 max-sm:pr-2 max-sm:pl-0 sm:gap-4 lg:gap-6">
        {/* As tall as a fingertip on touch screens; the text alone is 20px. */}
        <Link
          href={SEARCH_HREF}
          aria-label={t.shellHome}
          className="display hidden shrink-0 items-center rounded-sm text-sm text-birch transition-colors hover:text-forge sm:inline-flex pointer-coarse:min-h-11"
        >
          {/* A no-break space: an ordinary one would collapse at the end of the flex item. */}
          <span className="sm:max-md:hidden">{`${t.appName.slice(0, brandCut)}${NO_BREAK_SPACE}`}</span>
          {t.appName.slice(brandCut + 1)}
        </Link>

        <ul className="flex h-full min-w-0 flex-1 sm:flex-none sm:gap-1">
          {tabs.map((tab) => {
            const current = here?.key === tab.key ? here.current : undefined;
            const locked = tab.key === 'chat' && !signedIn;
            const count = tab.key === 'craft' ? planned : 0;
            return (
              <li key={tab.key} className="flex min-w-0 flex-1 sm:flex-none">
                <Link
                  href={tab.href as Route}
                  aria-current={current}
                  className={`focus-inset relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-md px-1 text-xs leading-none transition-colors sm:flex-row sm:gap-2 sm:px-3 sm:text-sm ${
                    current ? 'text-forge' : 'text-ash hover:text-birch'
                  }`}
                >
                  {/*
                   * The count rides beside the rune on a phone, clear of
                   * its strokes and of the label under it, which has no
                   * width to spare at 360px; from 640px it follows the label.
                   */}
                  <span aria-hidden="true" className="relative text-base leading-none sm:hidden">
                    {tab.icon}
                    {count > 0 ? <TabCount count={count} className="absolute -top-1.5 left-full ml-0.5" /> : null}
                  </span>
                  <span className="flex max-w-full items-center gap-1">
                    <span className="truncate">{tab.label}</span>
                    {locked ? <LockGlyph /> : null}
                    {count > 0 ? <TabCount count={count} className="max-sm:hidden" /> : null}
                  </span>
                  {locked ? <span className="sr-only">, {t.shellChatNeedsSignIn}</span> : null}
                  {count > 0 ? <span className="sr-only">, {t.shellCraftCount.replace('{n}', String(count))}</span> : null}
                  {/*
                   * Colour alone would not do: forge and ash are close in
                   * lightness, so the current tab also gets a mark on the
                   * bar's edge, facing the page.
                   */}
                  {current ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-3 -top-px h-0.5 rounded-full bg-forge sm:top-auto sm:-bottom-px"
                    />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>

        {/*
         * The search takes whatever the tabs leave, up to 16rem, from 768px.
         * Between 640 and 767px five tabs beside the brand leave it too
         * little to type in, and the Search tab is one tap away.
         */}
        <div className="flex shrink-0 items-center gap-3 sm:min-w-0 sm:flex-1 sm:justify-end">
          {here?.key === 'search' ? null : (
            <NavSearch lang={lang} className="hidden min-w-0 flex-1 md:block md:max-w-64" />
          )}
          {/*
           * Not a tab: it switches the language of everything, it is not
           * somewhere to go. One button on a phone, so five tabs fit beside it.
           */}
          <LangToggle lang={lang} compact />
        </div>
      </div>
    </nav>
  );
}

/**
 * How many things the planner's list holds, on its tab. A count in the app's
 * quiet grammar for counts, monospace with tabular figures, set on a moss
 * plate so it reads at 12px over the bar: forge stays with the tab the reader
 * is on. Screen readers hear it in words after the tab's name instead.
 */
function TabCount({ count, className }: { count: number; className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-moss px-1 font-mono text-xs leading-none text-birch tabular-nums ${className}`}
    >
      {count}
    </span>
  );
}

function LockGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className="h-3 w-3 shrink-0 opacity-80"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
    >
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
      <path d="M4.25 5.5V4a1.75 1.75 0 0 1 3.5 0v1.5" />
    </svg>
  );
}

/**
 * `/` jumps to search, as it does on most sites with one, unless the reader
 * is typing somewhere already. The search page's own field wins when it is
 * on screen; otherwise the nav's, when it is shown at this width.
 */
function useSlashFocusesSearch(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const field = visibleField(PAGE_SEARCH_ID) ?? visibleField(NAV_SEARCH_ID);
      if (!field) return;
      event.preventDefault();
      field.focus();
      field.select();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function visibleField(id: string): HTMLInputElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement && element.getClientRects().length > 0 ? element : null;
}
