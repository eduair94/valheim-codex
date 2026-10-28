'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { AskGlyph, LockGlyph } from './article/glyphs';
import type { AskTarget } from './article/ask-link';
import { STAND_DOWN, type Docked } from './article/ask-stand-down';

/** Movement below this is noise from a thumb resting on the screen. */
const THRESHOLD_PX = 12;

/** Applied only without JavaScript: see `AskButton`. */
const NO_SCRIPT_CSS = '[data-ask-float]{display:none}';

/**
 * "Ask about this", floating above the article.
 *
 * Fixed rather than in the flow because the reason to ask is usually something
 * noticed halfway down a long page, and scrolling back to a button at the top
 * is exactly the friction this reader exists to remove. It sits above the
 * phone's tab bar by the bar's own height (`--tabbar-h`, which includes the
 * home indicator), so on a notched iPhone it no longer slides under the bar
 * where a tap on it landed on "Buscar" (LM-02).
 *
 * It hides while scrolling down and returns on the way up. A permanently fixed
 * button sits on top of a stat row — which on this page is the content someone
 * came for — and pushing the article down by its height would waste a strip of
 * a phone screen on every article, including the ones nobody asks about.
 *
 * Hidden means gone, not just transparent: `inert` takes it out of hit-testing,
 * the tab order and the accessibility tree at once. An invisible button used
 * to swallow taps meant for the links under it (BC-02). The article ends with
 * the same action as an ordinary link, which is how a keyboard reaches it.
 *
 * `docked`: where, from 1024px, the infobox carries the action itself and this
 * one stands down. `always` when the infobox is spread above the text, where
 * the docked copy ends it; `sticky` when it is a column beside the text, and
 * then only while that column stays in view; `never` without an infobox.
 *
 * Without JavaScript it is not drawn at all (the `<noscript>` rule): nothing
 * would ever hide it on the way down, and it would sit over the last line of
 * the screen for the whole article. The link at the end of the article is
 * the way to ask then.
 */
export function AskButton({
  ask,
  label,
  docked,
  lang,
}: {
  ask: AskTarget;
  label: string;
  docked: Docked;
  /** Set when the article around it is in another language than the interface. */
  lang?: string;
}) {
  const [visible, setVisible] = useState(true);
  const lastY = useRef(0);

  useEffect(() => {
    lastY.current = window.scrollY;

    const onScroll = (): void => {
      const y = window.scrollY;
      const delta = y - lastY.current;
      if (Math.abs(delta) < THRESHOLD_PX) return;
      lastY.current = y;

      // Always available at the very top, where there is nothing to cover.
      setVisible(delta < 0 || y < 80);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <>
      <noscript>
        <style>{NO_SCRIPT_CSS}</style>
      </noscript>
      <div
        data-ask-float=""
        lang={lang}
        inert={!visible}
        className={`pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-h)+0.75rem)] z-20 flex justify-center px-4 transition-[opacity,translate] duration-200 print:hidden sm:bottom-6 ${
          visible ? 'opacity-100' : 'translate-y-4 opacity-0'
        } ${STAND_DOWN[docked]}`}
      >
        {/*
         * The hover mixes its tint into the button's own peat (4.64:1). A
         * see-through forge/20 showed whatever scrolled beneath it, and over
         * a peat surface the forge label fell to 4.24:1, under 4.5:1.
         */}
        <Link
          href={ask.href as Route}
          prefetch={false}
          className={`inline-flex min-h-11 items-center gap-2 rounded-full border border-forge/40 bg-peat px-5 text-sm text-forge shadow-lg shadow-bog/60 transition-colors hover:border-forge hover:bg-[color-mix(in_srgb,var(--color-forge)_15%,var(--color-peat))] ${
            visible ? 'pointer-events-auto' : ''
          }`}
        >
          <AskGlyph />
          <span>{label}</span>
          {ask.locked ? (
            <>
              <LockGlyph />
              <span className="sr-only">, {ask.lockedNote}</span>
            </>
          ) : null}
        </Link>
      </div>
    </>
  );
}
