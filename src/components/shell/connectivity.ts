/**
 * How the offline banner decides what to say, and when to ask again.
 *
 * Pure functions, so the schedule can be tested without timers or a network.
 */

/**
 * - `online`: the server answered.
 * - `degraded`: something answered, but with a 5xx. Behind Cloudflare that is
 *   the 502/521 page served while the origin is down: the device is online,
 *   the app is not, and "you are offline" would send the reader to check a
 *   connection that is fine.
 * - `offline`: nothing answered at all.
 */
export type Connectivity = 'online' | 'degraded' | 'offline';

export function classifyProbe(result: { status: number } | 'failed'): Connectivity {
  if (result === 'failed') return 'offline';
  return result.status >= 500 ? 'degraded' : 'online';
}

/** First wait after a healthy answer, and the ceiling it backs off to. */
export const HEALTHY_DELAY_MS = 60_000;
export const HEALTHY_MAX_DELAY_MS = 5 * 60_000;
/** First wait after a failure, and its ceiling: recovery should show quickly. */
export const FAILING_DELAY_MS = 10_000;
export const FAILING_MAX_DELAY_MS = 60_000;

/**
 * How long to wait before the next probe.
 *
 * A healthy connection is asked less and less often: every probe is an
 * uncached round trip to the origin, and a phone's radio wakes for each one.
 * A failing one is asked often, so the banner clears soon after the network
 * returns. A change of state starts that state's schedule from the beginning.
 */
export function nextProbeDelay(now: Connectivity, previous: Connectivity | null, previousDelay: number | null): number {
  const healthy = now === 'online';
  const [first, max] = healthy ? [HEALTHY_DELAY_MS, HEALTHY_MAX_DELAY_MS] : [FAILING_DELAY_MS, FAILING_MAX_DELAY_MS];
  const sameState = previous !== null && (previous === 'online') === healthy;
  if (!sameState || previousDelay === null) return first;
  return Math.min(previousDelay * 2, max);
}

/** The query parameter the service worker names an unsaved page with (see `public/sw.js`). */
export const MISSED_PAGE_PARAM = 'offline';

/**
 * The same-site path a fallback page was opened in place of, or `null`.
 *
 * The service worker sends a reader who opens an unsaved page offline to
 * `/wiki?offline=<path>`. The value comes from the address bar, so anyone can
 * write one and send the link: anything that is not a plain path on this site
 * is ignored rather than linked to. Resolved against a placeholder origin so
 * the check is the same on the server and in the browser.
 *
 * The result is checked as well as the input, the way `safeNext` checks a
 * sign-in redirect: resolving collapses dot segments, so `/.//evil.example`
 * and `/a/..//evil.example` come out as `//evil.example`, which a link reads
 * as another host. The banner would then be a trusted-looking way off the site.
 */
export function missedPath(value: string | null): string | null {
  if (!value || !value.startsWith('/')) return null;
  const base = 'https://same-site.invalid';
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.origin !== base) return null;
  const out = url.pathname + url.search;
  return out.startsWith('//') || out.startsWith('/\\') ? null : out;
}
