'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * A table's box, which becomes a keyboard stop only while it has something
 * to scroll.
 *
 * A wide table scrolls sideways inside its own box; a pointer can drag it,
 * but without a tab stop a keyboard cannot reach the columns past the edge.
 * The stop used to be there always, though, and on a phone — where the table
 * is a stack of cards and scrolls nothing — every table added an empty stop
 * between the reader and the next link (LM-20). So the box asks itself
 * whether it overflows, and only then takes focus and a name.
 *
 * The name is the table's caption where it has one (`labelledBy`). Otherwise
 * it is the word "table" in the interface's language, kept in a hidden
 * element so that it can say which language it is in: written as an
 * `aria-label` it took the language of the box, which is the article's, and
 * an English article in the Spanish interface called its tables "Tabla" in
 * English (I18N-04).
 */
export function ScrollRegion({
  labelledBy,
  label,
  labelLang,
  className,
  children,
}: {
  /** The id of the element that names the table, when there is one: its caption. */
  labelledBy?: string;
  /** The name without a caption. */
  label: string;
  /** Set when the name is in another language than the article around it. */
  labelLang?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const fallbackId = `${useId()}-name`;

  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = (): void => setScrolls(box.scrollWidth > box.clientWidth + 1);
    if (typeof ResizeObserver === 'undefined') {
      const frame = requestAnimationFrame(measure);
      return () => cancelAnimationFrame(frame);
    }
    // An observer reports each box once as soon as it is observed, so this
    // is also the first measurement.
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    // The table changes width on its own when a font arrives late.
    const table = box.querySelector(':scope > table');
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-testid="table-scroller"
      className={className}
      {...(scrolls ? { tabIndex: 0, role: 'region', 'aria-labelledby': labelledBy ?? fallbackId } : {})}
    >
      {labelledBy ? null : (
        <span id={fallbackId} hidden lang={labelLang}>
          {label}
        </span>
      )}
      {children}
    </div>
  );
}
