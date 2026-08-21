'use client';

import Link from 'next/link';
import type { CategorySummary } from '@/lib/db/wiki-repo';
import { categoryHref } from '@/lib/routes';

/**
 * Which axis a tile belongs to, and therefore where it leads.
 *
 * A category is a path segment; a biome or a station is a filter over every
 * category, so it uses the `all` sentinel the category route already
 * understands. Passing the axis rather than a ready-made href keeps the props
 * serialisable, which is what lets one grid be rendered from a server page and
 * from inside the search view alike.
 */
export type BrowseAxis = 'category' | 'biome' | 'station';

function hrefFor(axis: BrowseAxis, name: string) {
  return axis === 'category' ? categoryHref(name) : categoryHref('all', { [axis]: name });
}

/**
 * A browsing axis, as a grid of tiles.
 *
 * The wrapped list of text chips this replaces was compact and unreadable: at a
 * glance it was a paragraph of nouns, and finding "Armor" in it meant reading
 * every word before it. A tile leads with the thing itself — one member's
 * sprite, standing for the group — which is recognised before its label is
 * read. That is what makes browsing faster than typing when you do not yet know
 * the name of what you are looking for.
 *
 * Two columns on a phone rather than three: at three the label wraps, and a
 * wrapped label costs more scanning than the row it saves.
 */
export function CategoryGrid({
  items,
  axis,
  ordinals = false,
}: {
  items: CategorySummary[];
  axis: BrowseAxis;
  /**
   * Numbers the tiles. Only for the biomes, where the order is the game's own
   * progression, so the numeral carries information instead of decorating.
   */
  ordinals?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.map((item, index) => (
        <li key={item.name}>
          <Link
            href={hrefFor(axis, item.name)}
            className="flex h-full min-h-16 items-center gap-2.5 rounded-md border border-moss bg-peat px-2.5 py-2 transition-colors hover:border-forge/50 hover:bg-moss/40"
          >
            <Thumb icon={item.icon} />
            <span className="min-w-0 flex-1">
              {/*
               * Two lines rather than an ellipsis: "Points of interest" is a
               * category anyone would recognise and "Points of inter…" is not,
               * and the tiles are stretched to the tallest in their row anyway,
               * so the second line costs nothing a cut word saves.
               */}
              <span className="line-clamp-2 text-[0.85rem] leading-tight text-birch">
                {ordinals ? (
                  <span aria-hidden="true" className="mr-1.5 font-mono text-[0.6rem] text-forge/70">
                    {index + 1}
                  </span>
                ) : null}
                {item.name}
              </span>
              <span className="mt-1 block font-mono text-[0.62rem] leading-none text-ash">
                {item.count}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The group's picture, on a plate.
 *
 * The sprites are transparent PNGs of wildly different proportions, so the
 * plate is what keeps a row of tiles aligned. Fandom's CDN also 404s
 * intermittently; an absent picture reads fine against the plate, a
 * broken-image glyph does not.
 */
function Thumb({ icon }: { icon: string | null }) {
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-moss/70 bg-bog/60">
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={icon}
          alt=""
          width={36}
          height={36}
          loading="lazy"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
          className="h-9 w-9 object-contain"
        />
      ) : (
        <span aria-hidden="true" className="text-sm text-ash">
          ᛚ
        </span>
      )}
    </span>
  );
}
