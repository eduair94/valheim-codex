// The hook reads React through its namespace, never as a named import. Next
// refuses a module that imports `useSyncExternalStore` by name anywhere a
// Server Component can reach it ("This API is only available in Client
// Components"), and this module is reached from code the server may import:
// the planner's pure state functions and its share links sit beside the
// store they feed. Only the hook needs React, and it only runs in a Client
// Component.
import * as React from 'react';
import { browserStorage, readStoredStrict, removeStored, writeStored } from './browser-storage';

/**
 * One value kept on the reader's device under one `localStorage` key, shared
 * by every component that shows it and every tab that has it open, such as
 * the crafting planner's list (`wv-craft-v1`, `./craft/planner-store.ts`).
 *
 * Components read it with `useLocalStore`, which is `useSyncExternalStore`
 * over the store. React asks for the value on every render and compares it
 * by reference, so `read()` parses the stored string only when it changed and
 * hands back the same object otherwise; a fresh parse each time would
 * re-render forever.
 *
 * A write tells this tab's listeners at once. Other tabs hear the browser's
 * `storage` event, which a tab never receives for its own writes. Change a
 * value with `update`, never by writing one a render saw: `update` reads the
 * value at the moment of the change, so a list another tab saved in the
 * meantime is built on, not overwritten.
 *
 * Every access is wrapped (`./browser-storage.ts`). Where a value cannot be
 * saved — storage blocked (site data off, a WebView without it, the server)
 * or full — the store keeps it in memory for the life of the page and shows
 * it, so the planner still works there, and `writable()` says the page is
 * not saving, for the interface to tell the reader. A browser that blocks
 * storage and one that is full read the same: what the page shows is lost
 * when it closes.
 *
 * `read()` and `writable()` answer for the browser, and the server has no
 * storage: render code reads them through `useLocalStore` and
 * `useLocalWritable`, which answer null until the page has hydrated.
 */

/** How a value is stored: as a string, and back. */
export type LocalCodec<T> = {
  /**
   * The value a stored string holds; null when nothing is stored. Never
   * throws: whatever another build or a hand edit left there reads as
   * something, at worst as nothing saved.
   */
  parse(raw: string | null): T;
  serialize(value: T): string;
};

export type LocalStore<T> = {
  readonly key: string;
  /**
   * The parsed value; the same reference until the stored string changes.
   * parse(null) where storage is missing or blocked; what a write could not
   * save, once one could not. Render code reads it through `useLocalStore`.
   */
  read(): T;
  /**
   * Saves; false when it could not be saved, and the page then keeps the
   * value for its life. Notifies this tab's listeners at once either way;
   * other tabs hear the `storage` event of a save.
   */
  write(next: T): boolean;
  /** read() → change → write(); returns write's result. */
  update(change: (current: T) => T): boolean;
  subscribe(listener: () => void): () => void;
  /**
   * Whether this page saves: false where storage is blocked or missing, and
   * after a write that did not fit until one does. For the "not saved" note,
   * which render code reads through `useLocalWritable`: the server always
   * answers false.
   */
  writable(): boolean;
};

/** Where a store keeps its value and hears other tabs: the browser, or a test's stand-in. */
export type LocalHost = {
  /** The storage to use, or null where none can be reached. Asked at every access, never kept. */
  storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** What other tabs' `storage` events arrive at: the window, or null on the server. */
  events(): Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
};

const BROWSER: LocalHost = {
  storage: browserStorage,
  events: () => (typeof window === 'undefined' ? null : window),
};

/** A key no store uses: written and removed once, to learn whether anything can be saved here. */
const PROBE_KEY = 'wv-probe';

export function createLocalStore<T>(key: string, codec: LocalCodec<T>, host: LocalHost = BROWSER): LocalStore<T> {
  // The last string read from storage and its value, which `read` hands out
  // again for as long as the string stays the same.
  let cached: { raw: string | null; value: T } | null = null;
  // What the last write could not save, which the page shows until a write
  // saves or another tab's save replaces it.
  let unsaved: { value: T } | null = null;
  // Whether a write can succeed here: unknown until asked, then what the
  // last write found.
  let canWrite: boolean | null = null;

  const listeners = new Set<() => void>();
  // The window the `storage` handler is attached to, while anything listens.
  let heard: ReturnType<LocalHost['events']> = null;

  // The listeners subscribed when the change happened, even if one of them
  // subscribes or unsubscribes another on the way.
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const onStorage = (event: Event): void => {
    // A null key is another tab clearing the whole storage, this key with it.
    const changed = (event as StorageEvent).key;
    if (changed !== null && changed !== key) return;
    // Another tab saved where this page could not: what is saved wins, as
    // everywhere in this store, so the other tab's list shows up here too.
    if (readStoredStrict(key, host.storage()) !== undefined) unsaved = null;
    notify();
  };

  const parsed = (raw: string | null): T => {
    if (cached === null || cached.raw !== raw) cached = { raw, value: codec.parse(raw) };
    return cached.value;
  };

  function read(): T {
    if (unsaved) return unsaved.value;
    // Storage that cannot be read holds nothing saved, one value like any other.
    return parsed(readStoredStrict(key, host.storage()) ?? null);
  }

  function write(next: T): boolean {
    const raw = codec.serialize(next);
    const storage = host.storage();
    // Saved means it can be read back, too.
    canWrite = readStoredStrict(key, storage) !== undefined && writeStored(key, raw, storage);
    if (canWrite) {
      unsaved = null;
      parsed(raw);
    } else {
      // Blocked or full: nothing here outlives the page, but the page keeps
      // working, holding the value as storage would have, read back through
      // the codec. `writable` keeps saying so until a write saves: a short
      // probe would still fit where the list did not.
      unsaved = { value: codec.parse(raw) };
    }
    notify();
    return canWrite;
  }

  function subscribe(listener: () => void): () => void {
    const first = listeners.size === 0;
    listeners.add(listener);
    if (first) {
      heard = host.events();
      heard?.addEventListener('storage', onStorage);
    }
    return () => {
      if (!listeners.delete(listener) || listeners.size > 0) return;
      heard?.removeEventListener('storage', onStorage);
      heard = null;
    };
  }

  function writable(): boolean {
    if (canWrite === null) {
      const storage = host.storage();
      canWrite = readStoredStrict(key, storage) !== undefined && writeStored(PROBE_KEY, '1', storage);
      if (canWrite) removeStored(PROBE_KEY, storage);
    }
    return canWrite;
  }

  return { key, read, write, update: (change) => write(change(read())), subscribe, writable };
}

/** The server has no stored value, and the browser's first render must agree with it. */
const nothingOnTheServer = (): null => null;

/** null on the server and while hydrating (both renders agree), then the stored value; re-renders on writes in this tab and others. */
export function useLocalStore<T>(store: LocalStore<T>): T | null {
  return React.useSyncExternalStore<T | null>(store.subscribe, store.read, nothingOnTheServer);
}

/**
 * Whether the store saves on this device, for the note that says so: null
 * on the server and while hydrating, then `writable()`, again after every
 * write. A note rendered from `writable()` itself would say "not saved" on
 * the server, which has no storage, and "saved" in the browser: a hydration
 * mismatch on every load.
 */
export function useLocalWritable<T>(store: LocalStore<T>): boolean | null {
  return React.useSyncExternalStore<boolean | null>(store.subscribe, store.writable, nothingOnTheServer);
}
