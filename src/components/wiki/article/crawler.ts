import { userAgentFromString } from 'next/server';

/**
 * Agents Next's own list (`userAgent().isBot`) leaves out: automated
 * browsers, page-speed tools, and crawlers that name themselves `…bot/1.0`,
 * `…crawler` or `…spider`. The list matters most for the ones that run a
 * page's scripts, since only those would ask for a translation; Googlebot,
 * Bingbot and Applebot, the ones that do at scale, are on Next's.
 */
const AUTOMATION = /HeadlessChrome|Chrome-Lighthouse|PTST\/|bot\/|crawler|spider/i;

/**
 * Whether a request comes from a crawler or a script rather than a reader.
 *
 * Asked before an untranslated article asks for its own translation, which it
 * does as soon as it is on screen: the allowance for readers without a chat
 * sign-in is shared, thirty translations a day, and a crawler that runs
 * scripts walking the untranslated articles in the default Spanish interface
 * would spend it before a reader got any. A crawler reads the English article
 * and the note that says so, which is what it is.
 *
 * No user agent at all is not a browser.
 */
export function isAutomatedReader(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true;
  return userAgentFromString(userAgent).isBot || AUTOMATION.test(userAgent);
}
