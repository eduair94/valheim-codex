import { Fragment } from 'react';
import { IntentPrefetch } from '@/components/wiki/article/intent-prefetch';
import { rune, strings, type Lang } from '@/lib/i18n/strings';
import {
  BIOMES,
  BOSS_TABLE,
  CRITERIA,
  CRITERIA_INTRO,
  DEEP_NORTH,
  HILDIR,
  INTRO,
  MYTH,
  PORTAL_BLOCKED,
  PORTALS,
  POWERS,
  SECTIONS,
  SHIPS,
  SOURCES,
  STATIONS,
  TAMING,
  TRADERS,
  VEGVISIR,
  type GuideSection,
} from './guide-data';
import { GuidePlace } from './guide-place';
import { GuideProgress } from './guide-progress';
import { GuideToc, type TocEntry } from './guide-toc';
import { BiomeChapter, Callout, EXTERNAL_HINT_ID, GuideChecklist, GuideTable, Item } from './guide-ui';

const ROOT_ID = 'guide';

/**
 * The table of contents, from the same section list the page renders, so an
 * entry cannot point at an anchor that is not there.
 */
export function guideToc(lang: Lang): TocEntry[] {
  const entry = (section: GuideSection): TocEntry => ({ id: section.id, label: section.toc[lang] });
  return [
    entry(SECTIONS.criteria),
    entry(SECTIONS.mechanics),
    {
      ...entry(SECTIONS.biomes),
      children: BIOMES.map((biome, i) => ({
        id: biome.id,
        label: biome.name,
        rune: rune(i + 1),
        ...(lang === 'en' ? {} : { lang: 'en' }),
      })),
    },
    entry(SECTIONS.traders),
    entry(SECTIONS.hildir),
    entry(SECTIONS.ships),
    entry(SECTIONS.taming),
    entry(SECTIONS.bosses),
    entry(SECTIONS.deepNorth),
  ];
}

/**
 * The 100% guide, in the reader's language.
 *
 * Laid out as a reading page: one column of text held to a reading measure,
 * and from `lg` up a table of contents in its own column beside it. Each
 * chapter is skipped by the browser until it nears the screen
 * (`content-visibility`, guide.css), which is most of what makes an
 * eleven-screen page paint as fast as a short one; `GuidePlace` keeps that
 * from costing the reader their place when they come Back from an article.
 */
