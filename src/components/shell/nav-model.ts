/**
 * Where the wiki's navigation goes and which tab says "you are here".
 *
 * Kept out of the component so the rule can be tested without a DOM: it was
 * wrong for long enough (every page under /wiki lit "Buscar", and /wiki/browse
 * lit two tabs at once) that it deserves a test of its own.
 */

export type TabKey = 'search' | 'browse' | 'craft' | 'guide' | 'chat';

/**
 * `page`: the tab's own href is the page on screen.
 * `true`: the reader is inside the tab's section, on a page the tab does not
 * itself link to. ARIA has a value for exactly this, so a screen reader can say
 * "current" without claiming the link points at this very page.
 */
export type TabCurrent = 'page' | 'true';

export const SEARCH_HREF = '/wiki';
export const BROWSE_HREF = '/wiki/browse';
/** The crafting planner, "Taller": `craftHref()` in src/lib/routes.ts, with no list in it. */
export const CRAFT_HREF = '/wiki/craft';
export const GUIDE_HREF = '/wiki/guide';
export const CHAT_HREF = '/';

/**
 * Reading needs no account and asking does, so a signed-out reader's chat tab
 * goes to the sign-in page, which brings them back to the chat afterwards.
 */
export const CHAT_SIGN_IN_HREF = '/login?next=/';

export function chatHref(signedIn: boolean): string {
  return signedIn ? CHAT_HREF : CHAT_SIGN_IN_HREF;
}

/**
 * The tab that marks the current location, and how; `null` when none does.
 *
 * - Search only for the search page itself. Its query lives in `?q=`, so the
 *   pathname stays `/wiki` on a results page and Search stays lit there.
 * - Browse for the browse page, and as the section for every category page:
 *   their breadcrumb leads back to Browse.
 * - Taller for the planner. A shared list arrives in `?l=`, so a share link
 *   is the planner's page too; nothing under it is a page of its own.
 * - Guide for the guide.
 * - Articles mark nothing. An article is reached from every tab: search
 *   results, browse lists, the guide, chat citations and other articles. Any
 *   one tab would be wrong for most visits, and remembering where the reader
 *   came from would need browser-only state the server cannot render, so the
 *   tab would flash from one to another on every load.
 */
export function currentTab(pathname: string): { key: TabKey; current: TabCurrent } | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === SEARCH_HREF) return { key: 'search', current: 'page' };
  if (path === BROWSE_HREF) return { key: 'browse', current: 'page' };
  if (path.startsWith('/wiki/c/')) return { key: 'browse', current: 'true' };
  if (path === CRAFT_HREF) return { key: 'craft', current: 'page' };
  if (path === GUIDE_HREF) return { key: 'guide', current: 'page' };
  if (path === CHAT_HREF) return { key: 'chat', current: 'page' };
  return null;
}

/**
 * The words of a missing page's address, to offer as a search.
 *
 * `/wiki/a/iron-swrd` becomes "iron swrd": what the reader was after, spelled
 * the way they spelled it, one tap from a search that may know better.
 */
export function searchTermsFromPath(pathname: string): string {
  const last = pathname.split('/').filter(Boolean).pop() ?? '';
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // A malformed escape: search for it as written.
  }
  return decoded
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
