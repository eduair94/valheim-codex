import Link from 'next/link';
import { GUIDE_HREF } from '@/components/shell/nav-model';
import { BROWSE_COPY } from '@/lib/i18n/browse-copy';
import type { Lang } from '@/lib/i18n/strings';

/**
 * The completion guide, put where a new reader's eye already lands.
 *
 * Guía is a tab of its own, but a tab's label says nothing about what is
 * behind it, and a first-time reader does not go looking for a checklist they
 * do not know exists. So the guide is also offered once, between the search
 * and the browsing axes, on the home and browse pages: found by looking, not
 * by knowing. The guide is written in both languages, so the card is the same
 * in both.
 *
 * As wide as the search field above it rather than the page: it belongs with
 * the search, and one line of copy stretched over a desktop reads as a banner.
 */
export function FeaturedGuideCard({ lang }: { lang: Lang }) {
  // `BROWSE_COPY`, not the whole table: kept light should a client component
  // ever render it again. Today only the server does (home and browse pages).
  const t = BROWSE_COPY[lang];
  return (
    <Link
      href={GUIDE_HREF}
      className="group mb-8 flex max-w-2xl items-center gap-4 rounded-md border border-moss bg-peat px-4 py-3 transition-colors hover:border-forge/50 hover:bg-moss/40"
    >
      <span
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-moss bg-bog font-mono text-base text-forge"
      >
        ᛦ
      </span>
      <span className="min-w-0 flex-1">
        <span className="block leading-snug text-birch">{t.wikiGuideTitle}</span>
        <span className="mt-1 block text-sm leading-snug text-ash">{t.wikiGuideTeaser}</span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-ash transition-colors group-hover:text-forge">
        →
      </span>
    </Link>
  );
}
