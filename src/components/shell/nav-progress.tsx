'use client';

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { createTracker, FADE_MS, GIVE_UP_MS, QUIET_MS, type View } from './nav-tracker';

/*
 * Unlayered, like the search page's own `<style>`: rendered here it may reach
 * the document before the stylesheet that declares the layers' order, and a
 * layer named first would be ordered first.
 *
 * Everything moves by animation, and only `opacity` and `transform`, which
 * the compositor runs on its own: the bar shows on time and keeps moving
 * while the main thread is busy with the page it is waiting for. (Hidden by
 * `visibility` instead, it waited for the main thread, up to a third of a
 * second after the tap on a busy list; and a transition would not do for the
 * fade, as Chromium starts none on a property an animation was driving.)
 *
 * While a change is on its way: `nav-progress-show` keeps the bar out of
 * sight until `QUIET_MS` after the tap, then fades it in; `nav-progress`
 * grows it fast, then slower and slower, towards nine tenths, which it
 * reaches as it gives up (a third of the way after a second, nearly half
 * after two). When the page lands it stands whole and `nav-progress-fade`
 * takes it out.
 *
 * With reduced motion it is a still bar at full width, shown after the same
 * pause and removed at once.
 */
const CSS =
  '.nav-progress{position:fixed;inset-inline:0;top:env(safe-area-inset-top,0px);z-index:70;height:2px;' +
  'background:var(--color-forge,#d98a34);transform-origin:left;pointer-events:none}' +
  `.nav-progress[data-state=pending]{animation:nav-progress-show 80ms ${QUIET_MS}ms both,` +
  `nav-progress ${GIVE_UP_MS}ms cubic-bezier(0,.55,.45,1) ${QUIET_MS}ms both}` +
  `.nav-progress[data-state=done]{animation:nav-progress-fade ${FADE_MS}ms ease-in both}` +
  '@keyframes nav-progress-show{from{opacity:0}to{opacity:1}}' +
  '@keyframes nav-progress{from{transform:scaleX(.08)}to{transform:scaleX(.9)}}' +
  '@keyframes nav-progress-fade{from{opacity:1}to{opacity:0}}' +
  '@media (prefers-reduced-motion:reduce){' +
  `.nav-progress[data-state=pending]{animation:nav-progress-show 0s ${QUIET_MS}ms both}` +
  '.nav-progress[data-state=done]{animation:none;opacity:0}}' +
  '@media (forced-colors:active){.nav-progress{forced-color-adjust:none;background:Highlight}}' +
  '@media print{.nav-progress{display:none}}';

/**
 * A thin forge-coloured line along the top of the screen while a page change
 * is on its way.
 *
 * The reader's pages have no loading boundary: one made the page's content
 * wait, hidden, until all of it had arrived, which cost more than the
 * skeleton it painted was worth. So after a tap the page on screen stays
 * until the next one is ready, and this says the tap was heard. It starts on
 * a click on a link to another page of the site, on a form that names one
 * (`next/form`), and on `navigationStarted` (nav-tracker.ts) for code that
 * calls `router.push`. It ends when the address says a page has landed;
 * at once, without its finish, when Next has dropped the change and shows
 * no other page (the page wrote its own address, Back within the page, a
 * tap on the page on screen: `createTracker` has the list); or after
 * `GIVE_UP_MS`. A change that lands within `QUIET_MS` shows nothing.
 *
 * Fixed and out of the layout, so it moves nothing. Decoration only: the
 * route announcer already tells a screen reader that the page changed.
 *
 * Rendered once, by the root layout: the chat has no reader frame, and a bar
 * in the frame would be unmounted by the very change it was showing.
 */
export function NavProgress() {
  // `useSearchParams` would hold a statically rendered route back from the
  // server's HTML without a boundary; the bar has nothing to show there.
  return (
    <Suspense fallback={null}>
      <Bar />
    </Suspense>
  );
}

function Bar() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [view, setView] = useState<View>({ phase: 'idle', run: 0, since: 0 });
  const [tracker] = useState(() => createTracker(setView));
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => tracker.listen(), [tracker]);
  // The router's address moved: the page has landed, been dropped, or not yet.
  useEffect(() => tracker.check(), [tracker, pathname, search]);
  // The quiet period counts from the tap, not from whenever the page under
  // it found the time to draw the bar: a busy phone took a tenth of a second
  // or more, and the bar showed that much later.
  useLayoutEffect(() => {
    if (view.phase !== 'pending' || !bar.current) return;
    for (const animation of bar.current.getAnimations?.() ?? []) animation.startTime = view.since;
  }, [view.phase, view.run, view.since]);

  return (
    <>
      <style href="nav-progress" precedence="medium">
        {CSS}
      </style>
      {view.phase === 'idle' ? null : (
        // A new run is a new element, so its animation starts from the beginning.
        <div ref={bar} key={view.run} aria-hidden="true" className="nav-progress" data-state={view.phase} />
      )}
    </>
  );
}
