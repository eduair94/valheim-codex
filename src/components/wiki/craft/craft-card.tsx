'use client';

import { lazy, Suspense, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useStrings } from '@/components/shell/lang-context';
import { decodeGraph } from '@/lib/craft/codec';
import { CRAFT_PLANNER_LIVE } from '@/lib/craft/feature';
import { indexGraph, type CraftStep, type GraphIndex } from '@/lib/craft/math';
import { targetStep } from '@/lib/craft/plan';
import type { GraphRecipe, ItemId } from '@/lib/craft/types';
import type { Lang, Strings } from '@/lib/i18n/strings';
import { articleHref } from '@/lib/routes';
import { FANDOM_IMG_PROPS } from '@/lib/wiki/image-url';
import { useLevel } from '../article/level-context';
import {
  cardModes,
  cardStep,
  cardTotals,
  clampCrafts,
  MAX_CRAFTS,
  planItemFor,
  type CardAmount,
  type CardMode,
  type CardTotals,
  type CraftCardData,
} from './card-model';
import { iconUrl } from './icon';
import { methodLabel, stationLabel } from './labels';

/** A material's icon, drawn at this size on its plate (`.craft-icon`). */
const ICON_PX = 32;

/*
 * "Agregar al taller", in a chunk of its own with the planner's store. It
 * renders only while the planner is live (`CRAFT_PLANNER_LIVE`), and until
 * then none of it reaches an article: imported with the card, it was a
 * sixth of the card's weight. The server renders it with the card, so the
 * button is in the page before its chunk arrives.
 */
const CraftAdd = lazy(() => import('./craft-add').then((module) => ({ default: module.CraftAdd })));

/**
 * The article's craft card: what making the item takes, at the level the
 * infobox shows, as this level's step, every step from new, or all of it in
 * raw materials, for as many as the reader means to make.
 *
 * It replaces the infobox's recipe row and sits where the row was, under
 * the level switcher, which it follows (`useLevel`): the switcher sits above
 * the rows it changes, and the card is one of them. Without levels it is the
 * infobox's first block, at the item's one level.
 *
 * Every number is worked out here, in the browser, from the slice of the
 * recipe graph the page hands over (`CraftCardData`), by the same maths the
 * planner uses (`card-model.ts`): a breakdown that meets a yield the wiki
 * leaves in doubt, or a level it has no recipe for, says so instead of
 * guessing. The server renders it at the first level, this level's step and
 * one craft, so a reader without JavaScript still sees the recipe.
 *
 * Its tiles are the infobox recipe's (`Recipe`), with the English name under
 * the reader's where the two differ, because the game shows the English one.
 * The totals are also said, once, in a polite live region, so that a screen
 * reader hears what a change of level, mode or count did.
 */
