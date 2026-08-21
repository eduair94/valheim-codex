import Link from 'next/link';
import type { CategorySummary } from '@/lib/db/wiki-repo';
import { strings, type Lang } from '@/lib/i18n/strings';
import { CategoryGrid, CategoryChips, type BrowseAxis } from './category-grid';

export type BrowseAxesData = {
  biomes: CategorySummary[];
  categories: CategorySummary[];
  stations: CategorySummary[];
};

/** How many of each axis get a picture. The rest are named, not pictured. */
export type TileCounts = { categories: number; stations: number };

/**
 * The three ways in.
 *
 * They are three because they answer three different questions, and the order
 * is the order those questions get asked: biomes are "where am I and what lives
 * there", which is the frame the whole game hangs on; categories are "what kind
 * of thing"; stations are "what can I make at this bench", which only matters
 * once you have one.
 *
 * The same component carries the front page and the browse tab, so the two
 * cannot drift into presenting the same thing two ways. What differs is what
 * happens past the head of each list: the front page sends you to the browse
 * tab for the rest, the browse tab shows it.
 */
export function BrowseAxes({
  lang,
  data,
  tiles,
  overflow,
}: {
  lang: Lang;
  data: BrowseAxesData;
  tiles: TileCounts;
  /**
   * What to do with everything past the head. `link` offers the browse tab;
   * `chips` lists it as bare names, which is what the long tail of eleven
   * "Polearms, 5" categories is worth.
   */
  overflow: 'link' | 'chips';
}) {
  const t = strings(lang);

  return (
    <div className="flex flex-col gap-6">
      <Section title={t.wikiBiomes} hint={t.wikiBiomesHint}>
        {/* Ordered by the game's progression, so the numeral is the meaning. */}
        <CategoryGrid items={data.biomes} axis="biome" ordinals />
      </Section>

      <Axis
        title={t.wikiCategories}
        items={data.categories}
        axis="category"
        tiles={tiles.categories}
        overflow={overflow}
        seeAll={t.wikiSeeAll}
      />

      <Axis
        title={t.wikiStations}
        items={data.stations}
        axis="station"
        tiles={tiles.stations}
        overflow={overflow}
        seeAll={t.wikiSeeAll}
      />
    </div>
  );
}

function Axis({
  title,
  items,
  axis,
  tiles,
  overflow,
  seeAll,
}: {
  title: string;
  items: CategorySummary[];
  axis: BrowseAxis;
  tiles: number;
  overflow: 'link' | 'chips';
  seeAll: string;
}) {
  const head = items.slice(0, tiles);
  const tail = items.slice(tiles);

  return (
    <Section title={title} seeAll={overflow === 'link' && tail.length > 0 ? seeAll : null}>
      <CategoryGrid items={head} axis={axis} />
      {overflow === 'chips' && tail.length > 0 ? (
        <CategoryChips items={tail} axis={axis} />
      ) : null}
    </Section>
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
