'use client';

import { useEffect, useOptimistic, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLangSwitch, useStrings } from '@/components/shell/lang-context';
import { linkNavigation } from '@/components/shell/nav-pending';
import { readLangCookie, setLangCookie } from '@/lib/i18n/lang-cookie';
import type { Lang } from '@/lib/i18n/strings';

const LANGS = ['es', 'en'] as const;

/**
 * The language not in use, below 640px, as a button of its own: as tall as a
 * tab and as wide, and framed like the pair it stands for.
 */
const COMPACT_BUTTON = 'max-sm:size-11 max-sm:rounded-md max-sm:border max-sm:border-moss';

/**
 * The two-letter language switch, shared by the chat and the reader.
 *
 * It lived only in the chat sidebar, which a signed-out visitor never sees —
 * so the public half of the site, the half most likely to be read by someone
 * who wanted Spanish, had no way to ask for it.
 *
 * Writes the cookie and refreshes rather than holding the choice in React
 * state: the server renders the language, including which stored translation
 * to serve, so the server has to be told before anything can change. The
 * pressed button moves at once and stays there while the refresh is in
 * flight, so a slow connection does not look like an ignored tap. The chat's
 * switch, made without the server, does the same while it waits for the new
 * language's words.
 */
export function LangToggle({
  lang,
  onChange,
  compact = false,
  className = '',
}: {
  lang: Lang;
  /**
   * The chat manages its own state; the reader lets the cookie and a refresh
   * do it. Called only once the chosen language's words are here
   * (`useLangSwitch`), so everything the chat shows changes together.
   */
  onChange?: (lang: Lang) => void;
  /**
   * Below 640px, one 44px button naming the language not in use; the pair
   * from there up. For the wiki's tab bar, where a 360px phone fits five tabs
   * of about 61px beside one button but not beside the pair.
   *
   * The same two buttons either way, one per language, restyled by CSS: the
   * pressed one is hidden on a phone and the other stands alone. So the
   * server's HTML and the browser's first render agree at every width, and a
   * language's button is one element whatever the width, for a test or a
   * script that finds it by its `lang`.
   */
  compact?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(lang);
  const t = useStrings(lang);
  /** Set when the reader starts leaving the page while the chat's switch waits, which calls it off. */
  const leaving = useRef(false);
  /** The compact button a switch is about to hide while it has focus (see the effect below). */
  const handOff = useRef<HTMLButtonElement | null>(null);
  const switchLang = useLangSwitch(
    onChange &&
      ((next) => {
        if (!leaving.current) onChange(next);
      }),
  );
  /** The language the chat's switch is waiting to show, while its words are on their way. */
  const [choosing, setChoosing] = useState<Lang | null>(null);

  /*
   * Leaving the page calls off a switch still waiting for its words. The
   * next page is asked for with the cookie as it is when the reader leaves,
   * so a switch landing on the way out put the new language's `<html lang>`
   * and cookie over a page the server had rendered in the old one. (Once the
   * page has gone, `useLangSwitch` drops a waiting switch by itself.)
   */
  useEffect(() => {
    if (!choosing) return;
    return listenForLeaving(() => {
      leaving.current = true;
      setChoosing(null);
    });
  }, [choosing]);

  /*
   * On a phone the compact switch shows one button, and choosing its language
   * hides it: the other language's button takes its place. A keyboard or a
   * screen reader on it would be left on nothing, so focus moves to the
   * button now shown. From 640px both stay on screen and focus stays put.
   */
  useEffect(() => {
    const pressed = handOff.current;
    handOff.current = null;
    if (!pressed || pressed.getClientRects().length > 0) return;
    const instead = Array.from(pressed.parentElement?.children ?? []).find(
      (element) => element !== pressed && element.getClientRects().length > 0,
    );
    if (instead instanceof HTMLButtonElement) instead.focus();
  }, [shown]);

  const choose = (code: Lang, button: HTMLButtonElement): void => {
    if (onChange) {
      if (code === (choosing ?? lang)) return;
      /*
       * The chat switches without asking the server, so only once the new
       * language's words are here; otherwise `<html lang>`, the dates and the
       * answers would move while the words stayed behind. They usually are
       * (the chat fetches them while idle) and the switch is instant. If not,
       * the button moves and the group shows it is busy until they arrive, as
       * on the refresh below. A tap on the other button calls it off, and if
       * the words cannot be fetched nothing changes and the next tap tries
       * again.
       *
       * Plain state, not a transition: React holds every other transition,
       * the router's navigations included, until a pending async one
       * settles, so leaving the chat would have waited for the words.
       */
      leaving.current = false;
      const waiting = switchLang(code);
      setChoosing(waiting ? code : null);
      void waiting?.then(() => setChoosing((current) => (current === code ? null : current)));
      return;
    }
    /*
     * Checked against the cookie as well as the prop. If a refresh ever comes
     * back in the old language (a cached page once did exactly that), the
     * prop is stale and the button that looks selected has to work too:
     * returning early on it left the cookie and the page disagreeing until a
     * second, apparently pointless, tap.
     */
    if (code === lang && readLangCookie() === code) return;
    if (compact && document.activeElement === button) handOff.current = button;
    startTransition(() => {
      setShown(code);
      setLangCookie(code);
      router.refresh();
    });
  };

  /*
   * A hairline of the group shows between the two segments, so a ring on one
   * never runs into the other's fill. Rings are drawn inside each segment;
   * on the forge-filled one it is birch, since amber vanishes into the fill
   * and bog into the dark around the segment, right where an inset ring's
   * outer edge falls (as in `SegmentedLinks`).
   *
   * Compact, below 640px the group drops its frame and the button left on
   * screen draws its own, so the control is exactly one 44px square.
   */
  return (
    <div
      role="group"
      aria-label={t.language}
      data-pending={pending || choosing ? '' : undefined}
      className={`inline-flex shrink-0 gap-0.5 rounded-md border border-moss p-0.5 transition-opacity data-pending:opacity-70 ${
        compact ? 'max-sm:border-0 max-sm:p-0' : ''
      } ${className}`}
    >
      {LANGS.map((code) => {
        const on = (choosing ?? shown) === code;
        return (
          <button
            key={code}
            type="button"
            lang={code}
            onClick={(event) => choose(code, event.currentTarget)}
            aria-pressed={on}
            aria-label={code === 'es' ? t.shellLanguageEs : t.shellLanguageEn}
            className={`focus-inset inline-flex h-7 min-w-9 items-center justify-center rounded-sm px-2 font-mono text-xs uppercase transition-colors pointer-coarse:h-11 pointer-coarse:min-w-11 ${
              on ? 'bg-forge text-bog [--focus-ring:var(--color-birch)]' : 'text-ash hover:bg-moss hover:text-birch'
            } ${compact ? (on ? 'max-sm:hidden' : COMPACT_BUTTON) : ''}`}
          >
            {code}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Calls `leave` when the reader starts leaving the page: a tap on a link to
 * another page, by the rule the progress bar follows (`linkNavigation`), seen
 * in the capture phase, before the link's own handler starts the change; or
 * Back or Forward onto an entry the router restores or loads again. A jump to
 * a fragment comes with no state, and Next leaves the page as it is. Returns
 * the way to stop listening.
 */
export function listenForLeaving(leave: () => void): () => void {
  const onClick = (event: MouseEvent): void => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement)) return;
    const facts = { href: link.href, target: link.target, download: link.hasAttribute('download') };
    if (linkNavigation(event, facts, window.location.href)) leave();
  };
  const onPopState = (event: PopStateEvent): void => {
    if (event.state !== null && event.state !== undefined) leave();
  };
  window.addEventListener('click', onClick, true);
  window.addEventListener('popstate', onPopState);
  return () => {
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('popstate', onPopState);
  };
}
