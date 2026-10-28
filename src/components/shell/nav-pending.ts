/**
 * Which taps start a page change worth showing, and what the address bar
 * then says about it.
 *
 * Pure, so the rules can be tested without a DOM: the tracker
 * (`nav-tracker.ts`) reads the event, the link or form and the address bar,
 * and asks these.
 */

/** A page change under way: where it started and where it is headed. */
export type PendingNavigation = {
  /** The path on screen when it started. */
  fromPath: string;
  /** The path and query on screen when it started. */
  fromUrl: string;
  /** The path and query it goes to. */
  to: string;
};

/** How a click was made. Only a plain one is followed in this tab. */
export type Activation = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** What a link says about where it goes. */
export type LinkFacts = {
  /** The resolved address: `HTMLAnchorElement.href`. */
  href: string;
  /** The `target` attribute, `''` when there is none. */
  target: string;
  download: boolean;
};

/**
 * What a form says about where it goes; the submitting button's `formaction`,
 * `formmethod` and `formtarget` already in place of the form's own. `null`
 * where the attribute is absent.
 */
export type FormFacts = {
  action: string | null;
  method: string | null;
  target: string | null;
};

/** The address bar, or the part of it these rules read. */
type Place = { pathname: string; search: string };

/**
 * The page an address names: its path and query. Its fragment is a place on
 * that page: a link to `#plains` is a jump within the page, and a link to the
 * same page without one fetches it again where it stands.
 */
const pageOf = (place: Place): string => place.pathname + place.search;

/** `here` (an absolute address) and where `href` leads from it, when that is another http(s) address of this site. */
function resolve(href: string, here: string): { from: URL; to: URL } | null {
  let from: URL;
  let to: URL;
  try {
    from = new URL(here);
    to = new URL(href, from);
  } catch {
    return null;
  }
  if (to.origin !== from.origin || (to.protocol !== 'http:' && to.protocol !== 'https:')) return null;
  return { from, to };
}

/**
 * Where following `href` from `here` (an absolute address) leads, or `null`
 * when it leaves no page behind in this tab: another site or scheme, the page
 * on screen, or a fragment of it.
 */
export function navigationTo(href: string, here: string): PendingNavigation | null {
  const address = resolve(href, here);
  if (!address) return null;
  const fromUrl = pageOf(address.from);
  const to = pageOf(address.to);
  return to === fromUrl ? null : { fromPath: address.from.pathname, fromUrl, to };
}

/**
 * Whether the browser follows a click on this link in this tab: a plain
 * primary click (or Enter, which clicks). With a modifier it opens a tab, a
 * window or a download instead, and so does a link with another `target` or
 * a `download` attribute. Next's `<Link>` leaves all of those to the browser
 * too.
 */
function followedHere(click: Activation, link: LinkFacts): boolean {
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (link.download) return false;
  return link.target === '' || link.target.toLowerCase() === '_self';
}

/** The page change a click on a link starts, or `null`. */
export function linkNavigation(click: Activation, link: LinkFacts, here: string): PendingNavigation | null {
  return followedHere(click, link) ? navigationTo(link.href, here) : null;
}

/**
 * Whether a click follows a link to the page on screen, or to a fragment of
 * it: no page change of its own, but not always nothing. Next's `<Link>`
 * navigates even then, and its navigation drops any other still on its way;
 * a plain fragment link is the browser's own jump, and drops nothing. The
 * tracker tells the two apart once the click is over, by whether its default
 * was prevented (`<Link>` prevents it; nothing else on this site does, for a
 * link).
 */
export function linkToPageOnScreen(click: Activation, link: LinkFacts, here: string): boolean {
  if (!followedHere(click, link)) return false;
  const address = resolve(link.href, here);
  return address !== null && pageOf(address.to) === pageOf(address.from);
}

/**
 * The page change submitting a form starts, or `null`.
 *
 * Only a form that names where it goes: a GET with an `action`, which is what
 * `next/form` renders (the nav's search and the not-found page's). Its fields
 * replace the action's query, as a browser's own submission does. A form
 * without an action is the page's own business (a question, a sign-in), and
 * whatever it does next is not a page change this can see.
 *
 * `fields` is only read once the form qualifies.
 */
export function formNavigation(
  form: FormFacts,
  fields: () => Iterable<readonly [string, string]>,
  here: string,
): PendingNavigation | null {
  if (form.action === null) return null;
  if ((form.method || 'get').toLowerCase() !== 'get') return null;
  if (form.target && form.target.toLowerCase() !== '_self') return null;
  let to: URL;
  try {
    to = new URL(form.action, here);
  } catch {
    return null;
  }
  const query = new URLSearchParams();
  for (const [name, value] of fields()) query.append(name, value);
  to.search = query.toString();
  return navigationTo(to.href, here);
}

/**
 * What the address bar says about a change on its way, read whenever the
 * router's address moves:
 *
 * - `landed`: the reader is on another page, wherever a redirect took them,
 *   or, for a change of query alone, on the very address it went to.
 * - `dropped`: the address moved to another query under the same path while
 *   the change was on its way. That is a page writing its own address with
 *   no state (`history.replaceState(null, …)`): Next takes the write in as a
 *   restore, and a restore drops any navigation still on its way, so the
 *   tapped page never comes. The search page writes what is typed (`?q=`)
 *   that way, but not once it is leaving for another page, which a tap on a
 *   link to one, or Enter in its field, sets: its writes then pass the router
 *   by, and drop nothing. (A redirect to another query of the same path would
 *   read as dropped too, and the bar would just go, without its finish. This
 *   site has none.)
 * - `waiting`: still on the address the tap was made from. An address the
 *   tapping click wrote itself, before the link's own handler (the search
 *   page does, with the router's own history state), is not seen here: the
 *   router never takes it in.
 */
export type Outcome = 'landed' | 'dropped' | 'waiting';

export function outcome(pending: PendingNavigation, now: Place): Outcome {
  const page = pageOf(now);
  if (now.pathname !== pending.fromPath || page === pending.to) return 'landed';
  return page === pending.fromUrl ? 'waiting' : 'dropped';
}
