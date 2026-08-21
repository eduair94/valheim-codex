'use client';

import { useEffect, useState } from 'react';
import { strings, type Lang } from '@/lib/i18n/strings';

const DISMISSED_KEY = 'wv-install-dismissed';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari's own flag, predating the standard media query.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
}

/**
 * The one control that actually gets this app installed.
 *
 * Chrome/Edge/Android hand over a real `beforeinstallprompt` event this
 * component can trigger from a button tap. iOS Safari never fires that
 * event — there is no programmatic install on iOS — so it gets instructions
 * instead of a button that would silently do nothing.
 *
 * Dismissal is remembered per browser, not per session: someone who closed
 * this once already made their choice, and a wiki they open mid-game is the
 * last place that should nag them again for it.
 */
export function InstallPrompt({ lang }: { lang: Lang }) {
  const t = strings(lang);
  // Both start at their hidden value, matching what a server render (no
  // `window`) would show, so there is nothing for the client to correct
  // after hydration except turning one of them on.
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIos, setShowIos] = useState(false);

  useEffect(() => {
    if (isStandalone() || localStorage.getItem(DISMISSED_KEY) === '1') return;

    if (isIosSafari()) {
      // Whether Safari is running as an installed PWA is knowable only on
      // the client — there is no server-renderable equivalent of this check
      // to run instead, unlike a subscription an effect would normally exist
      // to set up.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowIos(true);
      return;
    }

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    setDeferred(null);
    setShowIos(false);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    // Accepted or not, the prompt is spent — Chrome only fires it once per
    // deferred event — so either way this is the last we see of it.
    setDeferred(null);
    if (outcome === 'accepted') dismiss();
  };

  if (!deferred && !showIos) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-forge/30 bg-forge/10 px-4 py-2.5 text-[0.8rem] text-birch"
    >
      <span className="flex-1">{showIos ? t.installIosBanner : t.installBanner}</span>
      {deferred ? (
        <button
          type="button"
          onClick={() => void install()}
          className="shrink-0 rounded-sm border border-forge/50 px-2.5 py-1 font-mono text-[0.7rem] text-forge transition-colors hover:bg-forge/20"
        >
          {t.installAction}
        </button>
      ) : null}
      <button
        type="button"
        onClick={dismiss}
        aria-label={t.installDismiss}
        className="shrink-0 text-ash transition-colors hover:text-birch"
      >
        ✕
      </button>
    </div>
  );
}
