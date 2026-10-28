'use client';

import Link, { useLinkStatus } from 'next/link';
import type { Route } from 'next';

export type Segment = {
  key: string;
  href: Route;
  label: string;
  /** The label's language, when it is not the page's (an English tab name in Spanish). */
  lang?: string;
  /** The view on screen: filled, and `aria-current` for a screen reader. */
  current: boolean;
};

/**
 * A row of mutually exclusive views, each one an address: List / Compare, and
 * the upgrade levels of a comparison. Links rather than buttons, so a
 * comparison at level 3 can be shared, bookmarked and reopened.
 *
 * Built like the language switch in the nav, so the app has one segmented
 * control: segments sit in a track 4px inside the group's border, and their
 * 2px corners (`rounded-xs`) are the group's 6px less that padding. The 1px
 * border is left out of the sum, which rounds the inner curve a pixel more
 * than an exact nest would. Their focus ring is drawn inside each segment
 * (`.focus-inset`), where neither the group's edge nor a neighbour can cut
 * it off — the old group clipped it to a sliver or hid it. On the
 * forge-filled segment the ring is birch: a forge ring vanishes into the
 * fill, and a bog one into the dark track around the segment, which is
 * exactly where an inset ring's outer edge falls. 44px tall on a touch
 * screen.
 *
 * A group with more segments than fit scrolls sideways instead of wrapping
 * into a ragged second row.
 *
 * `scroll={false}`: switching level or view keeps the reader where they are
 * on the page rather than jumping to its top. The old view stays on screen
 * until the new one arrives, so the tapped segment shows it was heard.
 */
export function SegmentedLinks({
  label,
  segments,
  className = '',
}: {
  label: string;
  segments: Segment[];
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex max-w-full gap-1 overflow-x-auto rounded-md border border-moss p-1 ${className}`}
    >
      {segments.map((segment) => (
        <Link
          key={segment.key}
          href={segment.href}
          scroll={false}
          aria-current={segment.current ? 'page' : undefined}
          lang={segment.lang}
          className={`focus-inset relative inline-flex h-8 shrink-0 items-center rounded-xs px-3 text-sm whitespace-nowrap transition-colors pointer-coarse:h-11 pointer-coarse:px-4 ${
            segment.current
              ? 'bg-forge text-bog [--focus-ring:var(--color-birch)]'
              : 'text-ash hover:bg-moss hover:text-birch'
          }`}
        >
          <Pending />
          {segment.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * A tint over the tapped segment until its view arrives. Always rendered and
 * only made visible, so it never moves the label.
 */
function Pending() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 rounded-xs bg-forge/25 transition-opacity ${
        pending ? 'opacity-100' : 'opacity-0'
      }`}
    />
  );
}
