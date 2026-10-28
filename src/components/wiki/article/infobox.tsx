import type { ArticleInfobox } from '@/lib/wiki/article-types';
import type { IngredientTarget } from '@/lib/db/wiki-repo';
import type { Linker } from '@/lib/wiki/links';
import { termLabel } from '@/lib/i18n/terms';
import { strings, type Lang } from '@/lib/i18n/strings';
import type { CraftCardData } from '../craft/card-model';
import { CraftCard } from '../craft/craft-card';
import { AskLink, type AskTarget } from './ask-link';
import { levelQualities, mergeGroups, starCount, tabSetKind, usefulTabs, withoutRecipes } from './infobox-model';
import { LevelProvider } from './level-context';
import { LevelTabs, type LevelTab } from './level-tabs';
import { StatGroup } from './stat-group';
import { StickyAside } from './sticky-aside';

/** Whether an infobox has anything to show: rows, or a tab with rows. */
export function hasInfoboxContent(infobox: ArticleInfobox | null): infobox is ArticleInfobox {
  if (!infobox) return false;
  return infobox.common.some((group) => group.rows.length > 0) || usefulTabs(infobox.tabs).length > 0;
}

/**
 * A run of stat groups: one column on a phone and beside the text, three
 * columns when the box is spread above the text, where the groups flow like
 * a page of a field guide and a group never breaks across two (StatGroup).
 * Spaced with top margins: the docked link at the end is hidden below
 * 1024px, and a bottom margin would still be left for it.
 */
function flowClass(spread: boolean): string {
  return `[&>*+*]:mt-6 ${spread ? 'lg:columns-3 lg:gap-8' : ''}`;
}

/**
 * The article's data: the stats, the level switcher and the recipe.
 *
 * Above the text on a phone, because the numbers are what someone opened
 * "Iron Sword" for. From 1024px it is a column of its own beside the text,
 * 22rem wide, so a stat's label and value sit 200px apart instead of 600,
 * and "ask about this" is docked at its foot instead of floating over the
 * page. The column stays in view while the text scrolls when all of it fits
 * in the window (`StickyAside`). When the stats are most of the article the
 * box is spread over three columns above the text instead (`articleLayout`).
 *
 * Rows common to every level come first; the level switcher then sits
 * directly above the rows it changes — spread, across all three columns,
 * between the common rows and the level's own.
 *
 * Where the recipe graph knows the item, its craft card takes the place of
 * the recipe rows: under the level switcher, which it follows, when the
 * item has upgrade levels; else as the box's first block. Upgrade levels are
 * one selected level for the whole article (`LevelProvider`), which the card
 * follows and `#level-4` picks, with or without a card. An item the graph
 * does not know keeps its recipe rows, exactly as before.
 */
