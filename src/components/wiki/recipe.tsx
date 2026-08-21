'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { articleHref } from '@/lib/routes';
import { ingredientKey, parseRecipe } from '@/lib/wiki/recipe';
import type { IngredientTarget } from '@/lib/db/wiki-repo';
import { thumbnailImageUrl } from '@/lib/wiki/image-url';
import { strings, type Lang } from '@/lib/i18n/strings';

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
 */
export function Recipe({
  value,
  sourceValue,
  targets,
  lang,
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
    return <p className="text-[0.85rem] leading-snug text-birch">{value}</p>;
  }

  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {ingredients.map((ingredient, i) => {
        const target = targets[ingredientKey(keyFor(i, ingredient.lookup))];

        const inner = (
          <>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-bog/60">
              {target?.icon ? (
                /* Hotlinked from Fandom's CDN, like every other image here. */
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={thumbnailImageUrl(target.icon, 32)}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                  className="h-8 w-8 object-contain"
                />
              ) : (
                <span aria-hidden="true" className="text-sm text-lichen">
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
              <span className="block text-[0.8rem] leading-tight text-balance text-birch">
                {ingredient.display}
              </span>
              <span className="block font-mono text-[0.8rem] leading-tight font-semibold text-forge">
                ×{ingredient.quantity}
              </span>
            </span>
          </>
        );

        const shared = 'flex items-center gap-2 rounded-md border p-2';

        return (
          <li key={`${ingredient.lookup}-${i}`}>
            {target ? (
              <Link
                href={articleHref(target.slug) as Route}
                title={`${target.title} — ${t.wikiHowToGet}`}
                className={`${shared} border-moss bg-peat/40 transition-colors hover:border-forge/60 hover:bg-peat`}
              >
                {inner}
              </Link>
            ) : (
              <span className={`${shared} border-moss/60 bg-peat/20`}>{inner}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
