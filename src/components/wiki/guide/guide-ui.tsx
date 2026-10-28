import Link from 'next/link';
import type { ReactNode } from 'react';
import { rune, strings, type Lang } from '@/lib/i18n/strings';
import type { Biome } from './guide-data';
import { itemTarget } from './guide-links';
import { guideRequest } from './guide-request';

/** The same passage in both languages. */
export type Bi<T = ReactNode> = Readonly<Record<Lang, T>>;

/** The hidden sentence every external chip points at, instead of three hundred `title`s. */
export const EXTERNAL_HINT_ID = 'guide-external-hint';

/**
 * A game item/creature/structure name, set exactly as it appears in-game.
 *
 * The reader asked for English names inside Spanish prose so they can match
 * what the game itself shows them — the monospace chip is what makes that
 * name jump out of a sentence instead of reading as a typo. In Spanish it is
 * marked `lang="en"` too, so a screen reader says "Black Forest" in English
 * rather than spelling it out with Spanish vowels.
 *
 * One element and one short class (`.g-item`, in guide.css): the page holds
 * about three hundred chips, and every attribute on one of them is paid for
 * three hundred times over, twice — once in the HTML, once in the payload React
 * hydrates from. The original wiki is said once, by `EXTERNAL_HINT_ID`, rather
 * than in a `title` per chip.
 *
 * The link goes to the Codex's own article when there is one (`itemTarget`).
 * Not prefetched on sight: a chip scrolled past is not a page the reader is
 * about to open, and three hundred of them would each fetch one. The guide's
 * body fetches a chip's article once the reader points at, touches or tabs
 * to it (`IntentPrefetch`, guide-content.tsx).
 */
export function Item({
  children,
  article,
  link = true,
}: {
  children: string;
  /** The article this mention means, when it differs from the name (`Root` → `Root (item)`). */
  article?: string;
  link?: boolean;
}) {
  const { lang, links } = guideRequest();
  if (!link) return <span className="g-item">{children}</span>;

  const nameLang = lang === 'en' ? undefined : 'en';
  const target = itemTarget(children, links, article);
  return target.internal ? (
    <Link href={target.href} prefetch={false} lang={nameLang} className="g-item">
      {children}
    </Link>
  ) : (
    <a
      href={target.href}
      target="_blank"
      rel="noopener noreferrer"
      lang={nameLang}
      aria-describedby={EXTERNAL_HINT_ID}
      className="g-item"
    >
      {children}
    </a>
  );
}

/** A note set apart from the prose: `warn` for what costs a death, `note` for the rest. */
export function Callout({ tone = 'note', children }: { tone?: 'note' | 'warn'; children: ReactNode }) {
  return (
    <p className="g-callout" data-tone={tone === 'warn' ? tone : undefined}>
      {children}
    </p>
  );
}

/**
 * A small labelled fact table — the boss card: how to summon it, what its
 * altar power does, what it drops.
 *
 * Label column and value column, both left-aligned. The values here are
 * sentences ("2× Deer Trophy on the altar (its Vegvisir…)"), and a sentence
 * set right-aligned in a narrow column — how this card used to read — has a
 * ragged left edge the eye has to hunt for on every line.
 */
