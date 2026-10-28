'use client';

import Form from 'next/form';
import { usePathname } from 'next/navigation';
import { useStrings } from '@/components/shell/lang-context';
import { searchTermsFromPath } from '@/components/shell/nav-model';
import type { Lang } from '@/lib/i18n/strings';

/**
 * A search box filled in with the missing address, spelled the way the
 * reader spelled it: one tap from finding out what the page is called now.
 *
 * A client component because a 404 page is given no params; the address is
 * only known from the URL itself.
 */
export function NotFoundSearch({ lang }: { lang: Lang }) {
  const t = useStrings(lang);
  const terms = searchTermsFromPath(usePathname());
  return (
    <Form action="/wiki" role="search" className="mt-4 flex gap-2">
      <label htmlFor="not-found-search" className="sr-only">
        {t.shellSearchLabel}
      </label>
      <input
        id="not-found-search"
        name="q"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        defaultValue={terms}
        placeholder={t.shellSearchPlaceholder}
        className="h-11 min-w-0 flex-1 rounded-md border border-moss bg-peat px-3 text-base text-birch transition-colors placeholder:text-ash hover:border-lichen focus:border-forge/60"
      />
      <button
        type="submit"
        className="inline-flex h-11 shrink-0 items-center rounded-md bg-forge px-4 text-sm text-bog transition-colors hover:bg-forge/90"
      >
        {t.wikiSearch}
      </button>
    </Form>
  );
}
