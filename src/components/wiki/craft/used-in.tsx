import Link from 'next/link';
import type { CraftUse, CraftView } from '@/lib/craft/data';
import type { ItemId } from '@/lib/craft/types';
import { strings, type Lang, type Strings } from '@/lib/i18n/strings';
import { articleHref } from '@/lib/routes';
import { stationLabel } from './labels';
import { CraftSection, nameLang, Plate } from './parts';
import { UseCard } from './use-card';
import { groupUses, type UseGroup } from './used-in-model';

/**
 * "Usado en": everything a material goes into, at the head of its article's
 * text, answering "I have this; what can I do with it?".
 *
 * One card per thing, grouped by the station it is made at (the busiest
 * first, no station last), so a reader standing at a station finds what that
 * station makes of it in one place: what it crafts, in the order its levels
 * let a player make them, then the pieces built near it. Each card shows the
 * thing, a badge when the material only goes into an upgrade, and the yield;
 * its whole recipe with this material first and lit; and where it is made,
 * where the group's heading has not already said it all. The wiki's own
 * "Usage" list names the things and nothing else.
 *
 * A group shows its first six cards, four on a phone, and keeps the rest in
 * a `<details>`, so Wood's 84 uses at the Workbench do not bury the article,
 * and it all works with no JavaScript at all: rendered on the server, it
 * ships none.
 */
export function UsedIn({
  usedIn,
  material,
  selfSlug,
  lang,
  uiLang,
}: {
  usedIn: CraftView['usedIn'];
  /** The page's own material, which leads and is marked on every card. */
  material: ItemId;
  /** The article's slug: what it describes itself (a raw meat's cooked form) is named on its card, not linked. */
  selfSlug: string;
  lang: Lang;
  /** Set when the article is in another language than the interface. */
  uiLang?: Lang;
}) {
  const groups = groupUses(usedIn);
  if (groups.length === 0) return null;
  const t = strings(lang);
  return (
    <CraftSection kind="used-in" title={t.craftUsedIn} uiLang={uiLang}>
      <div className="flex flex-col gap-6">
        {groups.map((group) => (
          <Group key={group.station?.id ?? 'no-station'} group={group} material={material} selfSlug={selfSlug} lang={lang} t={t} />
        ))}
      </div>
    </CraftSection>
  );
}

function Group({ group, material, selfSlug, lang, t }: { group: UseGroup; material: ItemId; selfSlug: string; lang: Lang; t: Strings }) {
  const { station } = group;
  const count = group.shown.length + group.hidden.length;
  const heading = station?.name ?? t.craftNoStation;
  const cards = (uses: CraftUse[]) =>
    uses.map((use) => {
      // Where the step is made, unless the group's heading already says it
      // all ("Forja negra" under "Forja negra"): a level, or "cerca de" for
      // a piece built beside the station, is what a card adds.
      const where = stationLabel(t, use.method, use.station?.name ?? null, use.stationLevel);
      return (
        <UseCard
          key={use.id}
          product={use}
          where={where === heading ? undefined : where}
          badges={badges(use, t)}
          inputs={use.inputs}
          self={material}
          // An upgrade opens at its level where those levels are the product's
          // own; on a set's page they are its first piece's.
          level={use.ownPage ? use.quality : 1}
          selfSlug={selfSlug}
          lang={lang}
          t={t}
        />
      );
    });

  return (
    <section aria-labelledby={`craft-uses-${station?.id ?? 'no-station'}`} className="craft-group">
      <h3 id={`craft-uses-${station?.id ?? 'no-station'}`} className="craft-group-head">
        {station?.slug ? (
          // The station's picture belongs to the link, which a thumb can then
          // hit at any width the name gives it ("Forja" alone is 37px wide).
          <Link href={articleHref(station.slug)} prefetch={false} lang={nameLang(lang, station)} className="craft-group-link text-link">
            <Plate icon={station.icon} px={24} className="craft-mat-icon" />
            {station.name}
          </Link>
        ) : (
          <>
            {station ? <Plate icon={station.icon} px={24} className="craft-mat-icon" /> : null}
            <span lang={station ? nameLang(lang, station) : undefined}>{heading}</span>
          </>
        )}
        <span className="craft-group-count">{count}</span>
      </h3>
      <ul className="craft-uses">{cards(group.shown)}</ul>
      {group.hidden.length > 0 ? (
        <details className="craft-more">
          {/*
           * `<details>` keeps its summary when open, so it says what it does
           * in either state. It counts the whole group, not the cards it
           * hides: a phone hides more of them than a wide screen does.
           */}
          <summary>
            <span className="craft-more-closed">{t.craftUsedInMore.replace('{n}', String(count))}</span>
            <span className="craft-more-open">{t.craftUsedInLess}</span>
          </summary>
          <ul className="craft-uses">{cards(group.hidden)}</ul>
        </details>
      ) : null}
    </section>
  );
}

/**
 * What a use's card says besides where it is made: the level of the thing
 * the material goes into when that is an upgrade, since it changes what the
 * material is for, and how many a craft makes when more than one. Neither is
 * lit: forge light marks counts and the reader's place (this material, on
 * every card), and a lit badge drew the eye from both.
 */
function badges(use: CraftUse, t: Strings): string[] {
  const out: string[] = [];
  if (use.quality > 1) out.push(t.craftUsedInLevel.replace('{n}', String(use.quality)));
  if (use.yieldKnown && use.yield > 1) out.push(t.craftYield.replace('{n}', String(use.yield)));
  return out;
}
