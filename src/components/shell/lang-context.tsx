'use client';

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Lang, Strings } from '@/lib/i18n/strings';
import {
  createLangSwitch,
  loadAllStrings,
  loadedStrings,
  subscribeToLoadedStrings,
} from '@/lib/i18n/strings-loader';

/**
 * The language the server rendered this request in, and that language's copy
 * table, for client components.
 *
 * The root layout provides both: the language from the `wv_lang` cookie and
 * `strings(lang)`. The table reaches the browser once, in the page's RSC
 * payload. Client components used to import it instead, and every client
 * chunk that did carried all of it, in both languages: three copies of about
 * 38 KB on every page.
 *
 * The language also serves components that cannot be handed it as a prop. An
 * error boundary is the case: Next renders `error.tsx` with only
 * `{ error, retry }`, so without this a Spanish reader's error page would
 * either come out in English or flash from one language to the other.
 *
 * Both are only as fresh as the last server render. The wiki switches
 * language with a refresh, which renders the root layout again, so this
 * follows. The chat switches without a server render: its components keep
 * taking `lang` as a prop, `useStrings(lang)` reads the other table when it is
 * not this one, and `useLangSwitch` holds a switch back until that table is
 * here.
 */
type LangValue = { readonly lang: Lang; readonly strings: Strings };

const LangContext = createContext<LangValue | null>(null);

export function LangProvider({
  lang,
  strings,
  children,
}: {
  lang: Lang;
  /** `strings(lang)`: plain strings and lists, so it serializes. */
  strings: Strings;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ lang, strings }), [lang, strings]);
  return <LangContext value={value}>{children}</LangContext>;
}

function useProvided(): LangValue {
  const value = useContext(LangContext);
  if (!value) {
    throw new Error('No LangProvider above this component. The root layout renders one; a test wraps what it renders in one.');
  }
  return value;
}

/** The language the server rendered this page in. */
export function useServerLang(): Lang {
  return useProvided().lang;
}

const nothingOnServer = (): null => null;

/**
 * The copy table for `lang`, or for the page's own language when omitted.
 *
 * The page's own language is the provider's table, there at once. The other
 * one is fetched the first time a component asks for it; until it lands the
 * provider's table stands in, so no component is ever without words, and when
 * it lands every component that asked for it changes in the same render. The
 * server render and hydration always use the provider's table, so the HTML
 * and the first render in the browser agree.
 *
 * A switch made in the browser should not lean on that stand-in, or its
 * words would trail everything else it moves; `useLangSwitch` waits for the
 * table first. The stand-in is for a component that asks for the other
 * language without a switch, as the chat does when it mounts after another
 * tab changed the language cookie.
 *
 * `preloadOther`: fetch the other language once the page is idle, for a
 * screen that switches language without asking the server (the chat), so the
 * switch is instant.
 *
 * A hook: call it at the top of a component, never in a condition or an event
 * handler. A helper outside a component takes the table as an argument.
 */
export function useStrings(lang?: Lang, { preloadOther = false }: { preloadOther?: boolean } = {}): Strings {
  const provided = useProvided();
  const other = lang !== undefined && lang !== provided.lang ? lang : null;
  const loaded = useSyncExternalStore(
    subscribeToLoadedStrings,
    () => (other ? loadedStrings(other) : null),
    nothingOnServer,
  );

  useEffect(() => {
    if (other) void loadAllStrings();
  }, [other]);

  useEffect(() => {
    if (!preloadOther) return;
    return whenIdle(() => void loadAllStrings());
  }, [preloadOther]);

  return loaded ?? provided.strings;
}

/**
 * For a screen that switches language in the browser, without a server
 * render (the chat): a function that switches to `next` by calling
 * `apply(next)`, but only once `next`'s words are here, so they change in the
 * same render as everything else the switch moves (`<html lang>`, the cookie,
 * the dates, the answer language).
 *
 * For the page's own language, or the other once fetched (`preloadOther`
 * fetches it at idle), `apply` runs at once, in the caller's event, and the
 * function returns null. Otherwise it fetches the other table and returns a
 * promise for the caller to show it is busy with: true once it has switched,
 * false when the fetch failed (nothing changed; the next call tries again) or
 * a later call superseded it. `createLangSwitch` has the details.
 *
 * Show that wait with plain state, not by awaiting the promise in an async
 * transition: React holds every other transition, the router's navigations
 * included, until a pending async one settles, so a reader leaving the chat
 * would wait for the words, and the switch would land on the next page.
 *
 * A switch still waiting when the component goes away (the reader left the
 * chat) is dropped, so it cannot land later on a page rendered in the other
 * language.
 *
 * `apply` may be undefined, for a control that switches some other way.
 */
export function useLangSwitch(apply: ((lang: Lang) => void) | undefined): (next: Lang) => Promise<boolean> | null {
  const own = useProvided().lang;
  const [langSwitch] = useState(() => createLangSwitch());
  useEffect(() => () => langSwitch.cancel(), [langSwitch]);
  return (next) => langSwitch.to(next, own, (lang) => apply?.(lang));
}

/**
 * Runs `task` once the page has loaded and the browser is idle, or a few
 * seconds after load at the latest, so a fetch nobody is waiting for yet does
 * not compete with the page's own. Returns a cancel.
 */
function whenIdle(task: () => void): () => void {
  const w = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  // Idle-callback ids and timer ids are separate number spaces: each is
  // cancelled with its own function.
  let cancel: (() => void) | null = null;
  const schedule = (): void => {
    if (w.requestIdleCallback && w.cancelIdleCallback) {
      const id = w.requestIdleCallback(task, { timeout: 4000 });
      cancel = () => w.cancelIdleCallback?.(id);
    } else {
      const id = window.setTimeout(task, 2000);
      cancel = () => window.clearTimeout(id);
    }
  };
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
  return () => {
    window.removeEventListener('load', schedule);
    cancel?.();
  };
}
