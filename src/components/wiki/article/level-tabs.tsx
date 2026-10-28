'use client';

import { useId, useRef, useState } from 'react';

export type LevelTab = {
  /** What the tab says: "Nivel 2", "1★", "Trofeo". */
  text: string;
  /** A fuller name for assistive technology when the text is a symbol ("1 estrella"). */
  name?: string;
};

/**
 * The infobox's level switcher: upgrade levels, star levels or variants.
 *
 * Real tabs (LD-04): one tab stop for the set, arrow keys move between them,
 * and each panel says which tab names it. Switching is cheap and instant, so a
 * tab is selected as soon as it is focused.
 *
 * Built like the other segmented controls (`SegmentedLinks`): 2px corners
 * that nest in the track's 6px ones, and a ring drawn inside each tab. The
 * focused tab is nearly always the forge-filled one, so that ring is birch
 * there; a bog one merged into the dark track around the tab, and focusing it
 * showed almost no change.
 *
 * The panels are rendered on the server, all of them, and passed in; this
 * component only decides which one is visible. The stats themselves never
 * reach the browser as code, only as the markup of each level.
 *
 * The switcher always sits directly above the rows it changes. Where the
 * infobox is spread over three columns (`spread`), the switcher spans them,
 * with the rows common to every level in columns above it and the level's own
 * rows in columns below; inside the flow of the columns it landed at the foot
 * of the first one, and a click changed numbers 400px above it, two columns
 * over.
 */
export function LevelTabs({
  label,
  hint,
  tabs,
  panels,
  uiLang,
  spread = false,
  after,
  className,
}: {
  label: string;
  hint?: string;
  tabs: LevelTab[];
  panels: React.ReactNode[];
  /** Set when the article around it is in another language than the interface. */
  uiLang?: string;
  /** The infobox is spread over three columns from 1024px. */
  spread?: boolean;
  /** What follows the levels' rows in their flow: the docked "ask" link. */
  after?: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const select = (index: number): void => {
    const next = (index + tabs.length) % tabs.length;
    setActive(next);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const moves: Record<string, number> = {
      ArrowRight: active + 1,
      ArrowDown: active + 1,
      ArrowLeft: active - 1,
      ArrowUp: active - 1,
      Home: 0,
      End: tabs.length - 1,
    };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(target);
  };

  return (
    <div className={className}>
      <p id={`${id}-label`} lang={uiLang} className="label">
        {label}
      </p>
      {/*
       * Spread, the switcher and its hint share a line: the switcher as wide
       * as its tabs, the hint taking the rest, or a line of its own when it
       * would be squeezed.
       */}
      <div className={`mt-2 ${spread ? 'lg:flex lg:flex-wrap lg:items-center lg:gap-x-6 lg:gap-y-2' : ''}`}>
        <div
          role="tablist"
          aria-labelledby={`${id}-label`}
          lang={uiLang}
          onKeyDown={onKeyDown}
          className="flex flex-wrap gap-1 rounded-md border border-moss bg-peat p-1 sm:w-fit"
        >
          {tabs.map((tab, i) => {
            const selected = i === active;
            return (
              <button
                key={`${tab.text}-${i}`}
                ref={(button) => {
                  buttons.current[i] = button;
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${i}`}
                aria-selected={selected}
                aria-controls={`${id}-panel-${i}`}
                aria-label={tab.name}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(i)}
                className={`focus-inset min-h-8 flex-1 basis-18 rounded-xs px-3 font-mono text-xs whitespace-nowrap transition-colors pointer-coarse:min-h-11 pointer-coarse:min-w-11 sm:flex-none ${
                  selected ? 'bg-forge text-bog [--focus-ring:var(--color-birch)]' : 'text-ash hover:text-birch'
                }`}
              >
                {tab.text}
              </button>
            );
          })}
        </div>
        {hint ? (
          <p
            lang={uiLang}
            className={`mt-2 max-w-[65ch] text-sm leading-snug text-ash ${spread ? 'lg:mt-0 lg:min-w-64 lg:flex-1' : ''}`}
          >
            {hint}
          </p>
        ) : null}
      </div>

      {/*
       * The selected level's rows, then whatever ends the box. One flow, so
       * that spread they fill the three columns together. Each panel spaces
       * its own groups; the panels themselves carry no margin, since a hidden
       * one is still a sibling to a selector that counts them.
       */}
      <div className={`mt-6 ${spread ? 'lg:columns-3 lg:gap-8' : ''}`}>
        {panels.map((panel, i) => (
          <div key={i} role="tabpanel" id={`${id}-panel-${i}`} aria-labelledby={`${id}-tab-${i}`} hidden={i !== active}>
            {panel}
          </div>
        ))}
        {after}
      </div>
    </div>
  );
}
