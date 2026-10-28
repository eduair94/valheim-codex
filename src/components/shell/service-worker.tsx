'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useServerLang } from '@/components/shell/lang-context';

/**
 * Registers the service worker that keeps read pages available offline, and
 * tells it which page the reader is shown.
 *
 * Its own component rather than a side effect of the offline banner, which
 * sits behind an error boundary that renders nothing on failure: a banner
 * that broke must not also cost the reader offline reading.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    try {
      if (!('serviceWorker' in navigator)) return;
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // Insecure origin or storage blocked: the app works, only offline reading is lost.
      });
    } catch {
      // Some locked-down browsers throw on the property itself.
    }
  }, []);
  // `useSearchParams` would hold a statically rendered route back from the
  // server's HTML without a boundary; there is nothing to show either way.
  return (
    <Suspense fallback={null}>
      <ShownPages />
    </Suspense>
  );
}

/**
 * Tells the worker the address of the page on screen after every change of
 * page in the app, so it keeps that page for offline reading (`keepShown`,
 * public/sw.js). The router's own requests cannot say: a page fetched ahead
 * of a tap (`IntentPrefetch`) is asked for with the very request the tap
 * makes, and a page the router already holds is shown with no request at all.
 *
 * Again after a language switch, which moves no address: the refresh renders
 * the page anew, and the copy the worker holds is in the language the reader
 * left. On a page load it says so too, and the server renders nothing twice
 * for it: the worker has just asked for that page itself, and kept it or
 * noted that there was nothing to keep (a missing page, an error page). One
 * more render comes only for a category page opened in one of its views: the
 * views share one copy, of the list as it first opens (`copyKey`), which the
 * worker then fetches, once an hour at most.
 */
function ShownPages() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const lang = useServerLang();
  useEffect(() => {
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'shown', path: search ? `${pathname}?${search}` : pathname });
    } catch {
      // Some locked-down browsers throw on the property itself.
    }
  }, [pathname, search, lang]);
  return null;
}
