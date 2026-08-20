'use client';

import Link from 'next/link';
import type { Citation } from '@/lib/db/schema';
import { rune, strings, type Lang } from '@/lib/i18n/strings';
import type { Route } from 'next';
import { citationHref } from '@/lib/routes';

/**
 * The source list under an answer.
 *
 * This is the signature element: in Valheim, lore is read off runestones, and
 * in a grounded assistant the sources are the lore. Each row carries its
 * Futhark ordinal and its numeral — the rune for recognition at a glance, the
 * numeral so a marker in the text can still be matched by eye.
 */
export function Sources({
  citations,
  lang,
  activeCitation,
  onCitationHover,
}: {
  citations: Citation[];
  lang: Lang;
  activeCitation: number | null;
  onCitationHover: (n: number | null) => void;
}) {
  if (citations.length === 0) return null;
  const t = strings(lang);

  return (
    <section className="mt-5 max-w-[68ch]" aria-label={t.sources}>
      <div className="mb-2 flex items-center gap-3">
        <span className="label">{t.sources}</span>
        <span className="h-px flex-1 bg-moss" aria-hidden="true" />
      </div>

      <ul className="flex flex-col gap-1">
        {citations.map((c) => {
          /*
           * Prefer the in-app article: it is the reason the reader exists, it
           * opens instantly, and it works offline. Falling back to the original
           * wiki keeps a citation useful for a page that has no reading
           * document yet.
           */
          const rowProps = {
            className:
              'source-row group flex items-center gap-3 rounded-sm border border-transparent px-2 py-1.5 transition-colors hover:border-moss hover:bg-peat',
            'data-active': activeCitation === c.n,
            onMouseEnter: () => onCitationHover(c.n),
            onMouseLeave: () => onCitationHover(null),
            onFocus: () => onCitationHover(c.n),
            onBlur: () => onCitationHover(null),
          };

          const link = citationHref(c);

          const body = (
            <>
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-forge/30 bg-forge/10 text-sm text-forge"
                aria-hidden="true"
              >
                {rune(c.n)}
              </span>
              <span className="font-mono text-[0.7rem] text-ash">{c.n}</span>
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="text-birch">{c.title}</span>
                {c.sectionPath ? <span className="text-ash"> › {c.sectionPath}</span> : null}
              </span>
              <span
                className="shrink-0 text-ash opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                aria-label={t.openArticle}
              >
                {c.slug ? '›' : '↗'}
              </span>
            </>
          );

          return (
            <li key={c.n}>
              {link.internal ? (
                <Link href={link.href as Route} {...rowProps}>
                  {body}
                </Link>
              ) : (
                <a href={link.href} target="_blank" rel="noreferrer" {...rowProps}>
                  {body}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