export function CraftCard({ data, lang, uiLang }: { data: CraftCardData; lang: Lang; uiLang?: Lang }) {
  const t = useStrings(lang);
  const id = useId();
  const index = useMemo(() => {
    const graph = decodeGraph(data.closure);
    // The page names the slice in the reader's language already; an English
    // reader is shown the English names whatever a slice carries.
    return indexGraph(lang === 'es' ? graph : { ...graph, items: graph.items.map(({ es: _es, ...item }) => item) });
  }, [data.closure, lang]);
  const level = useLevel();
  const quality = level ? (level.qualities[level.index] ?? 1) : 1;
  // "Este nivel" only beside a switcher that names the level. An infobox
  // without one (a translation stored before the infobox had its level tabs)
  // leaves the card at the first level with nothing on the page saying which:
  // the step there is simply the recipe, as for a thing with one level.
  const levelled = level !== null && level.qualities.length > 1;

  const [picked, setPicked] = useState<CardMode>('step');
  const [crafts, setCrafts] = useState(1);
  // What the reader is typing, until the field loses focus: an empty field
  // mid-edit must not snap back to a number under their thumb.
  const [typed, setTyped] = useState<string | null>(null);

  const modes = cardModes(index, data, quality);
  // A mode the level does not offer (levels 1 to N at level 1) shows this level's step.
  const mode = modes.includes(picked) ? picked : 'step';
  const totals = cardTotals(index, data, quality, mode, crafts);
  const shown = cardStep(index, data, quality);
  // A level the wiki has no recipe for still heads the card by how the item is made.
  const method = (shown ?? targetStep(index, data.item.id, 1))?.method ?? 'craft';
  const name = (itemId: ItemId) => nameOf(index, itemId);

  const heading =
    mode === 'raw'
      ? t.craftTotalsRaw
      : mode === 'total'
        ? t.craftTotalsAll.replace('{n}', String(quality))
        : quality > 1
          ? t.craftTotalsStep.replace('{n}', String(quality))
          : t.craftTotalsNew;
  const notes = noteLines(t, lang, totals, index, data);
  const madeLine =
    totals.yield !== null && totals.yield > 1 && totals.made !== null
      ? `${t.craftYield.replace('{n}', String(totals.yield))} · ${t.craftMakes.replace('{n}', String(totals.made))}`
      : null;

  const said = [
    totals.rows.length > 0 ? `${heading} ${spoken(totals.rows, name)}.` : '',
    totals.fuel.length > 0 ? `${t.craftFuel}: ${spoken(totals.fuel, name)}.` : '',
    madeLine ? `${madeLine}.` : '',
    ...notes,
  ]
    .filter(Boolean)
    .join(' ');

  const step = (by: number): void => {
    setTyped(null);
    setCrafts((current) => clampCrafts(current + by));
  };

  return (
    <section
      data-craft="card"
      data-level={quality}
      aria-labelledby={`${id}-title`}
      lang={uiLang}
      className="craft-card"
    >
      {/*
       * How it is made and where, side by side: spread across a wide card
       * the station sat a screen's width from the word it qualifies.
       */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id={`${id}-title`} className="label">
          {methodLabel(t, method)}
        </h3>
        {shown ? <StationChip recipe={shown} index={index} t={t} lang={lang} /> : null}
      </div>

      {data.item.anchor !== null ? <PieceLine item={data.item} lang={lang} /> : null}

      {modes.length > 1 ? (
        <div role="group" aria-label={t.craftModes} className="craft-modes mt-3">
          {modes.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === mode}
              onClick={() => setPicked(option)}
              className="craft-mode focus-inset"
            >
              {option === 'step'
                ? levelled
                  ? t.craftModeStep
                  : t.craftModeRecipe
                : option === 'total'
                  ? t.craftModeTotal.replace('{n}', String(quality))
                  : t.craftModeRaw}
            </button>
          ))}
        </div>
      ) : null}

      {totals.rows.length > 0 ? (
        <>
          <p className="mt-3 text-sm text-ash">{heading}</p>
          <ul aria-label={t.wikiRecipe} className="craft-tiles mt-2">
            {totals.rows.map((row) => (
              <Tile key={row.id} amount={row} index={index} lang={lang} self={data.item.slug} />
            ))}
          </ul>
        </>
      ) : null}

      {totals.fuel.length > 0 ? (
        <>
          <p className="label mt-4">{t.craftFuel}</p>
          <ul className="craft-tiles mt-2">
            {totals.fuel.map((row) => (
              <Tile key={row.id} amount={row} index={index} lang={lang} self={data.item.slug} />
            ))}
          </ul>
        </>
      ) : null}

      {totals.steps.length > 0 ? (
        <>
          <p className="label mt-4">{t.craftSteps}</p>
          <ol className="craft-steps mt-2">
            {totals.steps.map((craft) => (
              <StepLine key={`${craft.recipe.product}@${craft.recipe.quality}`} craft={craft} index={index} t={t} lang={lang} />
            ))}
          </ol>
        </>
      ) : null}

      {notes.length > 0 ? (
        <div className="mt-3 flex max-w-[65ch] flex-col gap-1">
          {notes.map((note) => (
            <p key={note} className="text-sm leading-snug text-ash">
              {note}
            </p>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor={`${id}-crafts`} className="text-sm text-ash">
          {t.craftQuantity}
        </label>
        <div className="craft-stepper">
          <button
            type="button"
            aria-label={t.craftFewer}
            aria-disabled={crafts <= 1}
            onClick={() => step(-1)}
            className="craft-bump focus-inset"
          >
            <span aria-hidden="true">−</span>
          </button>
          <input
            id={`${id}-crafts`}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={typed ?? String(crafts)}
            onChange={(event) => {
              const text = event.target.value.replace(/\D/g, '').slice(0, 2);
              setTyped(text);
              if (text) setCrafts(clampCrafts(Number(text)));
            }}
            onBlur={() => setTyped(null)}
            className="craft-count"
          />
          <button
            type="button"
            aria-label={t.craftMore}
            aria-disabled={crafts >= MAX_CRAFTS}
            onClick={() => step(1)}
            className="craft-bump focus-inset"
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
        {madeLine ? <p className="text-sm text-ash">{madeLine}</p> : null}
      </div>

      {CRAFT_PLANNER_LIVE ? (
        // Its own height meanwhile, so the card does not grow under the reader when it lands.
        <Suspense fallback={<div className="mt-4 min-h-11" />}>
          <CraftAdd target={planItemFor(index, data, quality, mode, crafts)} lang={lang} />
        </Suspense>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </section>
  );
}

type Named = { name: string; en: string; english: boolean; slug: string | null; icon: string | null };

/** An item as the card names it: the reader's name, and the English one the game shows. */
function nameOf(index: GraphIndex, id: ItemId): Named {
  const item = index.items.get(id);
  // The slice holds every item its recipes name; were one missing, it would
  // still be listed, by its id, rather than dropped from a recipe.
  if (!item) return { name: id, en: id, english: true, slug: null, icon: null };
  const name = item.es ?? item.en;
  return { name, en: item.en, english: name === item.en, slug: item.slug ?? null, icon: item.icon ?? null };
}

/** "Madera ×2, Hierro ×20": a list as the live region says it. */
function spoken(rows: CardAmount[], name: (id: ItemId) => Named): string {
  return rows.map((row) => `${name(row.id).name} ×${row.qty}`).join(', ');
}

/** What the card could not work out, said in place of a number: missing levels, doubtful yields, cycles. */
function noteLines(t: Strings, lang: Lang, totals: CardTotals, index: GraphIndex, data: CraftCardData): string[] {
  const lines: string[] = [];
  if (totals.missing.length > 0) {
    const levels = new Intl.ListFormat(lang, { type: 'conjunction' }).format(totals.missing.map(String));
    lines.push(
      (totals.missing.length === 1 ? t.craftMissingStepsOne : t.craftMissingSteps)
        .replace('{levels}', levels)
        .replace('{name}', nameOf(index, data.item.id).name),
    );
  }
  if (totals.yieldInDoubt) lines.push(t.craftYieldUnknown);
  for (const entry of totals.unexpanded) {
    if (entry.reason === 'raw') continue;
    lines.push((entry.reason === 'cycle' ? t.craftCycle : t.craftUnknownYield).replace('{name}', nameOf(index, entry.id).name));
  }
  return lines;
}

/**
 * The piece the card is for, on a page that is not that piece's own: an
 * armor set's page, whose title names the set and whose infobox shows its
 * first piece. Without it the card would give the helmet's recipe under the
 * set's name.
 */
function PieceLine({ item, lang }: { item: CraftCardData['item']; lang: Lang }) {
  const english = item.name === item.en;
  return (
    <p className="craft-card-item">
      <span className="craft-icon">
        {item.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img {...FANDOM_IMG_PROPS} src={iconUrl(item.icon, ICON_PX)} alt="" width={ICON_PX} height={ICON_PX} loading="lazy" className="size-8 object-scale-down" />
        ) : (
          <span aria-hidden="true" className="text-lichen">
            ◆
          </span>
        )}
      </span>
      {/* A space between the two names, which their blocks draw anyway, so they do not run together when read. */}
      <span className="min-w-0">
        <span lang={lang === 'es' && english ? 'en' : undefined} className="craft-card-item-name">
          {item.name}
        </span>{' '}
        {english ? null : (
          <span lang="en" className="craft-en">
            {item.en}
          </span>
        )}
      </span>
    </p>
  );
}

/** Where the step is made (`stationLabel`), linked to the station's article, with its picture. */
function StationChip({ recipe, index, t, lang }: { recipe: GraphRecipe; index: GraphIndex; t: Strings; lang: Lang }) {
  if (recipe.station === null) return <span className="craft-chip">{stationLabel(t, recipe.method, null, recipe.stationLevel)}</span>;
  const station = nameOf(index, recipe.station);
  const text = stationLabel(t, recipe.method, station.name, recipe.stationLevel);
  const inner = (
    <>
      {station.icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img {...FANDOM_IMG_PROPS} src={iconUrl(station.icon, 20)} alt="" width={20} height={20} loading="lazy" className="size-5 object-scale-down" />
      ) : null}
      {/* English only where the label is the station's English name alone, with no words around it. */}
      <span lang={lang === 'es' && station.english && text === station.name ? 'en' : undefined}>{text}</span>
    </>
  );
  return station.slug ? (
    <Link href={articleHref(station.slug)} prefetch={false} className="craft-chip craft-chip-link">
      {inner}
    </Link>
  ) : (
    <span className="craft-chip">{inner}</span>
  );
}

/** A material, its picture and its count, linked to its article (none to the page it is on). */
function Tile({ amount, index, lang, self }: { amount: CardAmount; index: GraphIndex; lang: Lang; self: string | null }) {
  const item = nameOf(index, amount.id);
  const inner = (
    <>
      <span className="craft-icon">
        {item.icon ? (
          // Hotlinked from Fandom's CDN, like every picture here, at the size
          // it is drawn, and never enlarged: a sprite smaller than its plate
          // stays its own size. An icon that fails shows the empty plate.
          // eslint-disable-next-line @next/next/no-img-element
          <img {...FANDOM_IMG_PROPS} src={iconUrl(item.icon, ICON_PX)} alt="" width={ICON_PX} height={ICON_PX} loading="lazy" className="size-8 object-scale-down" />
        ) : (
          <span aria-hidden="true" className="text-lichen">
            ◆
          </span>
        )}
      </span>
      {/* Spaces between the parts, which their boxes draw anyway, so a link's name reads "Madera Wood ×2". */}
      <span className="min-w-0 flex-1">
        <span lang={lang === 'es' && item.english ? 'en' : undefined} className="craft-name">
          {item.name}
        </span>{' '}
        {item.english ? null : (
          <>
            <span lang="en" className="craft-en">
              {item.en}
            </span>{' '}
          </>
        )}
      </span>
      {/* The count closes the tile, so down a column of tiles the counts line up, as the stat rows' values do. */}
      <span className="craft-qty">×{amount.qty}</span>
    </>
  );
  return (
    <li>
      {item.slug && item.slug !== self ? (
        <Link href={articleHref(item.slug)} prefetch={false} className="craft-tile craft-tile-link">
          {inner}
        </Link>
      ) : (
        <span className="craft-tile">{inner}</span>
      )}
    </li>
  );
}

/** One intermediate craft of the breakdown: what, how many, where, and how many times when a craft makes more than one. */
function StepLine({ craft, index, t, lang }: { craft: CraftStep; index: GraphIndex; t: Strings; lang: Lang }) {
  const product = nameOf(index, craft.recipe.product);
  const station =
    craft.recipe.station === null ? stationLabel(t, craft.recipe.method, null, craft.recipe.stationLevel) : nameOf(index, craft.recipe.station).name;
  const times =
    craft.produced !== craft.crafts
      ? (new Intl.PluralRules(lang).select(craft.crafts) === 'one' ? t.craftTimesOne : t.craftTimes).replace('{n}', String(craft.crafts))
      : null;
  return (
    <li className="craft-step-line">
      <span className="craft-icon craft-icon-small">
        {product.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img {...FANDOM_IMG_PROPS} src={iconUrl(product.icon, 20)} alt="" width={20} height={20} loading="lazy" className="size-5 object-scale-down" />
        ) : (
          <span aria-hidden="true" className="text-lichen">
            ◆
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span lang={lang === 'es' && product.english ? 'en' : undefined} className="text-birch">
          {product.name}
        </span>{' '}
        <span className="craft-qty-inline">×{craft.produced}</span>
        <span className="text-ash">
          {' · '}
          {station}
          {times ? ` · ${times}` : null}
        </span>
      </span>
    </li>
  );
}
