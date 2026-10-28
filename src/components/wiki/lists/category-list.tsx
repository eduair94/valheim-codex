import Link from 'next/link';
import type { ArticleSummary } from '@/lib/db/wiki-repo';
import type { Lang } from '@/lib/i18n/strings';
import { articleHref } from '@/lib/routes';
import { facetLine } from './format';
import { WikiImage } from './wiki-image';

/**
 * A category's articles, as an index: the name, then what the thing is.
 *
 * One column on a phone; two from a tablet, three from 1280px, where a single
 * column of 158 rows was eleven screens of short lines with most of the width
 * empty. Rows rather than boxed cards: this is a directory, and a hairline
 * between entries is all the structure it needs. Each row's hover reaches 8px
 * past the text on both sides, so the names line up with the heading above.
 *
 * In Spanish the Spanish name leads and the English one follows, muted, as in
 * the search results — a reader who knows either recognises the row, and the
 * article they open has the same name. A name or a lead that is still English
 * says so (`lang="en"`), so a screen reader does not voice it as Spanish.
 *
 * Rows do not prefetch on sight. A category shows up to a few hundred of
 * them, and each would have been a request for a page nobody asked for;
 * pointing at or touching a row still prefetches the one about to be opened.
 */
export function CategoryList({ articles, lang }: { articles: ArticleSummary[]; lang: Lang }) {
  return (
    // `grid-cols-1` and not the implicit column: that one is sized to its
    // content, and an unbroken name pushed it past the screen.
    <ul className="grid grid-cols-1 gap-x-8 md:grid-cols-2 xl:grid-cols-3">
      {articles.map((article) => {
        const spanish = lang !== 'en';
        const lead = article.lead || facetLine(article.facets, lang);
        return (
          <li key={article.slug} className="border-t border-moss/70">
            <Link
              href={articleHref(article.slug)}
              prefetch={false}
              className="-mx-2 flex items-start gap-3 rounded-md px-2 py-3 transition-colors hover:bg-peat focus-visible:bg-peat"
            >
              <span className="flex h-10 w-10 shrink-0 overflow-hidden rounded-sm border border-moss bg-peat">
                {article.icon ? (
                  <WikiImage url={article.icon} drawn={[36]} width={36} height={36} className="m-auto h-9 w-9 object-contain" />
                ) : (
                  <span aria-hidden="true" className="m-auto text-xs text-ash">
                    ᛚ
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                {/*
                 * The English name follows on the same line when it fits and
                 * drops below when it does not: squeezed beside a long Spanish
                 * name it used to be cut to "Sta…", which says nothing. The
                 * name itself takes two lines before it gives up any of its
                 * words: cut to one, "Cuenco gourmet de las Tierras Cenic…"
                 * was the row's only name a Spanish reader had.
                 */}
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span
                    lang={spanish && !article.englishTitle ? 'en' : undefined}
                    className="line-clamp-2 min-w-0 max-w-full leading-snug wrap-break-word text-birch"
                  >
                    {article.title}
                  </span>
                  {spanish && article.englishTitle ? (
                    <span lang="en" className="max-w-full truncate text-xs leading-snug text-ash">
                      {article.englishTitle}
                    </span>
                  ) : null}
                </span>
                {lead ? (
                  <span
                    lang={spanish && article.lead && article.translated === false ? 'en' : undefined}
                    className="mt-1 line-clamp-1 text-sm leading-snug text-ash sm:line-clamp-2"
                  >
                    {lead}
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
