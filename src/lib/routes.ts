import type { Route } from 'next';

/**
 * Hrefs for the dynamic routes.
 *
 * `Link` does not substitute dynamic segments from an object href in the App
 * Router: `{ pathname: '/wiki/a/[slug]', query: { slug } }` renders literally
 * as `/wiki/a/[slug]?slug=iron-sword` and 404s. Paths are therefore built as
 * strings, in one place.
 *
 * The type assertion is sound because every segment is percent-encoded first,
 * which removes the `/` and `?` that make a segment unsafe. TypeScript cannot
 * prove that about a value only known at runtime, so it is asserted once here
 * rather than at every call site.
 */

/** `/wiki/a/iron-sword` */
export function articleHref(slug: string): Route {
  return `/wiki/a/${encodeURIComponent(slug)}` as Route;
}

export type CategoryQueryParams = {
  biome?: string | undefined;
  station?: string | undefined;
  type?: string | undefined;
  view?: string | undefined;
  tab?: string | undefined;
};

/** `/wiki/c/Weapons?view=compare&tab=2`. Empty values are omitted. */
export function categoryHref(category: string, query: CategoryQueryParams = {}): Route {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  const path = `/wiki/c/${encodeURIComponent(category)}`;
  return (qs ? `${path}?${qs}` : path) as Route;
}

/**
 * Where a citation should lead.
 *
 * The in-app article when the page has a reading document — it opens instantly,
 * works offline, and keeps the reader inside the app. The original wiki
 * otherwise, so a citation is never a dead end.
 *
 * Extracted from the components because it is the decision worth testing, and
 * a pure function can be tested without a DOM or a model call.
 */
export function citationHref(citation: { slug?: string | null; url: string }): {
  href: string;
  internal: boolean;
} {
  return citation.slug
    ? { href: articleHref(citation.slug), internal: true }
    : { href: citation.url, internal: false };
}

/** `/?about=Iron+Sword`, used by "Ask about this". */
export function chatAboutHref(title: string): Route {
  return `/?about=${encodeURIComponent(title)}` as Route;
}
