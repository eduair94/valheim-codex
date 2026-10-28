import Link from 'next/link';
import { articleHref } from '@/lib/routes';
import { ingredientKey, parseRecipe } from '@/lib/wiki/recipe';
import type { IngredientTarget } from '@/lib/db/wiki-repo';
import { FANDOM_IMG_PROPS, thumbnailImageUrl } from '@/lib/wiki/image-url';
import { strings, type Lang } from '@/lib/i18n/strings';

/** The icon's drawn size, in CSS pixels. */
const ICON_PX = 32;

/**
 * A crafting recipe as the things it needs, not as a sentence about them.
 *
 * The wiki states a recipe as one line — `Finewood x10; Bronze x3` — which is
 * accurate and answers the wrong question. Someone reading it already knows
 * they need materials; what they do not know is what Finewood looks like or
 * where it comes from. So each material gets the picture from its own article
 * and links to it, which is the shortest path from "I want this" to "here is
 * how to get the parts".
 *
 * The layout borrows the game's own crafting panel: icons at a size you can
 * recognise, with the count beside them. Quantities are monospaced and amber
 * because the count is the thing being compared against what is in the chest.
 *
 * A material with no article of its own — cooked food, mead bases, trophies —
 * still gets a tile, without a link or a picture. Roughly one in ten are like
 * that, and dropping them would make the recipe wrong.
 *
 * Columns follow the space the recipe is given rather than the screen: two in
 * a phone's column or the desktop infobox, three or four across a tablet. The
 * tiles of a row share its height, so a name that wraps to two lines does not
 * leave its neighbour short (LM-18).
 */
export function Recipe({
  value,
  sourceValue,
  targets,
  lang,
  uiLang,
}: {
  value: string;
  /**
   * The same recipe as the English article states it, when this one is a
   * translation. Names are looked up from here rather than from the gloss the
   * translation carries, because a dropped gloss should cost a parenthetical,
   * not the picture and the link.
   */
  sourceValue?: string;
  /** Keyed by `ingredientKey`; resolved on the server in one query. */
  targets: Record<string, IngredientTarget>;
  lang: Lang;
  /**
   * Set when the article is in another language than the interface. The tile
   * then names its material in the article's language and has no tooltip:
   * the tooltip's hint is interface copy, which an attribute cannot mark as
   * another language, and its name would only repeat the tile's.
   */
  uiLang?: Lang;
}) {
  const t = strings(lang);
  const ingredients = parseRecipe(value);

  /*
   * Positional, and only when both parses agree on how many ingredients there
   * are. If they disagree the translation reshaped the row, and pairing by
   * position would put one material's picture on another's name.
   */
  const source = sourceValue ? parseRecipe(sourceValue) : [];
  const keyFor = (index: number, fallback: string): string =>
    source.length === ingredients.length ? (source[index]?.lookup ?? fallback) : fallback;

  // Nothing parsed: show what the wiki said rather than an empty box.
  if (ingredients.length === 0) {
    return <p className="text-sm leading-snug whitespace-pre-line text-birch">{value}</p>;
  }

  return (
    <ul className="grid grid-cols-2 gap-2 @md:grid-cols-3 @2xl:grid-cols-4">
      {ingredients.map((ingredient, i) => {
        const target = targets[ingredientKey(keyFor(i, ingredient.lookup))];

        const inner = (
          <>
            <span className="recipe-icon">
              {target?.icon ? (
                // Hotlinked from Fandom's CDN, like every other image here. An
                // icon that fails to load shows nothing: its alt is empty.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  {...FANDOM_IMG_PROPS}
                  src={thumbnailImageUrl(target.icon, ICON_PX)}
                  alt=""
                  width={ICON_PX}
                  height={ICON_PX}
                  loading="lazy"
                  className="size-8 object-contain"
                />
              ) : (
                <span aria-hidden="true" className="text-lichen">
                  ◆
                </span>
              )}
            </span>

            <span className="min-w-0">
              {/*
               * Wraps to two lines rather than truncating. Half the materials
               * on this wiki are two or three words — "Clavos de bronce",
               * "Kit de peluquería" — and a tile that says "Clavos de bron…"
               * has spent its space telling the reader nothing.
               */}
              <span className="recipe-name">{ingredient.display}</span>
              <span className="recipe-qty">×{ingredient.quantity}</span>
            </span>
          </>
        );

        return (
          <li key={`${ingredient.lookup}-${i}`}>
            {target ? (
              <Link
                href={articleHref(target.slug)}
                prefetch={false}
                title={uiLang ? undefined : `${target.title} — ${t.wikiHowToGet}`}
                className="recipe-tile recipe-tile-link"
              >
                {inner}
              </Link>
            ) : (
              <span className="recipe-tile">{inner}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
