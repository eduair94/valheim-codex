import { Fragment } from 'react';
import Link from 'next/link';
import { articleHref } from '@/lib/routes';
import { linkify, type Linker } from '@/lib/wiki/links';

/**
 * A run of article text with the names in it linked to their articles.
 *
 * Underlined rather than coloured: the prose is already the quiet colour and
 * the numbers the loud one, and a third colour for links would make a stat
 * block flicker. A thin amber underline says "this goes somewhere" without
 * turning "Wood x10; Stone x5" into a rainbow.
 */
export function LinkedText({ text, linker }: { text: string; linker: Linker }) {
  const segments = linkify(text, linker);
  if (segments.length === 1 && !segments[0]?.link) return <>{text}</>;

  return (
    <>
      {segments.map((segment, i) =>
        segment.link ? (
          <Link
            key={i}
            href={articleHref(segment.link.slug)}
            title={segment.link.title}
            className="underline decoration-forge/50 decoration-[1.5px] underline-offset-[3px] transition-colors hover:text-birch hover:decoration-forge"
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
