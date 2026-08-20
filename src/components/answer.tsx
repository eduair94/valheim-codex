'use client';

import Link from 'next/link';
import { parseAnswer, type InlineSegment } from '@/lib/answer-format';
import type { Citation } from '@/lib/db/schema';
import type { Route } from 'next';
import { citationHref } from '@/lib/routes';

/**
 * Renders an answer, turning `[1]` markers into citation chips that link to the
 * wiki article and highlight their row in the source list on hover.
 *
 * Parsing lives in `@/lib/answer-format` so it can be tested without a DOM.
 */
export function Answer({
  text,
  citations,
  activeCitation,
  onCitationHover,
}: {
  text: string;
  citations: Citation[];
  activeCitation: number | null;
  onCitationHover: (n: number | null) => void;
}) {
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
    <div className="answer text-[0.975rem] leading-[1.7] text-birch/95">
      {blocks.map((block, i) => {
        if (block.type === 'bullets') {
          return (
            <ul key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === 'numbers') {
          return (
            <ol key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ol>
          );
        }
        return <p key={i}>{inline(block.segments)}</p>;
      })}
    </div>
  );
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