export function Infobox({
  infobox,
  lang,
  uiLang,
  linker,
  ingredientTargets,
  recipeSources,
  ask,
  layout,
  craft = null,
  className,
}: {
  infobox: ArticleInfobox;
  lang: Lang;
  /** Set when the article is in another language than the interface. */
  uiLang?: Lang;
  linker: Linker;
  ingredientTargets: Record<string, IngredientTarget>;
  recipeSources: Record<string, string>;
  ask: AskTarget;
  /** Beside the text (`side`), or spread over three columns above it (`spread`), from 1024px. */
  layout: 'side' | 'spread';
  /** The craft card's slice of the recipe graph, where the graph knows the item and how to make it. */
  craft?: CraftCardData | null;
  className?: string;
}) {
  const t = strings(lang);
  const tabs = usefulTabs(infobox.tabs);
  // A single tab is no choice at all: its rows simply belong to the box.
  const merged = mergeGroups(tabs.length === 1 ? [...infobox.common, ...tabs[0]!.groups] : infobox.common);
  const common = craft ? withoutRecipes(merged) : merged;
  const switchable = tabs.length > 1 ? tabs : [];
  const qualities = levelQualities(switchable.map((tab) => tab.label));
  const spread = layout === 'spread';

  const groupProps = { lang, uiLang, ingredientTargets, recipeSources, linker };
  const headingId = 'article-infobox';
  const card = craft ? <CraftCard data={craft} lang={lang} uiLang={uiLang} /> : null;

  const docked = (
    <AskLink
      ask={ask}
      lang={uiLang}
      docked
      className="mt-6 hidden min-h-11 break-inside-avoid items-center justify-center gap-2 rounded-md border border-forge/40 bg-peat px-4 py-2 text-sm text-forge transition-colors hover:border-forge hover:bg-forge/15 lg:flex"
    >
      {t.wikiAskAbout}
    </AskLink>
  );

  const commonGroups = common.map((group, i) => <StatGroup key={`c${i}`} group={group} {...groupProps} />);

  /*
   * With upgrade levels, the card is the switcher's `before`: under it,
   * above the rows it changes, across the three columns when spread. Without
   * them it leads the box, across the columns too, so that the recipe stays
   * the first thing read rather than the foot of the first column.
   */
  const leading = card && !qualities ? <div className={spread ? 'lg:[column-span:all]' : undefined}>{card}</div> : null;

  return (
    <StickyAside labelledBy={headingId} enabled={!spread} className={className}>
      <h2 id={headingId} lang={uiLang} className="sr-only">
        {t.articleInfobox}
      </h2>
      {switchable.length > 0 ? (
        <>
          {leading || commonGroups.length > 0 ? (
            <div className={flowClass(spread)}>
              {leading}
              {commonGroups}
            </div>
          ) : null}
          {qualities ? (
            <LevelProvider qualities={qualities}>
              <TabbedGroups
                tabs={switchable}
                lang={lang}
                uiLang={uiLang}
                groupProps={groupProps}
                spread={spread}
                before={card}
                hideRecipe={craft !== null}
                after={docked}
                className={commonGroups.length > 0 ? (spread ? 'mt-6 lg:mt-8' : 'mt-6') : undefined}
              />
            </LevelProvider>
          ) : (
            // Stars and variants: each tab's rows are its own thing's (a
            // cooked meat's recipe on the raw meat's page), so they keep
            // their recipe rows; only the box's own rows give theirs to the card.
            <TabbedGroups
              tabs={switchable}
              lang={lang}
              uiLang={uiLang}
              groupProps={groupProps}
              spread={spread}
              after={docked}
              className={leading || commonGroups.length > 0 ? (spread ? 'mt-6 lg:mt-8' : 'mt-6') : undefined}
            />
          )}
        </>
      ) : (
        <div className={flowClass(spread)}>
          {leading}
          {commonGroups}
          {docked}
        </div>
      )}
    </StickyAside>
  );
}

function TabbedGroups({
  tabs,
  lang,
  uiLang,
  groupProps,
  spread,
  before,
  hideRecipe = false,
  after,
  className,
}: {
  tabs: ArticleInfobox['tabs'];
  lang: Lang;
  uiLang?: Lang;
  groupProps: Omit<React.ComponentProps<typeof StatGroup>, 'group'>;
  spread: boolean;
  /** Between the switcher and the levels' rows: the craft card. */
  before?: React.ReactNode;
  /** The craft card shows the recipe of every level: the levels' recipe rows go. */
  hideRecipe?: boolean;
  after: React.ReactNode;
  className?: string;
}) {
  const t = strings(lang);
  const kind = tabSetKind(tabs.map((tab) => tab.label));

  /*
   * The tabs used to appear as four bare numbers, and then as "upgrade
   * levels" on every infobox with tabs — a troll's star levels included, with
   * a hint about crafting stations (BWR-11). What they are is read from the
   * labels: numbers are levels, stars are a creature's star levels (its
   * trophy rides along), anything else is a variant.
   */
  const label = kind === 'levels' ? t.wikiLevels : kind === 'stars' ? t.articleStars : t.articleVariants;
  const hint = kind === 'levels' ? t.wikiLevelsHint : kind === 'stars' ? t.articleStarsHint : undefined;

  const levelTabs: LevelTab[] = tabs.map((tab) => {
    const text = tab.label.trim();
    if (kind === 'levels') return { text: `${t.wikiLevel} ${text}` };
    const stars = starCount(text);
    if (stars !== null) {
      const name = (stars === 1 ? t.articleStarOne : t.articleStarMany).replace('{n}', String(stars));
      return { text: `${stars}★`, name };
    }
    // "Trophy" and the like: field names the vocabulary knows.
    return { text: termLabel('facet', text, lang) };
  });

  const panels = tabs.map((tab, i) => (
    <div key={i} className="[&>*+*]:mt-6">
      {(hideRecipe ? withoutRecipes(mergeGroups(tab.groups)) : mergeGroups(tab.groups)).map((group, j) => (
        <StatGroup key={j} group={group} {...groupProps} hideRecipe={hideRecipe} />
      ))}
    </div>
  ));

  return (
    <LevelTabs
      label={label}
      hint={hint}
      tabs={levelTabs}
      panels={panels}
      uiLang={uiLang}
      spread={spread}
      before={before}
      after={after}
      className={className}
    />
  );
}
