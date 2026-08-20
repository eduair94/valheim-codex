'use client';

import { useEffect, useState } from 'react';
import { strings, type Lang } from '@/lib/i18n/strings';

/** How often to re-check while the app is open. */
const PROBE_INTERVAL_MS = 20_000;

/**
 * Registers the service worker and says plainly when the server is unreachable.
 *
 * Silence would be worse than a banner: a cached article looks identical to a
 * live one, so without this someone could read a stale page and wonder why the
 * chat button does nothing.
 *
 * Reachability is measured by asking the server, not by reading
 * `navigator.onLine`. That flag reports whether a network interface exists, so
 * a phone on wifi with no internet claims to be online — and Chromium resets it
 * across a navigation even with the network emulated off, which is precisely
 * the case this banner exists for.
 */
export function OfflineBanner({ lang }: { lang: Lang }) {
  const t = strings(lang);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').catch(() => {
        // Registration fails on an insecure origin or with storage blocked.
        // The app works without it; only offline reading is lost.
      });
    }

    let cancelled = false;

    const probe = async (): Promise<void> => {
      try {
        await fetch('/api/health', { method: 'GET', cache: 'no-store' });
        if (!cancelled) setOffline(false);
      } catch {
        if (!cancelled) setOffline(true);
      }
    };

    void probe();
    const timer = setInterval(() => void probe(), PROBE_INTERVAL_MS);
    // The browser's own events are still useful as an immediate trigger; they
    // just are not trusted as the answer.
    window.addEventListener('online', () => void probe());
    window.addEventListener('offline', () => void probe());

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!offline) return null;

  return (
    <p
      role="status"
      className="border-b border-forge/30 bg-forge/10 px-4 py-2 text-center text-[0.78rem] text-forge"
    >
      {t.wikiOffline}
    </p>
  );
}
