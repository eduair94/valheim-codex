import type { ReactNode } from 'react';
import { rune } from '@/lib/i18n/strings';

/**
 * A game item/creature/structure name, set exactly as it appears in-game.
 *
 * The reader asked for English names inside Spanish prose so they can match
 * what the game itself shows them — the monospace treatment is what makes
 * that name jump out of a sentence instead of reading as a typo.
 */
export function Item({ children }: { children: ReactNode }) {
  return (
    <code className="whitespace-nowrap rounded-sm bg-moss/50 px-1 py-0.5 font-mono text-[0.85em] text-forge">
      {children}
    </code>
  );
}

/**
 * A small labelled fact table — the boss card: how to summon it, what its
 * altar power does, what it drops. Same shape as `StatGroup` in
 * `article-view.tsx`, reused here rather than reinvented.
 */
export function GuideStatCard({
  title,
  rows,
}: {
  title: ReactNode;
  rows: { label: string; value: ReactNode }[];
}) {
  return (
    <section className="mt-3">
      <h4 className="label mb-1.5 text-forge">{title}</h4>
      <dl className="overflow-hidden rounded-md border border-moss">
        {rows.map((row, i) => (
          <div
            key={i}
            className="flex flex-col gap-1 border-b border-moss/60 px-3 py-2 last:border-b-0 odd:bg-peat/40 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
          >
            <dt className="shrink-0 text-sm text-ash">{row.label}</dt>
            <dd className="text-[0.85rem] leading-snug text-birch sm:text-right">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * A wide table on a narrow screen — headers/rows in, `DataTable`'s exact
 * stacking behaviour out. Kept separate from `DataTable` because that one is
 * bound to `TableBlock`, the DB-backed article shape; this guide is hand
 * written and has no `ArticleDoc` behind it.
 */
export function GuideTable({
  caption,
  headers,
  rows,
}: {
  caption?: string;
  headers: string[];
  rows: ReactNode[][];
}) {
  return (
    <figure className="my-1">
      {caption ? <figcaption className="label mb-1.5">{caption}</figcaption> : null}
      <div
        tabIndex={0}
        role="region"
        aria-label={caption ?? 'Tabla'}
        className="stack-scroller overflow-x-auto rounded-md border border-moss"
      >
        <table className="stack-table w-full border-collapse text-left text-[0.8rem]">
          <thead>
            <tr className="bg-peat">
              {headers.map((h, i) => (
                <th
                  key={i}
                  scope="col"
                  className={`whitespace-nowrap border-b border-moss px-3 py-2 font-mono text-[0.68rem] uppercase tracking-wider text-ash ${
                    i === 0 ? 'sticky left-0 z-10 bg-peat' : ''
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="odd:bg-peat/30">
                {row.map((cell, j) =>
                  j === 0 ? (
                    <th
                      key={j}
                      scope="row"
                      className="sticky left-0 z-10 whitespace-nowrap border-b border-moss/50 bg-bog px-3 py-2 text-left font-medium text-birch odd:bg-bog"
                    >
                      {cell}
                    </th>
                  ) : (
                    <td
                      key={j}
                      data-label={headers[j] ?? ''}
                      className="whitespace-nowrap border-b border-moss/50 px-3 py-2 font-mono text-birch/90"
                    >
                      {cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

export type ChecklistItem = { id: string; label: ReactNode; note?: ReactNode };

/**
 * A checkable list, for the things a completionist run actually has to do.
 *
 * Plain native checkboxes rather than a stateful component: nothing here
 * needs to survive a reload to be useful mid-session, and a native checkbox
 * needs no client JavaScript at all, which keeps this whole page a server
 * component.
 */
export function GuideChecklist({ items }: { items: ChecklistItem[] }) {
  return (
    <ul className="mt-1 mb-3 flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2.5">
          <input type="checkbox" id={item.id} className="mt-1 h-4 w-4 shrink-0 accent-forge" />
          <label htmlFor={item.id} className="text-[0.95rem] leading-snug text-birch">
            {item.label}
            {item.note ? <span className="mt-0.5 block text-[0.78rem] text-ash">{item.note}</span> : null}
          </label>
        </li>
      ))}
    </ul>
  );
}

/** A section heading in the app's carved-caps display face. */
export function GuideH2({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2 id={id} className="display scroll-mt-4 text-lg text-birch">
      {children}
    </h2>
  );
}

/** A subsection label, mono/uppercase, matching `.label` used across the wiki. */
export function GuideH3({ children }: { children: ReactNode }) {
  return <h3 className="label mt-5 mb-1.5 text-birch/90">{children}</h3>;
}

export type BiomeData = {
  id: string;
  name: string;
  tag: string;
  desc: ReactNode;
  resources: ChecklistItem[];
  structures: ChecklistItem[];
  enemies: ReactNode;
  crafting: ReactNode;
  boss: { name: ReactNode; rows: { label: string; value: ReactNode }[] };
  extra?: { label: string; items: ChecklistItem[] };
  callout?: ReactNode;
};

/**
 * One biome, rendered the same way every time.
 *
 * All seven chapters share this exact shape — resources, structures, enemies,
 * crafting, boss — so the reader learns the layout once in Meadows and can
 * skim the rest by position instead of re-reading labels each time.
 */
export function BiomeChapter({ index, biome }: { index: number; biome: BiomeData }) {
  return (
    <section id={biome.id} className="scroll-mt-4 border-t border-moss pt-6 first:border-t-0 first:pt-0">
      <div className="flex items-baseline gap-2.5">
        <span aria-hidden="true" className="font-mono text-sm text-forge/80">
          {rune(index)}
        </span>
        <h3 className="display text-base text-birch">{biome.name}</h3>
        <span className="font-mono text-[0.65rem] tracking-wider text-ash uppercase">{biome.tag}</span>
      </div>
      <p className="answer mt-1.5 mb-3 text-[0.92rem] text-ash">{biome.desc}</p>

      <GuideH3>Recursos para farmear</GuideH3>
      <GuideChecklist items={biome.resources} />

      <GuideH3>Estructuras y mazmorras</GuideH3>
      <GuideChecklist items={biome.structures} />

      <GuideH3>Enemigos notables</GuideH3>
      <p className="answer text-[0.92rem]">{biome.enemies}</p>

      <GuideH3>Crafteo</GuideH3>
      <div className="answer text-[0.92rem]">{biome.crafting}</div>

      {biome.callout ? (
        <p className="mt-3 rounded-md border border-blood/40 bg-blood/10 px-3 py-2 text-[0.85rem] leading-snug text-birch/90">
          {biome.callout}
        </p>
      ) : null}

      <GuideStatCard title={<>Jefe — {biome.boss.name}</>} rows={biome.boss.rows} />

      {biome.extra ? (
        <>
          <GuideH3>{biome.extra.label}</GuideH3>
          <GuideChecklist items={biome.extra.items} />
        </>
      ) : null}
    </section>
  );
}
