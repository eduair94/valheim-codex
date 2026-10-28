import Link from 'next/link';
import { BROWSE_HREF } from '@/components/shell/nav-model';
import type { CategorySummary } from '@/lib/db/wiki-repo';
import { BROWSE_COPY } from '@/lib/i18n/browse-copy';
import type { Lang } from '@/lib/i18n/strings';
import { CategoryGrid, CategoryChips, type BrowseAxis } from './category-grid';

/** Each axis's groups; `label` is the display name `getBrowseAxes` gives them. */
export type BrowseAxesData = {
  biomes: (CategorySummary & { label?: string })[];
  categories: (CategorySummary & { label?: string })[];
  stations: (CategorySummary & { label?: string })[];
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
 *
 * Spacing: 32px between axes, 12px from an axis's heading to its tiles (8px
 * to a hint), so each heading reads as belonging to the tiles under it.
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
  // `BROWSE_COPY`, not the whole table: kept light should a client component
  // ever render it again. Today only the server does (home and browse pages).
  const t = BROWSE_COPY[lang];

  return (
    <div className="flex flex-col gap-8">
      <Section id="axis-biomes" title={t.wikiBiomes} hint={t.wikiBiomesHint}>
        {/*
         * Ordered by the game's progression, so the numeral is the meaning.
         * The first axis on both pages, so its pictures are in the first
         * screen.
         */}
        <CategoryGrid items={data.biomes} axis="biome" lang={lang} ordinals firstScreen />
      </Section>

      <Axis
        id="axis-categories"
        title={t.wikiCategories}
        items={data.categories}
        axis="category"
        lang={lang}
        tiles={tiles.categories}
        overflow={overflow}
        seeAll={t.wikiSeeAll}
      />

      <Axis
        id="axis-stations"
        title={t.wikiStations}
        items={data.stations}
        axis="station"
        lang={lang}
        tiles={tiles.stations}
        overflow={overflow}
        seeAll={t.wikiSeeAll}
      />
    </div>
  );
}

function Axis({
  id,
  title,
  items,
  axis,
  lang,
  tiles,
  overflow,
  seeAll,
}: {
  id: string;
  title: string;
  items: BrowseAxesData['categories'];
  axis: BrowseAxis;
  lang: Lang;
  tiles: number;
  overflow: 'link' | 'chips';
  seeAll: string;
}) {
  const head = items.slice(0, tiles);
  const tail = items.slice(tiles);

  return (
    <Section id={id} title={title} seeAll={overflow === 'link' && tail.length > 0 ? seeAll : null}>
      <CategoryGrid items={head} axis={axis} lang={lang} />
      {overflow === 'chips' && tail.length > 0 ? <CategoryChips items={tail} axis={axis} lang={lang} /> : null}
    </Section>
  );
}

function Section({
  id,
  title,
  hint,
  seeAll,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  seeAll?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <div className="flex items-center gap-3">
        <h2 id={id} className="label">
          {title}
        </h2>
        <span className="h-px flex-1 bg-moss" aria-hidden="true" />
        {seeAll ? (
          // 20px of line plus 12px above and below: a 44px target that
          // takes no more room in the row than the label beside it.
          <Link
            href={BROWSE_HREF}
            className="-my-3 inline-flex shrink-0 items-center py-3 font-mono text-xs leading-5 tracking-wider text-ash transition-colors hover:text-forge"
          >
            {seeAll}
            <span aria-hidden="true">&nbsp;→</span>
          </Link>
        ) : null}
      </div>
      {hint ? <p className="mt-2 text-sm leading-snug text-ash">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}
