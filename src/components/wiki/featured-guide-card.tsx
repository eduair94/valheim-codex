import Link from 'next/link';
import { strings, type Lang } from '@/lib/i18n/strings';

/**
 * The one entry point to the completion guide.
 *
 * Not a fourth tab: `TabBar` is deliberately three destinations, and this is
 * one page, not a section of the app. It sits where a new reader's eye
 * already lands — above the browsing axes on both the home and browse tabs —
 * so it is found by looking, not by knowing it exists.
 */
export function FeaturedGuideCard({ lang }: { lang: Lang }) {
  const t = strings(lang);
  return (
    <Link
      href="/wiki/guide"
      className="mb-5 flex items-center gap-3 rounded-md border border-moss bg-peat px-3.5 py-3 transition-colors hover:border-forge/50 hover:bg-moss/40"
    >
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-moss bg-bog font-mono text-sm text-forge"
      >
        ᛦ
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[0.92rem] text-birch">{t.wikiGuideTitle}</span>
        <span className="mt-0.5 block text-[0.78rem] leading-snug text-ash">{t.wikiGuideTeaser}</span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-ash">
        →
      </span>
    </Link>
  );
}
