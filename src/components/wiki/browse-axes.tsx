import Link from 'next/link';
import type { CategorySummary } from '@/lib/db/wiki-repo';
import { strings, type Lang } from '@/lib/i18n/strings';
import { CategoryGrid } from './category-grid';

export type BrowseAxesData = {
  biomes: CategorySummary[];
  categories: CategorySummary[];
  stations: CategorySummary[];
};

/**
 * The three ways in.
 *
 * They are three because they answer three different questions, and the order
 * is the order those questions get asked: biomes are "where am I and what
 * lives there", which is the frame the whole game hangs on; categories are
 * "what kind of thing"; stations are "what can I make at this bench", which
 * only matters once you have one.
 *
 * The same component carries the front page and the browse tab. On the front
 * page each axis is cut to its useful head and says so with a link to the rest;
 * on the browse tab nothing is cut. One component, so the two pages cannot
 * drift into presenting the same thing two ways.
 */
export function BrowseAxes({
  lang,
  data,
  truncated = false,
}: {
  lang: Lang;
  data: BrowseAxesData;
  /** Whether the lists are a head, and each section should offer the rest. */
  truncated?: boolean;
}) {
  const t = strings(lang);
  const seeAll = truncated ? t.wikiSeeAll : null;

  return (
    <div className="flex flex-col gap-6">
      <Section title={t.wikiBiomes} hint={t.wikiBiomesHint}>
        {/* Ordered by the game's progression, so the numeral is the meaning. */}
        <CategoryGrid items={data.biomes} axis="biome" ordinals />
      </Section>

      <Section title={t.wikiCategories} seeAll={seeAll}>
        <CategoryGrid items={data.categories} axis="category" />
      </Section>

      <Section title={t.wikiStations} seeAll={seeAll}>
        <CategoryGrid items={data.stations} axis="station" />
      </Section>
    </div>
  );
}

function Section({
  title,
  hint,
  seeAll,
  children,
}: {
  title: string;
  hint?: string;
  seeAll?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-3">
        <h2 className="label">{title}</h2>
        <span className="h-px flex-1 bg-moss" aria-hidden="true" />
        {seeAll ? (
          <Link
            href="/wiki/browse"
            className="shrink-0 font-mono text-[0.62rem] tracking-wider text-ash transition-colors hover:text-forge"
          >
            {seeAll} →
          </Link>
        ) : null}
      </div>
      {hint ? <p className="mb-2.5 text-[0.78rem] leading-snug text-ash">{hint}</p> : null}
      {children}
    </section>
  );
}
