'use client';

import { useState } from 'react';
import Link from 'next/link';
import type {
  ArticleBlock,
  ArticleDoc,
  InfoboxGroup,
  TableBlock,
} from '@/lib/wiki/article-types';
import { strings, type Lang } from '@/lib/i18n/strings';
import { categoryHref } from '@/lib/routes';

/**
 * The article page.
 *
 * Fandom on a phone buries the numbers under a full-width infobox and a wall
 * of prose. Here the data *is* the page: identity, then stats, then the text.
 * Nobody opens "Iron Sword" to read prose.
 */
export function ArticleView({
  title,
  url,
  categories,
  doc,
  lang,
}: {
  title: string;
  url: string;
  categories: string[];
  doc: ArticleDoc;
  lang: Lang;
}) {
  const t = strings(lang);
  const tabs = doc.infobox?.tabs ?? [];
  const [tab, setTab] = useState(() => tabs[0]?.label ?? '');
  const activeTab = tabs.find((x) => x.label === tab) ?? tabs[0];

  return (
    <article className="pb-28">
      <IdentityStrip title={title} doc={doc} lang={lang} />

      {doc.lead ? (
        <p className="mt-4 max-w-[62ch] text-[0.975rem] leading-[1.7] text-birch/90">{doc.lead}</p>
      ) : null}

      {tabs.length > 1 ? (
        <div
          className="mt-5 flex gap-1 overflow-x-auto rounded-md border border-moss bg-peat p-1"
          role="tablist"
          aria-label={t.wikiLevels}
        >
          {tabs.map((x) => (
            <button
              key={x.label}
              type="button"
              role="tab"
              aria-selected={x.label === tab}
              onClick={() => setTab(x.label)}
              className={`shrink-0 rounded-sm px-3 py-1.5 font-mono text-xs transition-colors ${
                x.label === tab ? 'bg-forge text-bog' : 'text-ash hover:text-birch'
              }`}
            >
              {/^\d+$/.test(x.label) ? `${t.wikiLevel} ${x.label}` : x.label}
            </button>
          ))}
        </div>
      ) : null}

      {doc.infobox ? (
        <div className="mt-4 flex flex-col gap-4">
          {mergeGroups([...doc.infobox.common, ...(activeTab?.groups ?? [])]).map((group, i) => (
            <StatGroup key={i} group={group} />
          ))}
        </div>
      ) : null}

      {doc.blocks.length > 0 ? (
        <div data-testid="article-body" className="mt-8 flex flex-col gap-4">
          <Blocks blocks={doc.blocks} />
        </div>
      ) : null}

      {doc.images.length > 0 ? <Gallery images={doc.images} lang={lang} /> : null}

      <footer className="mt-10 border-t border-moss pt-4">
        {categories.length > 0 ? (
          <ul className="mb-4 flex flex-wrap gap-1.5">
            {categories.map((c) => (
              <li key={c}>
                <Link
                  href={categoryHref(c)}
                  className="inline-block rounded-sm border border-moss px-2 py-1 text-xs text-ash transition-colors hover:border-forge/40 hover:text-birch"
                >
                  {c}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}

        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[0.7rem] text-ash underline-offset-4 hover:text-birch hover:underline"
        >
          {t.wikiSourceLink} ↗
        </a>
      </footer>
    </article>
  );
}

function IdentityStrip({ title, doc, lang }: { title: string; doc: ArticleDoc; lang: Lang }) {
  const t = strings(lang);
  const image = doc.infobox?.image;
  const { type, station, biome } = doc.facets;
  const facets = [type, station ? `${t.wikiStation}: ${station}` : null, biome].filter(Boolean);

  return (
    <header className="flex items-start gap-4">
      {image ? (
        // Hotlinked from Fandom's CDN, and deliberately not `next/image`: these
        // are third-party URLs that would otherwise be proxied and re-encoded
        // through our server for no gain.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image.url}
          alt={image.alt || title}
          width={72}
          height={72}
          loading="eager"
          className="h-[72px] w-[72px] shrink-0 rounded-md border border-moss bg-peat object-contain p-1"
        />
      ) : null}

      <div className="min-w-0">
        <h1 className="display text-lg leading-tight text-birch">{title}</h1>
        {facets.length > 0 ? (
          <p className="mt-1 font-mono text-[0.7rem] text-ash">{facets.join(' · ')}</p>
        ) : null}
      </div>
    </header>
  );
}

/**
 * Joins consecutive groups that share a heading.
 *
 * The wiki splits an infobox into a group per horizontal row, so an item's
 * stats arrive as four separate blocks all labelled "Properties". Rendering
 * them as-is repeats the heading down the page and puts every single-row group
 * in its own bordered box, which reads as noise rather than as structure.
 */
function mergeGroups(groups: InfoboxGroup[]): InfoboxGroup[] {
  const out: InfoboxGroup[] = [];
  for (const group of groups) {
    if (group.rows.length === 0) continue;
    const previous = out[out.length - 1];
    if (previous && previous.label === group.label) {
      previous.rows = [...previous.rows, ...group.rows];
      continue;
    }
    out.push({ label: group.label, rows: [...group.rows] });
  }
  return out;
}

/** Past this, a value is a sentence and belongs under its label, not beside it. */
const INLINE_VALUE_LIMIT = 42;

/**
 * A block of stats: label left, value right, values monospaced so digits line
 * up down the column and can be compared without reading each row. A long
 * value drops below its label and reads as prose, because a paragraph
 * right-aligned in a narrow column is unreadable.
 */
function StatGroup({ group }: { group: InfoboxGroup }) {
  return (
    <section>
      {group.label ? <h2 className="label mb-1.5">{group.label}</h2> : null}
      <dl className="overflow-hidden rounded-md border border-moss">
        {group.rows.map((row, i) => {
          const long = row.value.length > INLINE_VALUE_LIMIT;
          return (
            <div
              key={i}
              className={`border-b border-moss/60 px-3 py-2 last:border-b-0 odd:bg-peat/40 ${
                long ? '' : 'flex items-baseline justify-between gap-4'
              }`}
            >
              <dt className="shrink-0 text-sm text-ash">{row.label}</dt>
              <dd
                className={
                  long
                    ? 'mt-1 text-[0.85rem] leading-snug text-birch'
                    : 'text-right font-mono text-[0.8rem] text-birch'
                }
              >
                {row.value}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function Blocks({ blocks }: { blocks: ArticleBlock[] }) {
  const out: React.ReactNode[] = [];
  let lastSection = '';

  blocks.forEach((block, i) => {
    if (block.section && block.section !== lastSection) {
      lastSection = block.section;
      out.push(
        <h2 key={`h${i}`} className="display mt-4 text-sm text-birch first:mt-0">
          {block.section.split(' > ').at(-1)}
        </h2>,
      );
    }

    if (block.kind === 'paragraph') {
      out.push(
        <p key={i} className="max-w-[62ch] text-[0.95rem] leading-[1.7] text-birch/90">
          {block.text}
        </p>,
      );
      return;
    }

    if (block.kind === 'list') {
      const Tag = block.ordered ? 'ol' : 'ul';
      out.push(
        <Tag key={i} className="answer max-w-[62ch] text-[0.95rem] text-birch/90">
          {block.items.map((item, j) => (
            <li key={j}>{item}</li>
          ))}
        </Tag>,
      );
      return;
    }

    out.push(<DataTable key={i} block={block} />);
  });

  return <>{out}</>;
}

/**
 * A wide table on a narrow screen.
 *
 * The table scrolls inside its own box with the first column pinned, so the
 * row stays identifiable while reading across — and the page itself never
 * scrolls sideways, which is the thing that makes a phone wiki unusable.
 */
function DataTable({ block }: { block: TableBlock }) {
  return (
    <figure className="my-1">
      {block.caption ? (
        <figcaption className="label mb-1.5">{block.caption}</figcaption>
      ) : null}
      <div data-testid="table-scroller" className="overflow-x-auto rounded-md border border-moss">
        <table className="w-full border-collapse text-left text-[0.8rem]">
          <thead>
            <tr className="bg-peat">
              {block.headers.map((h, i) => (
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
            {block.rows.map((row, i) => (
              <tr key={i} className="odd:bg-peat/30">
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className={`whitespace-nowrap border-b border-moss/50 px-3 py-2 text-birch/90 ${
                      j === 0
                        ? 'sticky left-0 z-10 bg-bog font-medium text-birch odd:bg-bog'
                        : 'font-mono'
                    }`}
                  >
                    {cell}
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

function Gallery({ images, lang }: { images: ArticleDoc['images']; lang: Lang }) {
  const t = strings(lang);
  return (
    <section className="mt-8">
      <h2 className="label mb-2">{t.wikiGallery}</h2>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {images.slice(0, 12).map((image) => (
          <li key={image.url}>
            <figure className="overflow-hidden rounded-md border border-moss bg-peat">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.alt || image.caption || ''}
                loading="lazy"
                className="h-32 w-full object-contain p-1"
              />
              {image.caption ? (
                <figcaption className="border-t border-moss px-2 py-1 text-[0.68rem] text-ash">
                  {image.caption}
                </figcaption>
              ) : null}
            </figure>
          </li>
        ))}
      </ul>
    </section>
  );
}
