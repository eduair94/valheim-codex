import type { Lang, Strings } from './strings';

/*
 * The whole copy table, fetched in the browser only when a page needs a
 * language other than the one the server rendered it in.
 *
 * Every page gets its own language's table from the root layout
 * (`LangProvider`). The chat is the exception: it switches language without a
 * server render. Its switch waits for the other table (`createLangSwitch`),
 * which this fetches once, as a chunk of its own (`import()`), and holds for
 * the life of the page. `useStrings` subscribes to it with
 * `useSyncExternalStore`, so every component that asked for that language
 * re-renders in the same pass when it lands.
 *
 * Only a dynamic `import()` of the table is allowed in browser code; a static
 * import would put it back into the chunk that imports it
 * (`tests/unit/client-copy-guard.test.ts`).
 */

type Tables = Readonly<Record<Lang, Strings>>;

/** What says the browser is back online: the window, or nothing on the server. */
type Network = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export type StringsLoader = {
  /** The table for `lang` once fetched, otherwise null. */
  readonly loaded: (lang: Lang) => Strings | null;
  /**
   * Fetches the table, unless it is here or on its way already. Resolves true
   * once it is here and false when this attempt failed; never rejects.
   */
  readonly load: () => Promise<boolean>;
  /** `listener` runs once, when the table lands. */
  readonly subscribe: (listener: () => void) => () => void;
};

/**
 * A loader for the table that `importTables` fetches.
 *
 * A failed fetch (offline, or a deploy replaced the chunk; the bundler's
 * runtime has retried it once by then) leaves the page in the language it
 * has. The next `load()` tries again, and so does the browser coming back
 * online, so words asked for while offline arrive once they can.
 */
export function createStringsLoader(
  importTables: () => Promise<{ readonly STRINGS: Tables }>,
  network: Network | null,
): StringsLoader {
  let tables: Tables | null = null;
  let loading: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();

  const onOnline = (): void => void load();

  function load(): Promise<boolean> {
    if (tables) return Promise.resolve(true);
    loading ??= importTables().then(
      (module) => {
        tables = module.STRINGS;
        loading = null;
        network?.removeEventListener('online', onOnline);
        for (const listener of listeners) listener();
        return true;
      },
      () => {
        loading = null;
        // Adding the same listener again is a no-op, so however many attempts
        // fail, one retry waits for the network.
        network?.addEventListener('online', onOnline, { once: true });
        return false;
      },
    );
    return loading;
  }

  return {
    loaded: (lang) => (tables ? tables[lang] : null),
    load,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const browserLoader = createStringsLoader(
  () => import('./strings'),
  typeof window === 'undefined' ? null : window,
);

/** The table for `lang` once fetched, otherwise null. */
export const loadedStrings = browserLoader.loaded;

/**
 * Fetches the table, unless it is here or on its way already. Resolves true
 * once it is here and false when this attempt failed; never rejects.
 */
export const loadAllStrings = browserLoader.load;

export const subscribeToLoadedStrings = browserLoader.subscribe;

/** One control's language switch: see `createLangSwitch`. */
export type LangSwitch = {
  /**
   * Switches to `next` by calling `apply(next)`; `own` is the language the
   * server rendered the page in.
   */
  readonly to: (next: Lang, own: Lang, apply: (lang: Lang) => void) => Promise<boolean> | null;
  /** Drops a switch still waiting for its words: it will not happen. */
  readonly cancel: () => void;
};

/**
 * One control's language switch, for a screen that switches language in the
 * browser, without a server render (the chat).
 *
 * It calls `apply(next)` only once `next`'s words are here, so they change in
 * the same render as everything else the switch moves (`<html lang>`, the
 * cookie, dates, the answer language). Without it a switch runs ahead of the
 * words: a reader who switches before the other table arrives, or when it
 * cannot be fetched, gets English dates and Spanish words, and tapping the
 * already pressed button again does nothing.
 *
 * - The page's own language, or the other once fetched: `apply` runs at once,
 *   in the caller's event, and `to` returns null.
 * - Otherwise it fetches the table and returns a promise, for the caller to
 *   show it is busy with: true once it has switched; false when it has not,
 *   because the fetch failed (nothing changed, and the next call tries again,
 *   so the control the reader taps is the retry), a later call superseded
 *   this one, or `cancel` dropped it. Another call for the same language
 *   while one waits gets the same promise, and `apply` runs once.
 */
export function createLangSwitch(loader: Pick<StringsLoader, 'loaded' | 'load'> = browserLoader): LangSwitch {
  let wanted: Lang | null = null;
  let waiting: { readonly lang: Lang; readonly done: Promise<boolean> } | null = null;
  return {
    to(next, own, apply) {
      wanted = next;
      if (next === own || loader.loaded(next)) {
        apply(next);
        return null;
      }
      if (waiting?.lang === next) return waiting.done;
      const done = loader.load().then((ok) => {
        // Dropped by `cancel`, or another wait took its place.
        if (waiting?.done !== done) return false;
        waiting = null;
        if (!ok || wanted !== next) return false;
        apply(next);
        return true;
      });
      waiting = { lang: next, done };
      return done;
    },
    cancel() {
      wanted = null;
      waiting = null;
    },
  };
}
