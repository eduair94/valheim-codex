'use client';

import { createContext, useContext, useMemo, useState, useSyncExternalStore } from 'react';

/**
 * One selected upgrade level per article, shared by everything that shows a
 * level: the infobox's level switcher (`LevelTabs`) and the craft card,
 * which must never show one level's recipe under another level's stats.
 *
 * The level travels in the address as a fragment, `#level-4`
 * (`articleLevelHref`), not as a query parameter: the server renders one
 * page per article and the service worker keeps one copy of it, whatever
 * level a link names. The server, and the first render in the browser,
 * always show the first level, so the two agree; the fragment is read once
 * the page has hydrated.
 *
 * Picking a level rewrites the fragment in place (`replaceState`): no new
 * history entry, so Back leaves the article instead of stepping through its
 * levels, and no scroll, which rewriting the address never does, though the
 * article's top answers to `#level-4` for a link that opens it there
 * (`LevelTargets`, article-view.tsx). The router's own state
 * (`history.state`) is handed back as it was, which Next takes as one of its
 * own writes and leaves alone, where any other state would have it re-read
 * the page for the new address.
 *
 * Mounted by `Infobox` around switchers of upgrade levels only: a creature's
 * star levels and an item's variants keep a level of their own, and the
 * address never moves them.
 */

/** `#level-4`: an article opened on one upgrade level. */
export const LEVEL_FRAGMENT = /^#level-(\d{1,2})$/;

/** The tab a fragment names among an article's levels, by the level's number; null for any other fragment. */
export function levelFromHash(hash: string, qualities: readonly number[]): number | null {
  const match = LEVEL_FRAGMENT.exec(hash);
  if (!match) return null;
  const index = qualities.indexOf(Number(match[1]));
  return index >= 0 ? index : null;
}

/** The fragment for one tab: none for the first, where the article opens anyway, as `articleLevelHref` writes it. */
export function levelHash(qualities: readonly number[], index: number): string {
  const quality = qualities[index];
  return index > 0 && quality !== undefined ? `#level-${quality}` : '';
}

/*
 * The address's fragment, as a store React reads while rendering. Read live,
 * so a page opened at `#level-4`, by a link or a client-side navigation,
 * shows level 4 as soon as it has hydrated (React renders the server's
 * value first, then this one).
 *
 * `moves` counts the times the fragment moved because the reader did
 * something: followed a fragment link, went Back or Forward (`hashchange`,
 * `popstate`), or picked a level here. The router also rewrites the address
 * on its own when it refreshes the page (a finished translation, a language
 * switch), putting back the fragment the page was opened with; a level
 * picked since stays picked, because no move came after it.
 */
let moves = 0;
const listeners = new Set<() => void>();

function moved(): void {
  moves += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener('hashchange', moved);
    window.addEventListener('popstate', moved);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener('hashchange', moved);
    window.removeEventListener('popstate', moved);
  };
}

/** The moves and the fragment in one string, which compares by value, as a store's snapshot must. */
const readAddress = (): string => `${moves} ${window.location.hash}`;
const noAddress = (): string => '0 ';

export type LevelState = {
  /** The levels, as the tabs number them. */
  readonly qualities: readonly number[];
  /** The selected tab. */
  readonly index: number;
  /** Selects a tab and writes its fragment into the address. */
  select(index: number): void;
};

const LevelContext = createContext<LevelState | null>(null);

export function LevelProvider({ qualities, children }: { qualities: number[]; children?: React.ReactNode }) {
  // By value: the server hands down a new array on every render of the page.
  const key = qualities.join(',');
  const levels = useMemo(() => key.split(',').map(Number), [key]);

  const address = useSyncExternalStore(subscribe, readAddress, noAddress);
  const space = address.indexOf(' ');
  const at = Number(address.slice(0, space));
  const hash = address.slice(space + 1);

  const [picked, setPicked] = useState<{ index: number; at: number } | null>(null);
  // A level picked here holds until the reader moves the address again; a
  // level fragment arriving after that wins, and any other fragment (the
  // skip link's `#main`) leaves the level where it was.
  const wanted = picked !== null && picked.at === at ? picked.index : (levelFromHash(hash, levels) ?? picked?.index ?? 0);
  const index = Math.min(Math.max(wanted, 0), levels.length - 1);

  const select = (next: number): void => {
    const url = new URL(window.location.href);
    url.hash = levelHash(levels, next);
    window.history.replaceState(window.history.state, '', url);
    moved();
    setPicked({ index: next, at: moves });
  };

  // A new value on each render of the provider, which only renders again
  // when the level or the address changes, and then every reader must too.
  const value: LevelState = { qualities: levels, index, select };
  return <LevelContext value={value}>{children}</LevelContext>;
}

/** The article's selected level, or null where no provider is: a single-level item, stars, variants. */
export function useLevel(): LevelState | null {
  return useContext(LevelContext);
}
