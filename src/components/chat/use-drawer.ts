'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** From this width the panel is a static column and never a drawer (Tailwind's `lg`). */
export const STATIC_SIDEBAR_QUERY = '(min-width: 64rem)';

const FOCUSABLE =
  'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The conversation drawer below 1024px, as a modal dialog.
 *
 * It used to be only slid off-screen, so its seven controls stayed first in
 * the tab order, invisible; opening it left focus behind the backdrop, Tab
 * wandered into the page underneath, Escape did nothing and closing lost the
 * focus somewhere off-screen. Now: closed, it is hidden from the tab order
 * and from assistive technology (`invisible` on the container, see the
 * chat); open, focus moves into it and stays there (the page behind is
 * `inert`, and Tab wraps), Escape and the backdrop close it, and focus goes
 * back to the button that opened it, or wherever the action that closed it
 * sends it.
 */
export function useDrawer() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes on opening: the close button, or a control inside asked for by id. */
  const focusOnOpen = useRef<string | null>(null);
  /** Where it goes on closing: the trigger, or an element the closing action names. */
  const focusOnClose = useRef<string | null>(null);
  const wasOpen = useRef(false);

  const show = useCallback((options: { focusId?: string } = {}) => {
    focusOnOpen.current = options.focusId ?? null;
    setOpen(true);
  }, []);

  /**
   * Closes the drawer; focus returns to the button that opened it unless
   * `focusId` names somewhere else. Moved once the drawer has closed: until
   * then the page behind it is still inert and cannot take focus.
   */
  const hide = useCallback((options: { focusId?: string } = {}) => {
    focusOnClose.current = options.focusId ?? null;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      const target = (focusOnOpen.current ? document.getElementById(focusOnOpen.current) : null) ?? closeRef.current;
      target?.focus();
      // A browser that has not yet made the panel visible ignores the call; once more on the next frame.
      if (target && document.activeElement !== target) {
        const frame = requestAnimationFrame(() => target.focus());
        return () => cancelAnimationFrame(frame);
      }
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const target = focusOnClose.current ? document.getElementById(focusOnClose.current) : null;
    (target ?? triggerRef.current)?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hide();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      const inside = panel.contains(document.activeElement);
      if (event.shiftKey && (!inside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, hide]);

  // Turning a tablet, or widening a window, past 1024px makes the panel a
  // static column: a drawer left open would keep the page behind it inert.
  useEffect(() => {
    const query = window.matchMedia(STATIC_SIDEBAR_QUERY);
    const onChange = (): void => {
      if (query.matches) setOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return { open, show, hide, triggerRef, panelRef, closeRef };
}
