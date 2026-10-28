import Link from 'next/link';
import { NotFoundSearch } from '@/components/shell/not-found-search';
import { BROWSE_HREF, GUIDE_HREF, SEARCH_HREF } from '@/components/shell/nav-model';
import { strings, type Lang } from '@/lib/i18n/strings';

/**
 * What a reader sees at an address that leads nowhere: a mistyped link, an
 * article renamed on the wiki since it was shared, a bookmark from before.
 *
 * Next's default was a bare white page in English with no way back, and an
 * installed app has no address bar to edit or back button to press. This
 * keeps the reader inside the app, offers the search they most likely want,
 * and the three places to start from otherwise.
 */
export function NotFoundView({ lang }: { lang: Lang }) {
  const t = strings(lang);
  const elsewhere = [
    { href: SEARCH_HREF, label: t.wikiSearch },
    { href: BROWSE_HREF, label: t.wikiBrowse },
    { href: GUIDE_HREF, label: t.wikiGuideTitle },
  ] as const;

  return (
    <section aria-labelledby="not-found-title" className="max-w-xl pt-2 pb-10 sm:pt-4">
      <p className="label text-forge">{t.shellNotFoundLabel}</p>
      <h1 id="not-found-title" className="display mt-2 text-2xl leading-tight text-balance text-birch sm:text-3xl">
        {t.shellNotFoundTitle}
      </h1>
      <p className="mt-4 text-ash">{t.shellNotFoundBody}</p>
      <NotFoundSearch lang={lang} />

      <h2 className="label mt-10">{t.shellNotFoundElsewhere}</h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {elsewhere.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="inline-flex h-11 items-center rounded-md border border-moss px-4 text-sm text-birch transition-colors hover:border-lichen hover:bg-peat"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
