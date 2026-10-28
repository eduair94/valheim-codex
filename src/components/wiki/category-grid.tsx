import Link from 'next/link';
import type { CategorySummary } from '@/lib/db/wiki-repo';
import type { Lang } from '@/lib/i18n/strings';
import { hasTermLabel } from '@/lib/i18n/terms';
import { browseHref, type BrowseAxis } from '@/lib/routes';
import { countLabel, formatCount } from './lists/format';
import { WikiImage, type ImagePriority } from './lists/wiki-image';

export type { BrowseAxis } from '@/lib/routes';

/**
 * A group as the grid shows it: `label` is the name in the reader's language
 * (`getBrowseAxes` fills it in), `name` the English value the link filters on.
 */
type Item = CategorySummary & { label?: string };

/** The name to show, and whether it is still the English value inside a Spanish page. */
function display(item: Item, axis: BrowseAxis, lang: Lang): { text: string; english: boolean } {
  return {
    text: item.label ?? item.name,
    english: lang !== 'en' && !hasTermLabel(axis, item.name),
  };
}

/** A count for the eye, and the same count with its noun for a screen reader. */
function Count({ n, lang, className }: { n: number; lang: Lang; className: string }) {
  return (
    <span className={`font-mono text-xs tabular-nums text-ash ${className}`}>
      <span aria-hidden="true">{formatCount(n, lang)}</span>
      <span className="sr-only">{countLabel(n, lang)}</span>
    </span>
  );
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
 * wrapped label costs more scanning than the row it saves. Four from a tablet
 * up, with a larger picture on a desktop, where three narrow tiles used to
 * leave half the screen empty. The front page and the browse tab show 8 or 12
 * tiles per axis, so every row is full at both column counts.
 *
 * The biomes are screenshots of places rather than sprites, and from a
 * tablet up they become cards with the picture across the top: at 60×44 a
 * landscape was a smudge, and the picture is how a biome is recognised.
 */
export function CategoryGrid({
  items,
  axis,
  lang,
  ordinals = false,
  firstScreen = false,
}: {
  items: Item[];
  axis: BrowseAxis;
  lang: Lang;
  /**
   * Numbers the tiles. Only for the biomes, where the order is the game's own
   * progression, so the numeral carries information instead of decorating.
   */
  ordinals?: boolean;
  /**
   * The grid is in the first screen, so its first tiles' pictures are fetched
   * with the page rather than lazily, the first of them ahead of everything
   * else (`ImagePriority`). On a desktop the biome cards are the page's
   * largest pictures and one of them its largest paint — not always the
   * first: the eight differ by a few pixels in the size the browser counts.
   */
  firstScreen?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <ul className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
      {items.map((item, index) => {
        const ordinal = ordinals ? index + 1 : null;
        const priority: ImagePriority =
          !firstScreen || index >= FIRST_SCREEN_TILES ? 'lazy' : index === 0 ? 'high' : 'eager';
        return (
          <li key={item.name}>
            {axis === 'biome' ? (
              <BiomeTile item={item} lang={lang} ordinal={ordinal} priority={priority} />
            ) : (
              <Tile item={item} axis={axis} lang={lang} ordinal={ordinal} priority={priority} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * How many tiles of a first-screen grid are on that screen: two rows of four
 * from a tablet up, four rows of two on a phone. Measured with the biomes on
 * home and browse, from 360×740 to 1440×900.
 */
const FIRST_SCREEN_TILES = 8;

/*
 * Compact up to `lg`: at two columns on a 360px phone and four on a tablet a
 * tile is 160–175px wide, and with a wider plate and inset the name had 58px,
 * so "Fermentador" broke in two and "Estructuras de crafteo" needed three
 * lines. From `lg` a tile is 230px or more and the picture gets the room.
 */
const TILE =
  'flex h-full items-center gap-2 rounded-md border border-moss bg-peat px-2 py-2 transition-colors hover:border-forge/50 hover:bg-moss/40';

/** The picture's plate in a tile, and the size it is drawn at. */
const PLATE = 'flex h-11 w-14 shrink-0 overflow-hidden rounded-sm border border-moss/70 bg-bog/60';

/** The rune that stands in when a group has no picture, or Fandom fails to serve it. */
function Rune() {
  return (
    <span aria-hidden="true" className="m-auto text-sm text-ash">
      ᛚ
    </span>
  );
}

/**
 * The name, two lines at most. Two rather than an ellipsis: "Puntos de
 * interés" is a category anyone recognises and "Puntos de inter…" is not, and
 * the tiles are stretched to the tallest in their row anyway. Long Spanish
 * words break with a hyphen rather than running out of the tile.
 */
function Name({ text, english, ordinal }: { text: string; english: boolean; ordinal: number | null }) {
  return (
    <span lang={english ? 'en' : undefined} className="line-clamp-2 text-sm leading-snug wrap-break-word hyphens-auto text-birch">
      {ordinal !== null ? (
        <span aria-hidden="true" className="mr-2 font-mono text-xs text-forge">
          {ordinal}
        </span>
      ) : null}
      {text}
    </span>
  );
}

function Tile({
  item,
  axis,
  lang,
  ordinal,
  priority,
}: {
  item: Item;
  axis: BrowseAxis;
  lang: Lang;
  ordinal: number | null;
  priority: ImagePriority;
}) {
  const name = display(item, axis, lang);
  return (
    <Link href={browseHref(axis, item.name)} className={`${TILE} min-h-16 lg:min-h-18 lg:gap-3 lg:px-3`}>
      {/*
       * The group's picture, on a plate. Wider than tall, because a category
       * stands for itself with whatever its own article shows — a sprite for
       * Weapons, a screenshot for Points of interest — and in a square plate a
       * landscape letterboxes down to a strip. The plate also keeps the row
       * aligned when a picture is missing.
       */}
      <span className={`${PLATE} lg:h-14 lg:w-20`}>
        {item.icon ? (
          <WikiImage
            url={item.icon}
            drawn={[56, 80]}
            sizes="(min-width: 64rem) 80px, 56px"
            width={80}
            height={56}
            priority={priority}
            className="h-full w-full object-contain p-1"
          />
        ) : (
          <Rune />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <Name text={name.text} english={name.english} ordinal={ordinal} />
        <Count n={item.count} lang={lang} className="mt-1 block leading-none" />
      </span>
    </Link>
  );
}

function BiomeTile({
  item,
  lang,
  ordinal,
  priority,
}: {
  item: Item;
  lang: Lang;
  ordinal: number | null;
  priority: ImagePriority;
}) {
  const name = display(item, 'biome', lang);
  return (
    <Link
      href={browseHref('biome', item.name)}
      className={`${TILE} min-h-16 md:flex-col md:items-stretch md:gap-0 md:overflow-hidden md:p-0`}
    >
      <span className={`${PLATE} md:aspect-video md:h-auto md:w-full md:rounded-none md:border-0 md:border-b`}>
        {item.icon ? (
          <WikiImage
            url={item.icon}
            drawn={[56, 266]}
            sizes="(min-width: 72rem) 266px, (min-width: 48rem) 25vw, 56px"
            width={268}
            height={151}
            priority={priority}
            className="h-full w-full object-cover"
          />
        ) : (
          <Rune />
        )}
      </span>
      <span className="min-w-0 flex-1 md:flex md:items-baseline md:justify-between md:gap-3 md:px-3 md:py-2">
        <Name text={name.text} english={name.english} ordinal={ordinal} />
        <Count n={item.count} lang={lang} className="mt-1 block leading-none md:mt-0 md:shrink-0" />
      </span>
    </Link>
  );
}

/**
 * The tail of an axis, as bare names.
 *
 * Past the first dozen, a category is "Polearms, 5" — a real answer to a
 * question almost nobody arrives with. Given a tile each, forty of them turn
 * the browse tab into a wall you scroll for half a minute, and the picture
 * stops meaning "this is worth looking at" because everything has one. As text
 * they still take a thumb, and the tiles above them get their weight back.
 *
 * They do not prefetch on sight: sixty of them scroll into view together, and
 * each would be a request for a page almost nobody opens. The page around
 * them (`IntentPrefetch`) fetches the one the reader points at, touches or
 * tabs to.
 */
export function CategoryChips({ items, axis, lang }: { items: Item[]; axis: BrowseAxis; lang: Lang }) {
  if (items.length === 0) return null;

  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {items.map((item) => {
        const name = display(item, axis, lang);
        return (
          <li key={item.name}>
            <Link
              href={browseHref(axis, item.name)}
              prefetch={false}
              className="inline-flex min-h-9 items-center gap-2 rounded-md border border-moss bg-peat/60 px-3 text-sm text-birch/90 transition-colors hover:border-forge/40 hover:text-birch pointer-coarse:min-h-11"
            >
              <span lang={name.english ? 'en' : undefined}>{name.text}</span>
              <Count n={item.count} lang={lang} className="" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
