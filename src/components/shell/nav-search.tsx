'use client';

import Form from 'next/form';
import { useStrings } from '@/components/shell/lang-context';
import type { Lang } from '@/lib/i18n/strings';

/** The nav field's id, which the `/` shortcut looks for. */
export const NAV_SEARCH_ID = 'nav-search';

/**
 * Search from anywhere in the reader.
 *
 * Searching from an article used to take a tab to the search page, a tap into
 * its field and then the typing. This is a plain GET form to `/wiki?q=`, the
 * address the search page reads, so it also works before hydration; `next/form`
 * turns the submit into a client-side navigation once the page is live.
 *
 * Not shown on the search page itself, which has the big field already.
 */
export function NavSearch({ lang, className = '' }: { lang: Lang; className?: string }) {
  const t = useStrings(lang);
  return (
    <Form action="/wiki" role="search" className={`relative ${className}`}>
      <label htmlFor={NAV_SEARCH_ID} className="sr-only">
        {t.shellSearchLabel}
      </label>
      {/*
       * 16px on touch screens: iOS zooms the page into any focused field set
       * smaller, and this one shows on every iPhone held sideways. The right
       * padding is room for the `/` hint, which a touch screen never shows.
       */}
      <input
        id={NAV_SEARCH_ID}
        name="q"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-keyshortcuts="/"
        placeholder={t.shellSearchPlaceholder}
        className="peer h-9 w-full text-ellipsis rounded-md border border-moss bg-bog pr-9 pl-3 text-sm text-birch transition-colors placeholder:text-ash hover:border-lichen focus:border-forge/60 pointer-coarse:h-11 pointer-coarse:pr-3 pointer-coarse:text-base"
      />
      {/* The shortcut, shown where a keyboard is likely and only while the field is idle. */}
      <kbd
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded-sm border border-moss px-1.5 font-mono text-xs leading-5 text-ash pointer-fine:block peer-focus:hidden peer-not-placeholder-shown:hidden"
      >
        /
      </kbd>
    </Form>
  );
}
