'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useStrings } from '@/components/shell/lang-context';
import { parseAnswer, type InlineSegment } from '@/lib/answer-format';
import type { Citation } from '@/lib/db/schema';
import type { Lang } from '@/lib/i18n/strings';
import { citationHref } from '@/lib/routes';
import { FANDOM_IMG_PROPS, thumbnailImageUrl } from '@/lib/wiki/image-url';

/** The drawn size of an answer's picture, in CSS px (`.answer-figure` in chat.css). */
const FIGURE_PX = 220;

/**
 * Renders an answer, turning `[1]` markers into citation chips that link to the
 * wiki article and highlight their row in the source list on hover.
 *
 * Parsing lives in `@/lib/answer-format` so it can be tested without a DOM.
 *
 * `activeCitation` is this answer's own: citation numbers restart at 1 in
 * every answer, so one number shared by the whole thread lit up `[1]` in every
 * answer on the page at once.
 */
export function Answer({
  text,
  citations,
  lang,
  activeCitation,
  onCitationHover,
}: {
  text: string;
  citations: Citation[];
  lang: Lang;
  activeCitation: number | null;
  onCitationHover: (n: number | null) => void;
}) {
  const t = useStrings(lang);
  const blocks = parseAnswer(text);

  const inline = (segments: InlineSegment[]) => (
    <Inline
      segments={segments}
      citations={citations}
      activeCitation={activeCitation}
      onCitationHover={onCitationHover}
    />
  );

  return (
    <div className="answer chat-answer text-[0.975rem] leading-[1.7] text-birch/95">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading': {
            // A model's "## Requisitos" is a section of this answer, under the
            // page's own headings: h3 at most, never as loud as the page title.
            const Tag = block.level <= 2 ? 'h3' : 'h4';
            return <Tag key={i}>{inline(block.segments)}</Tag>;
          }
          case 'bullets':
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </ul>
            );
          case 'numbers':
            return (
              <ol key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </ol>
            );
          case 'table':
            return (
              <div key={i} className="answer-table stack-scroller" role="region" aria-label={t.chatTable} tabIndex={0}>
                <table className="stack-table">
                  <thead>
                    <tr>
                      {block.header.map((cell, j) => (
                        <th key={j} scope="col">
                          {inline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) =>
                          k === 0 ? (
                            <th key={k} scope="row">
                              {inline(cell)}
                            </th>
                          ) : (
                            // Names its column, which is what labels the value
                            // once the table stacks into cards on a phone. One
                            // wrapper: a stacked cell is a grid, and a value
                            // made of text and chips would otherwise spread
                            // over its rows.
                            <td key={k} data-label={plainText(block.header[k] ?? [])}>
                              <span>{inline(cell)}</span>
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'image': {
            const image = citations.find((c) => c.n === block.n)?.image;
            // No image on that source: render nothing. An answer missing a
            // picture still reads; a broken image frame does not.
            if (!image) return null;
            return (
              <figure key={i} className="answer-figure">
                {/* Hotlinked from Fandom's CDN at the size it is drawn, not through
                    `next/image`, which would proxy and re-encode it for no gain. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={thumbnailImageUrl(image.url, FIGURE_PX)}
                  alt={image.alt}
                  width={FIGURE_PX}
                  height={FIGURE_PX}
                  loading="lazy"
                  {...FANDOM_IMG_PROPS}
                />
              </figure>
            );
          }
          default:
            return <p key={i}>{inline(block.segments)}</p>;
        }
      })}
    </div>
  );
}

/** A header cell as plain text, for the `data-label` the stacked view shows. */
function plainText(segments: InlineSegment[]): string {
  return segments
    .map((segment) => (segment.type === 'citation' ? '' : segment.text))
    .join('')
    .trim();
}

function Inline({
  segments,
  citations,
  activeCitation,
  onCitationHover,
}: {
  segments: InlineSegment[];
  citations: Citation[];
  activeCitation: number | null;
  onCitationHover: (n: number | null) => void;
}) {
  return (
    <>
      {segments.map((segment, i) => {
        switch (segment.type) {
          case 'bold':
            return <strong key={i}>{segment.text}</strong>;
          case 'code':
            return <code key={i}>{segment.text}</code>;
          case 'citation': {
            const citation = citations.find((c) => c.n === segment.n);
            // A marker with no matching source would be a chip pointing
            // nowhere; show the raw number instead.
            if (!citation) return <span key={i}>[{segment.n}]</span>;

            const chipProps = {
              className: 'rune-chip',
              'data-active': activeCitation === segment.n,
              title: `${citation.title}${citation.sectionPath ? ` › ${citation.sectionPath}` : ''}`,
              onMouseEnter: () => onCitationHover(segment.n),
              onMouseLeave: () => onCitationHover(null),
              onFocus: () => onCitationHover(segment.n),
              onBlur: () => onCitationHover(null),
            };

            const link = citationHref(citation);
            return link.internal ? (
              <Link key={i} href={link.href as Route} {...chipProps}>
                {segment.n}
              </Link>
            ) : (
              <a key={i} href={link.href} target="_blank" rel="noreferrer" {...chipProps}>
                {segment.n}
              </a>
            );
          }
          default:
            return <span key={i}>{segment.text}</span>;
        }
      })}
    </>
  );
}