export function GuideStatCard({
  kicker,
  title,
  rows,
}: {
  /** One word in label caps ("Jefe"); the name itself is set in the reading face, at any length. */
  kicker: string;
  title: ReactNode;
  rows: { label: string; value: ReactNode }[];
}) {
  return (
    <div className="g-card">
      <h4>
        <span className="label text-forge">{kicker}</span> <span className="g-card-title">{title}</span>
      </h4>
      <dl className="g-stats">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export type GuideTableRow = { head: ReactNode; cells: ReactNode[] };

/**
 * A small table that turns into cards on a phone.
 *
 * The phone cards come from the shared `.stack-table` / `.stack-scroller`
 * rules (`tables.css`), the same ones the article tables use, so the whole
 * app has one way of presenting a row on a narrow screen. The first cell is
 * the row's header, which is what becomes the card's title there, and every
 * other cell carries its column's name in `data-label`.
 *
 * Unlike an article's table, these wrap instead of scrolling: the guide's
 * cells are short sentences, written for this page, so they always fit the
 * column. That is also why there is no focusable scroll region here — a tab
 * stop that scrolls nothing is just one more key press between the reader
 * and the next link.
 *
 * Each cell's content sits in one span. On a phone a cell becomes a two-column
 * grid (label, value), and every direct child of a grid is a cell of its own:
 * "Thungr + Zil" would put "+" on a row by itself under the label, and a lone
 * chip would stretch to the width of the column.
 */
export function GuideTable({
  caption,
  headers,
  rows,
  numeric = [],
  keep = [],
  compact = false,
}: {
  caption: string;
  headers: readonly string[];
  rows: GuideTableRow[];
  /** Columns of plain numbers, set in tabular figures. */
  numeric?: number[];
  /** Columns of short names that read wrong broken in two ("Black / Forest"). */
  keep?: number[];
  /** A few short columns: the table takes the width it needs instead of the column's. */
  compact?: boolean;
}) {
  const cellClass = (i: number) =>
    [numeric.includes(i) ? 'g-num' : '', keep.includes(i) ? 'g-keep' : ''].join(' ').trim() || undefined;
  return (
    <figure className="g-table" data-compact={compact ? '' : undefined}>
      <figcaption>{caption}</figcaption>
      <div className="stack-scroller">
        <table className="stack-table">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={h} scope="col" className={cellClass(i)}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <th scope="row">{row.head}</th>
                {row.cells.map((cell, j) => (
                  <td key={j} data-label={headers[j + 1]} className={cellClass(j + 1)}>
                    <span>{cell}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

export type ChecklistEntry = { id: string; label: Bi; note?: Bi };

/**
 * A checkable list, for the things a completionist run actually has to do.
 *
 * Native checkboxes, each inside its label so the whole row is the target —
 * a 16px box is not something to aim for with a thumb mid-game. The ids are
 * stable and shared by both languages; `GuideProgress` keys the saved ticks
 * on them.
 */
export function GuideChecklist({ items, lang }: { items: readonly ChecklistEntry[]; lang: Lang }) {
  return (
    <ul className="g-checks">
      {items.map((item) => (
        <li key={item.id}>
          <label className="g-check">
            <input type="checkbox" id={item.id} />
            <span>
              {item.label[lang]}
              {item.note ? <span className="g-note">{item.note[lang]}</span> : null}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/**
 * One biome, rendered the same way every time.
 *
 * All seven chapters share this exact shape — resources, structures, enemies,
 * crafting, boss — so the reader learns the layout once in Meadows and can
 * skim the rest by position instead of re-reading labels each time.
 */
export function BiomeChapter({ index, biome, lang }: { index: number; biome: Biome; lang: Lang }) {
  const t = strings(lang);
  const nameLang = lang === 'en' ? undefined : 'en';
  return (
    <section id={biome.id} className="g-chapter">
      <div className="g-chapter-head">
        <span aria-hidden="true" className="g-rune">
          {rune(index)}
        </span>
        <h3 lang={nameLang} className="display">
          {biome.name}
        </h3>
        <span className="label">{biome.tag[lang]}</span>
      </div>
      <p className="g-lede">{biome.desc[lang]}</p>

      <h4 className="label g-h4">{t.guideResources}</h4>
      <GuideChecklist items={biome.resources} lang={lang} />

      <h4 className="label g-h4">{t.guideStructures}</h4>
      <GuideChecklist items={biome.structures} lang={lang} />

      <h4 className="label g-h4">{t.guideEnemies}</h4>
      <p className="g-prose">{biome.enemies[lang]}</p>

      <h4 className="label g-h4">{t.guideCrafting}</h4>
      <p className="g-prose">{biome.crafting[lang]}</p>

      {biome.callout ? <Callout tone={biome.calloutTone}>{biome.callout[lang]}</Callout> : null}

      <GuideStatCard
        kicker={t.guideBoss}
        title={<span lang={nameLang}>{biome.boss.name}</span>}
        rows={[
          { label: t.guideSummon, value: biome.boss.summon[lang] },
          { label: t.guidePower, value: biome.boss.power[lang] },
          { label: t.guideDrops, value: biome.boss.drops[lang] },
        ]}
      />

      {biome.extra ? (
        <>
          <h4 className="label g-h4">{biome.extra.label[lang]}</h4>
          <GuideChecklist items={biome.extra.items} lang={lang} />
        </>
      ) : null}
    </section>
  );
}
