'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useStrings } from '@/components/shell/lang-context';
import { safeNext } from '@/lib/auth/access';
import { connectErrorText, puterButton, puterFollowUps, rememberConnectMethod } from '@/lib/chat/connect';
import { leaveTo } from '@/lib/chat/navigate';
import { connectPuter, isStandaloneDisplay, loadedPuter, loadPuter, type PuterLike } from '@/lib/chat/puter-client';
import type { Lang } from '@/lib/i18n/strings';

type Failure = { code: string; retryAfter?: number };

/** Starts loading the SDK; a failure is reported if the reader clicks, not before. */
function preloadPuter(): void {
  void loadPuter().catch(() => {});
}

function subscribeToDisplayMode(onChange: () => void): () => void {
  const query = window.matchMedia('(display-mode: standalone)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Connecting with the reader's Puter account: one button.
 *
 * Puter signs in through a popup, and browsers only allow a popup opened
 * inside the click that asked for it. The SDK is about 140 KB, too slow to
 * fetch inside the click, so it is loaded as soon as this panel shows, and
 * again on pointer-enter, focus or touch of the button in case that load
 * failed; by the click it is in memory and `signIn()` runs at once.
 *
 * When the popup is blocked or closed the panel says which and offers it
 * again. In an installed app, where the popup is least reliable, it also
 * offers to open the chat in the browser. When Puter hands back an account
 * this site refuses, the same button asks for another one (`puterButton`).
 */
export function PuterPanel({ lang, next }: { lang: Lang; next: string }) {
  const t = useStrings(lang);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // False on the server and while hydrating: only the browser knows how it displays the page.
  const standalone = useSyncExternalStore(subscribeToDisplayMode, isStandaloneDisplay, () => false);

  useEffect(preloadPuter, []);

  const connect = (requestAuth: boolean): void => {
    setPending(true);
    setFailure(null);
    const run = async (puter: PuterLike): Promise<void> => {
      // `connectPuter` calls `signIn()` before anything is awaited: still inside the click.
      const result = await connectPuter(puter, { requestAuth });
      if (!result.ok) {
        setFailure({ code: result.code, retryAfter: result.retryAfter });
        setPending(false);
        return;
      }
      rememberConnectMethod('puter');
      leaveTo(safeNext(next));
    };
    const puter = loadedPuter();
    if (puter) void run(puter);
    else
      loadPuter().then(run, () => {
        setFailure({ code: 'puter_load_failed' });
        setPending(false);
      });
  };

  const followUps = failure ? puterFollowUps(failure.code, standalone) : [];
  const button = puterButton(failure?.code ?? null);
  const buttonLabel =
    button.label === 'other-account'
      ? t.connectPuterOtherAccount
      : button.label === 'retry'
        ? t.connectPuterRetry
        : t.connectPuterButton;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ash">{t.connectPuterIntro}</p>
      <p className="text-xs leading-5 text-ash">{t.connectPuterNote}</p>

      {failure ? (
        <div className="flex flex-col gap-3 rounded-md border border-blood/50 bg-blood/10 px-3 py-2">
          <p role="alert" className="text-sm text-birch">
            {connectErrorText(failure.code, t, failure.retryAfter)}
          </p>
          {followUps.includes('open-browser') ? (
            <div className="flex flex-wrap gap-2">
              {/* A new browsing context, outside the installed app, where popups work. */}
              <a
                href={typeof window === 'undefined' ? '/login' : window.location.href}
                target="_blank"
                rel="noopener"
                className="inline-flex min-h-9 items-center rounded-sm border border-moss px-3 text-xs text-birch transition-colors hover:border-lichen pointer-coarse:min-h-11"
              >
                {t.connectOpenInBrowser}
              </a>
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onPointerEnter={preloadPuter}
        onFocus={preloadPuter}
        onTouchStart={preloadPuter}
        onClick={() => connect(button.requestAuth)}
        disabled={pending}
        className="h-11 rounded-md bg-forge px-4 font-medium text-bog transition-colors hover:bg-forge/90 disabled:cursor-not-allowed disabled:bg-moss disabled:text-ash"
      >
        {pending ? t.connectPuterPending : buttonLabel}
      </button>
    </div>
  );
}
