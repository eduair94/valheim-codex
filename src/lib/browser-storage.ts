/**
 * Safe access to the browser's `localStorage`, for everything this app keeps
 * on the reader's device: the chat's preferences (`./chat/storage.ts`) and the
 * values the shared local stores hold (`./local-store.ts`), such as the
 * crafting planner's list.
 *
 * Nothing here may break a page. Storage that is blocked or missing throws on
 * access — Safari's "Block All Cookies", Chrome's "block site data", and an
 * Android WebView with DOM storage off, which exposes `null` — and an unguarded
 * read in a `useState` initializer took the whole connect page down with it.
 * So every access is wrapped, and an unreadable value reads as "nothing
 * saved", which is what it is.
 */

/** The parts of `Storage` used here, so tests can pass a fake. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** The browser's `localStorage`, or null wherever it cannot be reached. */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStored(key: string, storage: StorageLike | null = browserStorage()): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Like `readStored`, but tells "nothing saved" (null) from "storage cannot
 * be read here" (undefined), for a caller that must not take one for the
 * other.
 */
export function readStoredStrict(key: string, storage: StorageLike | null = browserStorage()): string | null | undefined {
  try {
    return storage ? storage.getItem(key) : undefined;
  } catch {
    return undefined;
  }
}

/** Saves a value; false when it could not be saved (the caller carries on regardless). */
export function writeStored(key: string, value: string, storage: StorageLike | null = browserStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Deletes a value; nothing happens where storage cannot be reached. */
export function removeStored(key: string, storage: Pick<Storage, 'removeItem'> | null = browserStorage()): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Blocked storage holds nothing to delete.
  }
}
