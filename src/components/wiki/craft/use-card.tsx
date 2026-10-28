import { Fragment } from 'react';
import Link from 'next/link';
import type { CraftAmount, CraftRef } from '@/lib/craft/data';
import type { ItemId } from '@/lib/craft/types';
import type { Lang, Strings } from '@/lib/i18n/strings';
import { articleLevelHref } from '@/lib/routes';
import { nameLang, Plate } from './parts';

/**
 * One thing a recipe makes, as a card: its picture and its name in the
 * reader's language with the English one under it, and the facts that
 * change what the step is (an upgrade to a level, a yield); everything the
 * step takes, each with its picture and count; then where the step is
 * made. "Usado en" lists one per use of a material; a station lists one per
 * upgrade.
 *
 * The order is the game's crafting panel's: the thing, what it takes, where.
 * The facts sit with the thing's name, since they are about the thing ("the
 * club's level 2"), away from the station's own level, which says "nivel"
 * too. The materials are chips that wrap, so a recipe of five takes two
 * lines on a phone rather than five, and the card is never a list as tall
 * as the screen.
 *
 * Every card lists its whole step, the page's material too, even when it is
 * the only one ("Garrote" takes five bone fragments and nothing else): the
 * card answers "what does it take", and an empty card answered nothing. The
 * page's material (`self`) leads and is lit, so the eye finds how much of it
 * each step takes in the same place on every card. No count sits beside the
 * thing's name: there "×5" read as five clubs.
 *
 * The whole card opens the thing's article: its name is the link, and the
 * link's box is stretched over the card (`.craft-use-link`), so a thumb can
 * land anywhere on it while the link a screen reader lists is still just the
 * name. The materials are therefore no links of their own; each has its own
 * card on the product's page.
 *
 * A card about an upgrade opens the article at that level (`level`), where
 * the article's levels are the thing's own, so that the craft card the
 * reader lands on shows the step this card names: opened at its first
 * level, the Club's asked for six wood, where "Mejora al nivel 2" had said
 * five bone fragments. A thing described on the page the reader is on (a
 * raw meat's cooked form, a station's extension) is named, not linked: a
 * tap fetched the same page again and changed nothing.
 *
 * A server component, repeated up to 75 times on a page: short classes
 * (craft.css) rather than utilities, since each is sent twice, in the HTML
 * and in the payload React hydrates from.
 */
export function UseCard({
  product,
  where,
  badges,
  inputs,
  self,
  level = 1,
  selfSlug,
  lang,
  t,
}: {
  product: CraftRef;
  /**
   * Where the step is made (`stationLabel`), as a quiet caption; left out
   * where the card's group heading already says it all.
   */
  where?: string;
  /** The facts that change what the step is, each a short phrase, shown with the thing's name. */
  badges: string[];
  inputs: CraftAmount[];
  self?: ItemId;
  /** The level the thing's article opens at (`articleLevelHref`); the first opens it as it opens. */
  level?: number;
  /** The article the card is on, which the card never links back to. */
  selfSlug?: string;
  lang: Lang;
  t: Strings;
}) {
  const english = nameLang(lang, product);
  return (
    <li className="craft-use">
      <div className="craft-use-head">
        <Plate icon={product.icon} px={32} className="craft-icon" />
        <div className="min-w-0 flex-1">
          {product.slug && product.slug !== selfSlug ? (
            <Link href={articleLevelHref(product.slug, level)} prefetch={false} lang={english} className="craft-use-link">
              {product.name}
            </Link>
          ) : (
            <span lang={english} className="craft-use-name">
              {product.name}
            </span>
          )}
          {english || product.name === product.en ? null : (
            <span lang="en" className="craft-en">
              {product.en}
            </span>
          )}
          {badges.length > 0 ? (
            <span className="craft-use-facts">
              {/* A space before each, which the flex gap draws anyway, so the facts do not run together when read. */}
              {badges.map((badge) => (
                <Fragment key={badge}>
                  {' '}
                  <span className="craft-badge">{badge}</span>
                </Fragment>
              ))}
            </span>
          ) : null}
        </div>
      </div>

      {inputs.length > 0 ? (
        <ul aria-label={t.wikiRecipe} className="craft-mats">
          {inputs.map((input, i) => {
            const own = input.id === self;
            return (
              <li key={`${input.id}-${i}`} aria-current={own ? 'true' : undefined} className={own ? 'craft-mat craft-mat-self' : 'craft-mat'}>
                <Plate icon={input.icon} px={24} className="craft-mat-icon" />
                {/*
                 * The page's own material goes by its picture alone: its
                 * name is the page's title, and on every card it took the
                 * room of the next material. A screen reader still hears it,
                 * and with no picture it is written out.
                 */}
                <span lang={nameLang(lang, input)} className={own && input.icon ? 'sr-only' : 'craft-mat-name'}>
                  {input.name}
                </span>{' '}
                {/* The space, which the flex gap draws anyway, keeps "Madera ×2" from being read as one word. */}
                <span className="craft-mat-qty">×{input.qty}</span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {where ? <p className="craft-use-meta">{where}</p> : null}
    </li>
  );
}
