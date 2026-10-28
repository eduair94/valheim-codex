import { Fragment } from 'react';
import Link from 'next/link';
import { articleHref } from '@/lib/routes';
import { linkify, type Linker, type Segment } from '@/lib/wiki/links';
import { isMention, lineCuts, splitSegments } from './article/lines';

/**
 * A run of article text with the names in it linked to their articles.
 *
 * Underlined rather than coloured: the prose is already the quiet colour and
 * the numbers the loud one, and a third colour for links would make a stat
 * block flicker. A thin amber underline says "this goes somewhere" without
 * turning "Wood x10; Stone x5" into a rainbow.
 *
 * A server component: the linking runs once, where the page is rendered, and
 * the browser receives plain anchors instead of the linker and a regular
 * expression over every name the article mentions.
 *
 * Not prefetched on sight. An article names dozens of others, and every link
 * in view used to cost a request and a database query before anyone tapped
 * anything (PERF-03). The article fetches a link's page once the reader
 * shows intent instead — a pointer resting on it, a finger landing on it, the
 * focus staying on it (`IntentPrefetch`) — and fetches all of it, data
 * included: a default prefetch stops at the route's loading state, and with
 * none it brings the page's `<head>` alone. A tap after that shows the page
 * from the router's memory; a tap that comes before it waits for the server,
 * under the shell's progress bar.
 *
 * `lines` renders a string that holds one entry per line ("10 Wood\n15
 * Flint") as one line per entry; `repair` also finds the breaks an older
 * ingest lost (`lineCuts`). The string is linked whole and split after: the
 * server's link decisions are keyed by the whole string.
 */
export function LinkedText({
  text,
  linker,
  lines = false,
  repair,
}: {
  text: string;
  linker: Linker;
  lines?: boolean;
  repair?: 'cell' | 'value';
}) {
  // Checked before any split: a bogus whole-item link cut into lines would
  // pass the check one short line at a time.
  const segments = linkify(text, linker).map((segment) => (isMention(segment) ? segment : { text: segment.text }));
  const cuts = lines ? lineCuts(text, repair) : [];
  if (cuts.length === 0) return <Segments segments={segments} />;

  return (
    <>
      {splitSegments(segments, cuts).map((line, i) => (
        <span key={i} className="block">
          <Segments segments={line} />
        </span>
      ))}
    </>
  );
}

function Segments({ segments }: { segments: readonly Segment[] }) {
  return (
    <>
      {segments.map((segment, i) =>
        segment.link ? (
          <Link
            key={i}
            href={articleHref(segment.link.slug)}
            title={segment.link.title}
            prefetch={false}
            className="text-link"
          >
            {segment.text}
          </Link>
        ) : (
          <Fragment key={i}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}