export function GuideContent({ lang }: { lang: Lang }) {
  const t = strings(lang);

  return (
    <div id={ROOT_ID} lang={lang} className="g-page">
      <GuideToc
        entries={guideToc(lang)}
        label={t.guideToc}
        openLabel={t.guideTocOpen}
        closeLabel={t.guideTocClose}
      />

      {/* An item's article is fetched once the reader points at, touches or tabs to its chip. */}
      <IntentPrefetch as="article" className="g-body">
        <header className="g-head">
          <p className="label text-forge">{t.guideKicker}</p>
          <h1 className="display">{t.wikiGuideTitle}</h1>
          <p className="g-meta">{INTRO.meta[lang]}</p>
          <p className="g-lede">{INTRO.lede[lang]}</p>
          <aside aria-labelledby="guide-before" className="g-before">
            <p id="guide-before" className="label text-forge">
              {INTRO.beforeLabel[lang]}
            </p>
            <p>{INTRO.before[lang]}</p>
          </aside>
        </header>

        <section id={SECTIONS.criteria.id} className="g-sec g-cv">
          <h2 className="display">{SECTIONS.criteria.title[lang]}</h2>
          <p className="g-intro">{CRITERIA_INTRO[lang]}</p>
          <GuideChecklist items={CRITERIA} lang={lang} />
          <Callout>{MYTH[lang]}</Callout>
        </section>

        <section id={SECTIONS.mechanics.id} className="g-sec g-cv">
          <h2 className="display">{SECTIONS.mechanics.title[lang]}</h2>

          <h3 className="g-h3">{VEGVISIR.heading[lang]}</h3>
          <p className="g-prose">{VEGVISIR.body[lang]}</p>
          <GuideTable
            caption={VEGVISIR.caption[lang]}
            headers={VEGVISIR.headers[lang]}
            rows={VEGVISIR.rows.map((row) => ({ head: row.boss, cells: [row.where[lang]] }))}
          />

          <h3 className="g-h3">{POWERS.heading[lang]}</h3>
          <p className="g-prose">
            {POWERS.body[lang]}{' '}
            <a href={`#${SECTIONS.bosses.id}`} className="g-link">
              {POWERS.link[lang]}
            </a>
            .
          </p>

          <h3 className="g-h3">{PORTALS.heading[lang]}</h3>
          <p className="g-prose">
            {PORTALS.lead[lang]}{' '}
            {PORTAL_BLOCKED.map((name, i) => (
              <Fragment key={name}>
                <Item>{name}</Item>
                {i < PORTAL_BLOCKED.length - 1 ? ', ' : '.'}
              </Fragment>
            ))}{' '}
            {PORTALS.tail[lang]}
          </p>
          <Callout>{PORTALS.exception[lang]}</Callout>

          <h3 className="g-h3">{STATIONS.heading[lang]}</h3>
          <ul role="list" className="g-steps">
            {STATIONS.steps.map((step, i) => (
              <li key={i}>{step[lang]}</li>
            ))}
          </ul>
        </section>

        <section id={SECTIONS.biomes.id} className="g-biomes">
          <h2 className="display">{SECTIONS.biomes.title[lang]}</h2>
          {BIOMES.map((biome, i) => (
            <BiomeChapter key={biome.id} index={i + 1} biome={biome} lang={lang} />
          ))}
        </section>

        <section id={SECTIONS.traders.id} className="g-sec g-cv">
          <h2 className="display">{SECTIONS.traders.title[lang]}</h2>
          <p className="g-intro">{TRADERS.intro[lang]}</p>

          <h3 className="g-h3">{TRADERS.haldor.heading[lang]}</h3>
          <p className="g-prose">{TRADERS.haldor.body[lang]}</p>
          <GuideTable
            caption={TRADERS.haldor.caption[lang]}
            headers={TRADERS.haldor.headers[lang]}
            numeric={[1]}
            compact
            rows={TRADERS.haldor.rows.map((row) => ({
              head: <Item>{row.item}</Item>,
              cells: [row.price, 'after' in row ? `${TRADERS.haldor.after[lang]} ${row.after}` : '—'],
            }))}
          />
          <p className="g-aside">{TRADERS.haldor.buys[lang]}</p>

          <h3 className="g-h3">{TRADERS.bogWitch.heading[lang]}</h3>
          <p className="g-prose">{TRADERS.bogWitch.body[lang]}</p>
          <ul role="list" className="g-steps">
            {TRADERS.bogWitch.points.map((point, i) => (
              <li key={i}>{point[lang]}</li>
            ))}
          </ul>
          <p className="g-aside">{TRADERS.bogWitch.stock[lang]}</p>
        </section>

        <section id={SECTIONS.hildir.id} className="g-sec g-cv">
          <h2 className="display">{SECTIONS.hildir.title[lang]}</h2>
          <p className="g-prose">{HILDIR.body[lang]}</p>
          <GuideTable
            caption={HILDIR.caption[lang]}
            headers={HILDIR.headers[lang]}
            keep={[1]}
            rows={HILDIR.rows.map((row) => ({
              head: <Item>{row.dungeon}</Item>,
              cells: [row.biome, row.bosses, <Item key="reward">{row.reward}</Item>],
            }))}
          />
          <Callout>{HILDIR.chests[lang]}</Callout>
          <GuideChecklist items={HILDIR.barber} lang={lang} />
        </section>

        <div className="g-pair">
          <section id={SECTIONS.ships.id} className="g-sec g-cv">
            <h2 className="display">{SECTIONS.ships.title[lang]}</h2>
            <GuideTable
              caption={SHIPS.caption[lang]}
              headers={SHIPS.headers[lang]}
              numeric={[1, 2]}
              rows={SHIPS.rows.map((row) => ({ head: <Item>{row.ship}</Item>, cells: [row.hp, row.cargo] }))}
            />
            <p className="g-aside">{SHIPS.note[lang]}</p>
          </section>
          <section id={SECTIONS.taming.id} className="g-sec g-cv">
            <h2 className="display">{SECTIONS.taming.title[lang]}</h2>
            <p className="g-intro">{TAMING.intro[lang]}</p>
            <GuideChecklist items={TAMING.items} lang={lang} />
          </section>
        </div>

        <section id={SECTIONS.bosses.id} className="g-sec g-cv">
          <h2 className="display">{SECTIONS.bosses.title[lang]}</h2>
          <GuideTable
            caption={BOSS_TABLE.caption[lang]}
            headers={BOSS_TABLE.headers[lang]}
            keep={[1]}
            rows={BOSS_TABLE.rows.map((row, i) => ({
              head: (
                <>
                  <span aria-hidden="true" className="g-rune">
                    {rune(i + 1)}
                  </span>{' '}
                  {row.boss}
                </>
              ),
              cells: [row.biome, row.summon[lang], row.power[lang]],
            }))}
          />
          <p className="g-aside">{BOSS_TABLE.note[lang]}</p>
        </section>

        <section id={SECTIONS.deepNorth.id} className="g-sec g-next">
          <p className="label">{DEEP_NORTH.kicker[lang]}</p>
          <h2 className="display">{SECTIONS.deepNorth.title[lang]}</h2>
          <p className="g-prose">{DEEP_NORTH.body[lang]}</p>
        </section>

        <footer className="g-sources">
          <p>{SOURCES[lang]}</p>
        </footer>
      </IntentPrefetch>

      <p id={EXTERNAL_HINT_ID} hidden>
        {t.guideExternal}
      </p>
      <GuideProgress rootId={ROOT_ID} />
      <GuidePlace rootId={ROOT_ID} lang={lang} />
    </div>
  );
}
