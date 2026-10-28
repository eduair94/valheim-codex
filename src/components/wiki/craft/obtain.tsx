import { Fragment } from 'react';
import Link from 'next/link';
import type { CraftObtain, CraftRef, CraftSource } from '@/lib/craft/data';
import type { Obtain } from '@/lib/craft/types';
import { strings, type Lang, type Strings } from '@/lib/i18n/strings';
import { articleHref } from '@/lib/routes';
import { CraftSection, nameLang, Plate } from './parts';

/** Each way a material is had, by the planner's group names: "Se mina", "Lo sueltan las criaturas". */
const HOW_LABEL: Record<Obtain['how'], 'craftObtainDrop' | 'craftObtainMine' | 'craftObtainChop' | 'craftObtainGather' | 'craftObtainFish' | 'craftObtainLoot' | 'craftObtainFarm' | 'craftObtainBuy'> = {
  drop: 'craftObtainDrop',
  mine: 'craftObtainMine',
  chop: 'craftObtainChop',
  gather: 'craftObtainGather',
  fish: 'craftObtainFish',
  loot: 'craftObtainLoot',
  farm: 'craftObtainFarm',
  buy: 'craftObtainBuy',
};

/**
 * "Cómo se consigue": how a raw material is had, from the recipe graph,
 * at the head of its article's text with "Usado en" after it.
 *
 * One line per way (dropped, mined, gathered, bought...), each naming its
 * creatures, places or trader in the reader's language, with their pictures
 * and links where they have articles, the tool the job needs, and a
 * trader's price. The infobox's "Source" row says the same in one line of
 * names; this says how, which is what a player standing in the right biome
 * with the wrong pickaxe needs.
 */
export function ObtainWays({ obtain, lang, uiLang }: { obtain: CraftObtain[]; lang: Lang; uiLang?: Lang }) {
  if (obtain.length === 0) return null;
  const t = strings(lang);
  return (
    <CraftSection kind="obtain" title={t.craftObtainTitle} uiLang={uiLang}>
      <dl className="craft-ways">
        {obtain.map((way, i) => (
          <div key={`${way.how}-${i}`} className="craft-way">
            <dt className="text-sm text-ash">{t[HOW_LABEL[way.how]]}</dt>
            <dd className="craft-way-from">
              {/*
               * Spaces between the parts, which the flex gap draws anyway:
               * without them the text runs together for anything that reads
               * it rather than looks at it ("Haldor50 monedas").
               */}
              {way.how === 'buy' ? (
                <>
                  <Source source={way.from} lang={lang} />{' '}
                  <span className="craft-coins">{t.craftObtainCoins.replace('{n}', String(way.coins))}</span>
                </>
              ) : (
                <>
                  {way.from.map((source) => (
                    <Fragment key={source.en}>
                      <Source source={source} lang={lang} />{' '}
                    </Fragment>
                  ))}
                  {way.tool ? <Tool tool={way.tool} lang={lang} t={t} /> : null}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </CraftSection>
  );
}

/** A creature, place or trader, linked to its article where it has one. */
function Source({ source, lang }: { source: CraftSource; lang: Lang }) {
  const inner = (
    <>
      <Plate icon={source.icon} px={24} className="craft-source-icon" />
      <span lang={nameLang(lang, source)}>{source.name}</span>
    </>
  );
  return source.slug ? (
    <Link href={articleHref(source.slug)} prefetch={false} className="craft-source craft-source-link">
      {inner}
    </Link>
  ) : (
    <span className="craft-source">{inner}</span>
  );
}

/** "con Pico de hierro": the tool, as a source is shown, inside its sentence. */
function Tool({ tool, lang, t }: { tool: CraftRef; lang: Lang; t: Strings }) {
  const [before = '', after = ''] = t.craftObtainTool.split('{tool}');
  return (
    <span className="craft-tool">
      {before.trim() ? <span>{before.trim()}</span> : null}{' '}
      <Source source={tool} lang={lang} />
      {after.trim() ? (
        <>
          {' '}
          <span>{after.trim()}</span>
        </>
      ) : null}
    </span>
  );
}
