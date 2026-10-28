import Link from 'next/link';
import type { CraftView } from '@/lib/craft/data';
import { strings, type Lang } from '@/lib/i18n/strings';
import { ALL_CATEGORIES, categoryHref } from '@/lib/routes';
import { CraftSection } from './parts';
import { UseCard } from './use-card';

/**
 * A station's upgrades, at the head of its article's text: how high it goes,
 * each extension that raises it a level with what building it takes, and the
 * way to everything made at it.
 *
 * The extensions are cards like "Usado en"'s, each with what building it
 * takes. Built near the station, in any order, each adds one level: the one
 * rule a reader needs to plan them, which the wiki spreads over a page per
 * extension, said once above the cards rather than on each of them.
 * Rendered on the server; it ships no JavaScript.
 */
export function StationPath({
  station,
  facet,
  selfSlug,
  lang,
  uiLang,
}: {
  station: NonNullable<CraftView['station']>;
  /**
   * The station as the category lists filter by it ("Black forge"), which
   * is not always its article's title ("Black Forge"): the link to what is
   * made at it is left out where no article names it.
   */
  facet: string | null;
  /** The station's article: an extension it describes itself (the Cauldron's Smoker) is named on its card, not linked. */
  selfSlug: string;
  lang: Lang;
  /** Set when the article is in another language than the interface. */
  uiLang?: Lang;
}) {
  const t = strings(lang);
  return (
    <CraftSection kind="station-path" title={t.craftStationPath} uiLang={uiLang}>
      <p className="max-w-[65ch] text-sm leading-snug text-ash">
        {t.craftStationBase} <span className="text-birch">{t.craftStationMax.replace('{n}', String(station.maxLevel))}</span>
      </p>
      {station.extensions.length > 0 ? (
        <ul className="craft-uses mt-3">
          {station.extensions.map((extension) => (
            <UseCard key={extension.id} product={extension} badges={[]} inputs={extension.inputs} selfSlug={selfSlug} lang={lang} t={t} />
          ))}
        </ul>
      ) : null}
      {facet ? (
        // The same list the browse page's station tile opens.
        <Link href={categoryHref(ALL_CATEGORIES, { station: facet })} prefetch={false} className="craft-action mt-3">
          {t.craftStationMakes}
          <span aria-hidden="true">&nbsp;→</span>
        </Link>
      ) : null}
    </CraftSection>
  );
}
