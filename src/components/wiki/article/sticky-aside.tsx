'use client';

import { useEffect, useRef, useState } from 'react';

/** From here up the infobox sits beside the text instead of above it. */
const SIDE_BY_SIDE = '(min-width: 64rem)';

/** Room kept below a stuck infobox, so its last row never touches the edge. */
const BOTTOM_GAP_PX = 24;

/**
 * The infobox column, kept in view while the text beside it scrolls — but
 * only when all of it fits in the window.
 *
 * Pinned and taller than the window, its last rows (and the ask button docked
 * at its foot) would be out of reach until the reader had scrolled past the
 * whole article. So the aside measures itself against the window and is
 * sticky only when it fits; an item with forty stat rows simply scrolls with
 * the page. `data-sticky` is the only thing this decides: where it sticks is
 * CSS (`top`), so it is right from the first paint once it applies.
 *
 * Without JavaScript the aside is never sticky, which is the safe default.
 */
export function StickyAside({
  labelledBy,
  enabled = true,
  className,
  children,
}: {
  /** The id of the aside's heading, which names the landmark. */
  labelledBy: string;
  /** False where the box is not a column beside the text, and so never sticks. */
  enabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [fits, setFits] = useState(false);

  useEffect(() => {
    const aside = ref.current;
    if (!enabled || !aside || typeof ResizeObserver === 'undefined') return;
    const wide = window.matchMedia(SIDE_BY_SIDE);

    const measure = (): void => {
      // `top` resolves to the sticky offset in pixels whether or not the
      // element is positioned yet, so the check uses the same number as CSS.
      const top = Number.parseFloat(getComputedStyle(aside).top) || 0;
      setFits(wide.matches && aside.offsetHeight + top + BOTTOM_GAP_PX <= window.innerHeight);
    };

    const observer = new ResizeObserver(measure);
    observer.observe(aside);
    window.addEventListener('resize', measure);
    wide.addEventListener('change', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      wide.removeEventListener('change', measure);
    };
  }, [enabled]);

  return (
    <aside ref={ref} aria-labelledby={labelledBy} data-sticky={enabled && fits ? '' : undefined} className={className}>
      {children}
    </aside>
  );
}
