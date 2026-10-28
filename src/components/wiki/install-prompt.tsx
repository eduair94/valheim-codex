'use client';

import { useState, useSyncExternalStore } from 'react';
import { Banner } from '@/components/shell/banner';
import {
  INSTALL_CHANGE_EVENT,
  readInstallDismissed,
  rememberInstallDismissed,
  type BeforeInstallPromptEvent,
} from '@/components/shell/install-capture';
import { useStrings } from '@/components/shell/lang-context';
import type { Lang } from '@/lib/i18n/strings';

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari's own flag, predating the standard media query.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;
  // iPadOS asks for desktop sites, so its Safari sends a Mac user agent. A Mac
  // has no touch screen and an iPad does, which is the only tell left.
  const ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
}

function subscribeToOffer(onChange: () => void): () => void {
  window.addEventListener(INSTALL_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(INSTALL_CHANGE_EVENT, onChange);
}
const currentOffer = (): BeforeInstallPromptEvent | null => window.__wvInstallPrompt ?? null;
const noOfferOnServer = (): null => null;

const neverChanges = (): (() => void) => () => {};
const wantsIosHint = (): boolean => isIosSafari() && !isStandalone() && !readInstallDismissed();
const noHintOnServer = (): boolean => false;

/**
 * The one control that actually gets this app installed.
 *
 * Chrome/Edge/Android hand over a real `beforeinstallprompt` event this
 * component can trigger from a button tap. The root layout catches it while
 * the page is still loading (see `install-capture.ts`), because on a repeat
 * visit it can fire before React is listening. iOS Safari never fires that
 * event — there is no programmatic install on iOS — so it gets instructions
 * instead of a button that would silently do nothing.
 *
 * Dismissal is remembered per browser, not per session: someone who closed
 * this once already made their choice, and a wiki they open mid-game is the
 * last place that should nag them again for it.
 *
 * Both sources are read with `useSyncExternalStore`, whose server value is
 * "nothing to show", so hydration matches and the banner simply appears once
 * the browser has something to offer.
 */
export function InstallPrompt({ lang }: { lang: Lang }) {
  const t = useStrings(lang);
  const offer = useSyncExternalStore(subscribeToOffer, currentOffer, noOfferOnServer);
  const iosHint = useSyncExternalStore(neverChanges, wantsIosHint, noHintOnServer);
  const [closed, setClosed] = useState(false);

  /** An offer can be used once; whatever happens next, this one is gone. */
  const spendOffer = (): void => {
    window.__wvInstallPrompt = null;
    window.dispatchEvent(new Event(INSTALL_CHANGE_EVENT));
  };

  const dismiss = (): void => {
    rememberInstallDismissed();
    setClosed(true);
    spendOffer();
  };

  const install = async (): Promise<void> => {
    if (!offer) return;
    try {
      await offer.prompt();
      const { outcome } = await offer.userChoice;
      if (outcome === 'accepted') rememberInstallDismissed();
    } catch {
      // Already used, or withdrawn by the browser: there is nothing left to offer.
    }
    spendOffer();
  };

  if (closed || (!offer && !iosHint)) return null;

  return (
    <Banner
      tone="note"
      actions={
        <>
          {offer ? (
            <button
              type="button"
              onClick={() => void install()}
              className="inline-flex h-8 items-center rounded-md border border-forge/50 px-3 font-mono text-xs text-forge transition-colors hover:bg-forge/15 pointer-coarse:h-11"
            >
              {t.installAction}
            </button>
          ) : null}
          <button
            type="button"
            onClick={dismiss}
            aria-label={t.installDismiss}
            className="inline-flex size-8 items-center justify-center rounded-md text-ash transition-colors hover:bg-moss hover:text-birch pointer-coarse:size-11"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </>
      }
    >
      {offer ? t.installBanner : t.installIosBanner}
    </Banner>
  );
}
