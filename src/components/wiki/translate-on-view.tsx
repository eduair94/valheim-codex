'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useStrings } from '@/components/shell/lang-context';
import type { Lang, Strings } from '@/lib/i18n/strings';
import {
  PENDING_RETRIES,
  PENDING_RETRY_MS,
  readTranslateResponse,
  waitParts,
  type TranslateMode,
  type TranslateOutcome,
} from './article/translate-request';

/**
 * Until when this tab knows the allowance is spent, from the last 429. Kept
 * for the life of the tab, across articles, so a reader browsing ten
 * untranslated pages asks once rather than ten times into a known "no".
 * Read and written only from the request, never while rendering.
 */
let limitedUntil = 0;

/** Seconds still to wait before asking again, or 0. */
function knownWait(): number {
  return Math.max(0, Math.ceil((limitedUntil - Date.now()) / 1000));
}

function rememberWait(seconds: number | null): void {
  limitedUntil = Date.now() + (seconds ?? 60) * 1000;
}

type State =
  /** Waiting for the reader to ask (a stale or unfinished translation). */
  | { kind: 'idle' }
  | { kind: 'working' }
  /** Stored; the page is being refreshed to show it. */
  | { kind: 'ready' }
  /** Still in progress after the last time this page may ask. */
  | { kind: 'queued' }
  | { kind: 'offline' }
  | Exclude<TranslateOutcome, { kind: 'refresh' }>;

/**
 * Asks for this article to be translated, or brought up to date.
 *
 * Rendered only when a request can actually start: the page checked that this
 * reader's allowance is not switched off, that the reader is not a crawler,
 * and that the article has no translation, a stale one, or an unfinished one
 * a request could still finish (PERF-11, BC-22). A visitor for whom the
 * answer is certain to be "no" gets the static note instead and costs the
 * server nothing.
 *
 * An article with no translation is asked for as soon as it is read — the
 * reader is looking at English and wants Spanish — and the page refreshes
 * when it is stored. "Read" means on screen: a tab opened in the background,
 * or a page the browser prerenders, waits until it is shown, so the shared
 * daily allowance is spent on pages someone looks at. A stale or unfinished
 * translation is already readable in Spanish, so updating it waits for the
 * reader to ask: a refresh while they are reading would move the text under
 * their eyes.
 *
 * The refresh can come back with the same page: the server answers from a
 * cache, and a translation stored by another process reaches it only when
 * that cache refills. The reader is then told it is on its way, rather than
 * left with "loading" for good.
 *
 * Every state is said in words in a polite live region: a screen reader hears
 * the progress without having its reading interrupted.
 */
export function TranslateOnView({ slug, lang, mode }: { slug: string; lang: Lang; mode: TranslateMode }) {
  const router = useRouter();
  const t = useStrings(lang);
  const [state, setState] = useState<State>({ kind: mode === 'missing' ? 'working' : 'idle' });
  const [refreshing, startRefresh] = useTransition();
  // Set once a refresh has been asked for. While this component is still
  // here after it settled, the page it brought back still lacks the update.
  const [refreshAsked, setRefreshAsked] = useState(false);
  const retries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const request = async (): Promise<void> => {
    const wait = knownWait();
    if (wait > 0) {
      setState({ kind: 'limited', retryAfter: wait });
      return;
    }
    setState({ kind: 'working' });
    let outcome: TranslateOutcome;
    try {
      const response = await fetch('/api/wiki/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, lang }),
      });
      outcome = await readTranslateResponse(response, mode);
    } catch {
      if (alive.current) setState({ kind: 'offline' });
      return;
    }
    if (!alive.current) return;

    if (outcome.kind === 'refresh') {
      setState({ kind: 'ready' });
      setRefreshAsked(true);
      // The server can now render the translation that is stored.
      startRefresh(() => router.refresh());
      return;
    }

    if (outcome.kind === 'pending') {
      // Not a translation yet: progress, or someone else holds the lease.
      // Asked again a little later, twice at most, and only while in view.
      if (retries.current >= PENDING_RETRIES) {
        setState({ kind: 'queued' });
        return;
      }
      retries.current += 1;
      setState(outcome);
      timer.current = setTimeout(() => {
        if (!alive.current) return;
        if (document.visibilityState === 'visible') void request();
        else setState({ kind: 'queued' });
      }, PENDING_RETRY_MS);
      return;
    }

    if (outcome.kind === 'limited') rememberWait(outcome.retryAfter);
    setState(outcome);
  };

  useEffect(() => {
    alive.current = true;
    if (mode !== 'missing') {
      return () => {
        alive.current = false;
        if (timer.current) clearTimeout(timer.current);
      };
    }
    // Started after the first paint, from a timer, so the effect itself only
    // schedules; a remount in development cancels the first one. A page that
    // is not on screen (a background tab, a prerender) starts once it is.
    let start: ReturnType<typeof setTimeout> | null = null;
    const begin = (): void => {
      if (start || document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', begin);
      start = setTimeout(() => void request(), 0);
    };
    document.addEventListener('visibilitychange', begin);
    begin();
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', begin);
      if (start) clearTimeout(start);
      if (timer.current) clearTimeout(timer.current);
    };
    // `request` reads refs and the props this effect is keyed on; it runs
    // once per article, which is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, lang, mode]);

  // The refresh has come back and this is still on the page: what it brought
  // has no translation yet.
  const settled = state.kind === 'ready' && refreshAsked && !refreshing;
  const busy = !settled && (state.kind === 'working' || state.kind === 'pending' || state.kind === 'ready');

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p role="status" className="text-sm text-ash">
        {busy ? <span aria-hidden="true" className="ember mr-2 align-middle" /> : null}
        {settled ? t.articleTranslationStored : describe(state, t)}
      </p>
      {state.kind === 'idle' ? (
        <button
          type="button"
          onClick={() => void request()}
          className="inline-flex min-h-8 items-center rounded-md border border-moss px-3 text-sm text-birch transition-colors hover:border-forge/50 hover:bg-peat pointer-coarse:min-h-11"
        >
          {mode === 'partial' ? t.articleTranslationComplete : t.articleTranslationUpdate}
        </button>
      ) : null}
    </div>
  );
}

function describe(state: State, t: Strings): string {
  switch (state.kind) {
    case 'idle':
      return '';
    case 'working':
      return t.wikiTranslating;
    case 'ready':
      return t.articleTranslationReady;
    case 'current':
      return t.articleTranslationCurrent;
    case 'pending':
      return state.total > 0
        ? t.articleTranslationProgress.replace('{done}', String(state.translated)).replace('{total}', String(state.total))
        : t.wikiTranslating;
    case 'queued':
      return t.articleTranslationQueued;
    case 'limited': {
      if (state.retryAfter === null) return t.articleTranslationLimitedLater;
      const wait = waitParts(state.retryAfter);
      const amount = (wait.unit === 'minutes' ? t.articleWaitMinutes : t.articleWaitHours).replace('{n}', String(wait.n));
      return t.articleTranslationLimited.replace('{wait}', amount);
    }
    case 'disabled':
      return t.articleTranslationDisabled;
    case 'failed':
      return t.articleTranslationFailed;
    case 'offline':
      return t.articleTranslationOffline;
  }
}
