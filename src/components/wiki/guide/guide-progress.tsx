'use client';

import { useEffect } from 'react';

/** Bumped only if checkbox ids are ever reassigned to different tasks. */
export const PROGRESS_KEY = 'wv-guide-checks-v1';

/** The ids worth keeping: known, unique, and no more than the page has. */
export function parseProgress(raw: string | null, known: ReadonlySet<string>): Set<string> {
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((id): id is string => typeof id === 'string' && known.has(id)));
  } catch {
    return new Set();
  }
}

/**
 * Remembers which boxes of the guide are ticked, in this browser.
 *
 * The checklists were plain checkboxes that forgot everything on reload, which
 * was fine while every item chip opened the original wiki in a new tab: the
 * guide never left the screen. Now that a chip opens the Codex's own article
 * in the same tab, Back would bring the reader to a guide with every tick
 * gone. So the ticks are kept — locally, per browser, keyed by the checkbox
 * ids, which both languages share.
 *
 * Renders nothing. The boxes stay ordinary uncontrolled inputs that work
 * before this script loads; it only restores them once, then writes on change.
 * Storage that is blocked or full (a private window, a locked-down browser)
 * leaves the checklist working exactly as it did before: unsaved.
 */
export function GuideProgress({ rootId }: { rootId: string }) {
  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return;
    const boxes = (): HTMLInputElement[] =>
      Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"][id]'));

    try {
      const all = boxes();
      const saved = parseProgress(localStorage.getItem(PROGRESS_KEY), new Set(all.map((b) => b.id)));
      for (const box of all) if (saved.has(box.id)) box.checked = true;
    } catch {
      // Storage unavailable: nothing to restore.
    }

    const save = (event: Event): void => {
      if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox') return;
      try {
        const ticked = boxes().filter((b) => b.checked).map((b) => b.id);
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(ticked));
      } catch {
        // Storage unavailable or full: the tick still shows, it just is not kept.
      }
    };

    root.addEventListener('change', save);
    return () => root.removeEventListener('change', save);
  }, [rootId]);

  return null;
}
