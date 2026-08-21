'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { articleHref } from '@/lib/routes';
import { ingredientKey, parseRecipe } from '@/lib/wiki/recipe';
import type { IngredientTarget } from '@/lib/db/wiki-repo';
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
  targets,
  lang,
}: {
  value: string;
  /** Keyed by `ingredientKey`; resolved on the server in one query. */
  targets: Record<string, IngredientTarget>;
  lang: Lang;
}) {
  const t = strings(lang);
  const ingredients = parseRecipe(value);

  // Nothing parsed: show what the wiki said rather than an empty box.
  if (ingredients.length === 0) {
    return <p className="text-[0.85rem] leading-snug text-birch">{value}</p>;
  }

  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {ingredients.map((ingredient, i) => {
        const target = targets[ingredientKey(ingredient.lookup)];

        const inner = (
          <>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-bog/60">
              {target?.icon ? (
                /* Hotlinked from Fandom's CDN, like every other image here. */
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={target.icon}
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
              <span className="block truncate text-[0.8rem] leading-tight text-birch">
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
