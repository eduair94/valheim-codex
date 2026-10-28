'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { usePathname, useSearchParams } from 'next/navigation';
import { Banner } from '@/components/shell/banner';
import {
  classifyProbe,
  MISSED_PAGE_PARAM,
  missedPath,
  nextProbeDelay,
  type Connectivity,
} from '@/components/shell/connectivity';
import { useStrings } from '@/components/shell/lang-context';
import type { Lang } from '@/lib/i18n/strings';

/** A probe that has not answered by then counts as no answer at all. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Says plainly when the server is unreachable.
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
 *
 * Asking costs a round trip to the origin and wakes a phone's radio, so it
 * asks only while the page is visible, when the browser reports a network
 * change, and on a schedule that backs off while all is well and tightens
 * while it is not.
 */
export function OfflineBanner({ lang }: { lang: Lang }) {
  const t = useStrings(lang);
  // Unknown until the first answer: the server cannot know, and guessing
  // "online" would flash the wrong notice on a page the worker served offline.
  const [state, setState] = useState<Connectivity | null>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const missed = pathname === '/wiki' ? missedPath(searchParams.get(MISSED_PAGE_PARAM)) : null;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight: AbortController | null = null;
    let last: Connectivity | null = null;
    let lastDelay: number | null = null;
    let disposed = false;

    const probe = async (): Promise<void> => {
      clearTimeout(timer);
      // Hidden: ask again when the reader comes back, not on a timer nobody sees.
      if (document.visibilityState === 'hidden') return;

      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

      let result: { status: number } | 'failed';
      try {
        const response = await fetch('/api/health', { cache: 'no-store', signal: controller.signal });
        result = { status: response.status };
      } catch {
        result = 'failed';
      } finally {
        clearTimeout(timeout);
      }
      // Superseded by a newer probe, or the banner is gone.
      if (disposed || inflight !== controller) return;
      inflight = null;

      const now = classifyProbe(result);
      const delay = nextProbeDelay(now, last, lastDelay);
      last = now;
      lastDelay = delay;
      setState(now);
      timer = setTimeout(() => void probe(), delay);
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void probe();
      else clearTimeout(timer);
    };
    // The browser's own events are a reason to ask now; they are not the answer.
    const onNetworkChange = (): void => void probe();

    void probe();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onNetworkChange);
    window.addEventListener('offline', onNetworkChange);

    return () => {
      disposed = true;
      clearTimeout(timer);
      inflight?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onNetworkChange);
      window.removeEventListener('offline', onNetworkChange);
    };
  }, []);

  if (state === null) return null;

  /*
   * The worker opened the search page in place of one that was never saved.
   * Say so, rather than the generic "saved copy" notice, which would claim
   * this is the page the reader asked for; and once the network is back,
   * offer the way to it.
   */
  if (missed) {
    if (state === 'online') {
      return (
        <Banner
          tone="note"
          role="status"
          actions={
            <Link
              href={missed as Route}
              className="inline-flex h-8 items-center rounded-md border border-forge/50 px-3 font-mono text-xs text-forge transition-colors hover:bg-forge/15 pointer-coarse:h-11"
            >
              {t.shellOpenMissed}
            </Link>
          }
        >
          {t.shellOnlineAgain}
        </Banner>
      );
    }
    return (
      <Banner tone="alert" role="status">
        {t.shellOfflineMissed}
      </Banner>
    );
  }

  if (state === 'offline') {
    return (
      <Banner tone="alert" role="status">
        {t.wikiOffline}
      </Banner>
    );
  }
  if (state === 'degraded') {
    return (
      <Banner tone="alert" role="status">
        {t.shellDegraded}
      </Banner>
    );
  }
  return null;
}
