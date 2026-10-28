'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';

export type TocEntry = {
  id: string;
  label: string;
  /** Set when the label is in another language than the page (biome names in a Spanish page). */
  lang?: string;
  rune?: string;
  children?: TocEntry[];
};

const SHEET_ID = 'guide-toc-sheet';

/** Movement below this is noise from a thumb resting on the screen. */
const THRESHOLD_PX = 12;

/**
 * The line a section has to cross to count as the one being read: a third of
 * the way down the screen, where the eye sits once a heading has scrolled up
 * out of the way, rather than the very top edge, which a heading only reaches
 * a moment after its text is already being read.
 */
const READING_LINE = 0.3;

/**
 * The guide's table of contents, in the two shapes the screen allows.
 *
 * From `lg` up it is a column of its own beside the text, sticky under the
 * nav, so every chapter is one click away from anywhere on an eleven-screen
 * page. Below that there is no room for a column, and a list parked at the top
 * would be twenty phone screens away by the time it is wanted — mid-Mistlands,
 * looking for the Plains. So on a phone it is a pill above the tab bar that
 * opens the same list as a sheet, in the thumb's reach. The pill hides while
 * the reader scrolls down and comes back on the way up, as the ask button on
 * articles does, so it never sits on top of the line being read.
 *
 * Both are plain markup that works before this script loads: in-page links,
 * a sticky column, and a native popover (`popovertarget`) that opens, closes
 * on Escape and on a tap outside with no JavaScript at all. The script adds
 * the parts that need it: marking the chapter being read (`aria-current`),
 * closing the sheet once a chapter is chosen or focus leaves it, and hiding
 * the pill.
 */
export function GuideToc({
  entries,
  label,
  openLabel,
  closeLabel,
}: {
  entries: TocEntry[];
  label: string;
  openLabel: string;
  closeLabel: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [pillVisible, setPillVisible] = useState(true);
  const sheet = useRef<HTMLElement>(null);
  const pill = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const targets = flatten(entries)
      .map((entry) => document.getElementById(entry.id))
      .filter((el): el is HTMLElement => el !== null);
    const lastId = targets.at(-1)?.id ?? null;
    let sheetOpen = false;
    let frame = 0;

    /*
     * Which way the reader is going, measured on the page itself — how far
     * the section being read moved on screen — rather than on `scrollY`. When
     * a chapter above the screen is drawn for the first time and turns out
     * taller than its estimate, the browser moves `scrollY` by the difference,
     * hundreds of pixels at once, to keep what is on screen where it was. Read
     * off `scrollY`, that made a reader going up look like one going down, and
     * the pill hid just as it was wanted.
     */
    let ref: HTMLElement | null = null;
    let refTop = 0;
    let travel = 0;

    const update = (): void => {
      frame = 0;
      const y = window.scrollY;

      /*
       * Sections are listed in document order and nested ones start after
       * their parent's heading, so their tops only ever increase: the one
       * being read is the last whose top has crossed the reading line.
       */
      const line = window.innerHeight * READING_LINE;
      let current: HTMLElement | null = null;
      let currentTop = 0;
      for (const el of targets) {
        const top = el.getBoundingClientRect().top;
        if (top > line) break;
        current = el;
        currentTop = top;
      }
      // The last sections are short, and at the bottom of the page they can
      // never climb as far as the line; the end of the page means the last one.
      const atEnd = window.innerHeight + y >= document.documentElement.scrollHeight - 2;
      setActive(atEnd ? lastId : (current?.id ?? null));

      if (ref) travel += refTop - (ref === current ? currentTop : ref.getBoundingClientRect().top);
      ref = current ?? targets[0] ?? null;
      refTop = ref === current ? currentTop : (ref?.getBoundingClientRect().top ?? 0);

      if (Math.abs(travel) < THRESHOLD_PX) return;
      const down = travel > 0;
      travel = 0;
      // Never hidden while it holds focus or its sheet is open: that would
      // take the control away from someone who is using it.
      const inUse = sheetOpen || document.activeElement === pill.current;
      setPillVisible(inUse || !down || y < 80);
    };

    const onScroll = (): void => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // A resize moves the text by reflowing it, not by the reader scrolling.
    const onResize = (): void => {
      ref = null;
      travel = 0;
      onScroll();
    };
    const onToggle = (event: Event): void => {
      sheetOpen = (event as ToggleEvent).newState === 'open';
      if (sheetOpen) setPillVisible(true);
    };

    const sheetEl = sheet.current;
    /*
     * A popover keeps no hold on focus: tabbing on from its last entry moved
     * focus to the links of the page behind it, under the sheet, out of
     * sight. Focus going anywhere but the sheet or its own pill closes it, as
     * a tap outside does.
     */
    const onFocusIn = (event: FocusEvent): void => {
      if (!sheetOpen || !sheetEl || !(event.target instanceof Node)) return;
      if (sheetEl.contains(event.target) || event.target === pill.current) return;
      if (sheetEl.matches(':popover-open')) sheetEl.hidePopover();
    };

    sheetEl?.addEventListener('toggle', onToggle);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    update();

    return () => {
      sheetEl?.removeEventListener('toggle', onToggle);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [entries]);

  /*
   * Closing in the click itself, before the browser follows the link: the
   * jump then lands on a page with no sheet over it, and focus returns to the
   * pill that opened it, as it does for any popover.
   */
  const closeOnChoice = (event: MouseEvent<HTMLElement>): void => {
    if ((event.target as Element).closest('a[href^="#"]')) sheet.current?.hidePopover();
  };

  return (
    <>
      <nav aria-labelledby="guide-toc-side-title" className="g-toc-side">
        <p id="guide-toc-side-title" className="label">
          {label}
        </p>
        <TocList entries={entries} active={active} />
      </nav>

      <button
        ref={pill}
        type="button"
        popoverTarget={SHEET_ID}
        className="g-toc-pill"
        data-hidden={pillVisible ? undefined : ''}
        aria-hidden={pillVisible ? undefined : true}
        tabIndex={pillVisible ? undefined : -1}
      >
        <span aria-hidden="true" className="g-rune">
          ᛦ
        </span>
        {openLabel}
      </button>

      <nav
        ref={sheet}
        id={SHEET_ID}
        popover="auto"
        aria-labelledby="guide-toc-sheet-title"
        className="g-toc-sheet"
        onClick={closeOnChoice}
      >
        <div className="g-toc-sheet-head">
          <p id="guide-toc-sheet-title" className="label">
            {label}
          </p>
          <button
            type="button"
            popoverTarget={SHEET_ID}
            popoverTargetAction="hide"
            aria-label={closeLabel}
            className="g-toc-close"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <TocList entries={entries} active={active} />
      </nav>
    </>
  );
}

function TocList({ entries, active }: { entries: TocEntry[]; active: string | null }) {
  return (
    <ol className="g-toc-list">
      {entries.map((entry) => (
        <li key={entry.id}>
          <a href={`#${entry.id}`} aria-current={entry.id === active ? 'location' : undefined}>
            {entry.rune ? (
              <span aria-hidden="true" className="g-rune">
                {entry.rune}
              </span>
            ) : null}
            <span lang={entry.lang}>{entry.label}</span>
          </a>
          {entry.children ? <TocList entries={entry.children} active={active} /> : null}
        </li>
      ))}
    </ol>
  );
}

function flatten(entries: TocEntry[]): TocEntry[] {
  return entries.flatMap((entry) => [entry, ...flatten(entry.children ?? [])]);
}
