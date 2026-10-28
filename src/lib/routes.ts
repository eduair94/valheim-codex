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

/**
 * `/wiki/a/iron-sword#level-4`: the article, opened on one upgrade level.
 *
 * A fragment rather than a query parameter: the level switcher reads it in
 * the browser, so the server renders one page per article, and the service
 * worker keeps one copy of it, whatever level a link names. The first level
 * is where the article opens anyway, and anything that is not a level past
 * it gets no fragment.
 */
export function articleLevelHref(slug: string, level: number): Route {
  const href = articleHref(slug);
  return (Number.isInteger(level) && level > 1 ? `${href}#level-${level}` : href) as Route;
}

/**
 * `/wiki/craft`, the planner, or `/wiki/craft?l=…` carrying a list from
 * `encodeShare` (`src/lib/craft/share.ts`).
 *
 * The list is escaped once more for the address. A page reads its query
 * decoded once, and without this the `%2E` and `%7E` that keep a dot or a
 * tilde inside an id would arrive as separators. The ids of a plain list are
 * letters and digits, so its address reads as the list does.
 *
 * `l` is `SHARE_PARAM` in share.ts, written out rather than imported: every
 * page that links anywhere imports this module, and share.ts would bring the
 * planner's store along with it. `tests/unit/routes.test.ts` keeps the two
 * the same.
 */
export function craftHref(share?: string): Route {
  return (share ? `/wiki/craft?l=${encodeURIComponent(share)}` : '/wiki/craft') as Route;
}

export type CategoryQueryParams = {
  biome?: string | undefined;
  station?: string | undefined;
  type?: string | undefined;
  view?: string | undefined;
  tab?: string | undefined;
};

/** The order a category address writes its params in: what is listed, then how. */
const CATEGORY_PARAMS = ['biome', 'station', 'type', 'view', 'tab'] as const;

/**
 * `/wiki/c/Weapons?view=compare&tab=2`. Empty values are omitted.
 *
 * The params are written in one order whatever order they were given in. They
 * used to follow the object's keys, and the page spreads the query it parsed
 * before the change it links to, so a level link read `…&view=compare&tab=2`
 * until it was clicked and `…&tab=2&view=compare` after: one view under two
 * addresses, which the router and the service worker each kept twice.
 */
export function categoryHref(category: string, query: CategoryQueryParams = {}): Route {
  const params = new URLSearchParams();
  for (const key of CATEGORY_PARAMS) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  const path = `/wiki/c/${encodeURIComponent(category)}`;
  return (qs ? `${path}?${qs}` : path) as Route;
}

/**
 * The category segment a facet page uses: `/wiki/c/all?biome=Meadows` lists
 * every category, narrowed by the facet, so the route keeps one shape.
 */
export const ALL_CATEGORIES = 'all';

/**
 * The three ways into the wiki, and therefore where a tile leads.
 *
 * A category is a path segment; a biome or a station is a filter over every
 * category, under the `all` sentinel.
 */
export type BrowseAxis = 'category' | 'biome' | 'station';

/** `/wiki/c/Weapons` for a category, `/wiki/c/all?biome=Meadows` for a facet. */
export function browseHref(axis: BrowseAxis, name: string): Route {
  return axis === 'category' ? categoryHref(name) : categoryHref(ALL_CATEGORIES, { [axis]: name });
}

/**
 * The category a `/wiki/c/[category]` layout or page param names: the param,
 * decoded exactly once.
 *
 * Next hands a layout and a page their dynamic params percent-encoded — it
 * decodes the path to match the route, then encodes the value again before
 * user code sees it (`getDynamicParam` in next/dist/shared/lib/router/utils/
 * get-dynamic-param.js) — while `generateMetadata` gets the matched value
 * itself, already decoded (lib/metadata/resolve-metadata.js), and must use it
 * as it is.
 *
 * The page used to pass its encoded param straight to `categoryHref`, which
 * encodes, so every link built from it gained a second layer
 * (`Stacks%2520%2526%2520Piles`), and the compare toggle of all 34 multi-word
 * categories led to an empty page. This then guessed which form it had been
 * given, decoding whatever looked encoded, and read the metadata param of one
 * of those broken links (`Points%20of%20interest`) as the real category: the
 * page said "not found" under the real category's title and canonical.
 *
 * Never throws: Next only hands over what `encodeURIComponent` produced, so a
 * malformed escape is not expected, and would be returned as it is.
 */
export function categoryFromParam(param: string): string {
  try {
    return decodeURIComponent(param);
  } catch {
    return param;
  }
}

/**
 * What the category in a `/wiki/c/…` address names, decided from the
 * category alone (the query is the page's to read):
 *
 *   - `all`: the facet sentinel, narrowed by the query.
 *   - `category`: one of the wiki's categories.
 *   - `moved`: a category spelled another way, and the name it stands for.
 *     Either an escape encoded twice or more — the List/Compare toggle and
 *     the level tabs of every multi-word category linked to
 *     `Points%2520of%2520interest` until BWR-03, and each click on the broken
 *     page added a layer — or another letter case (`weapons`), when one
 *     category alone matches it.
 *   - `unlisted`: none of the names given; possibly a category newer than
 *     the list, which only the database can say.
 *   - `missing`: a value no name can have (`isPlausibleName`).
 *
 * `name` is the category decoded once (`categoryFromParam`), and `categories`
 * every category some article has.
 */
export type CategorySegment =
  | { kind: 'all' }
  | { kind: 'category' }
  | { kind: 'moved'; name: string }
  | { kind: 'unlisted' }
  | { kind: 'missing' };

/** More layers of encoding than a broken link ever collected in practice. */
const MAX_ENCODINGS = 4;

export function resolveCategorySegment(name: string, categories: ReadonlySet<string>): CategorySegment {
  if (name === ALL_CATEGORIES) return { kind: 'all' };
  if (!isPlausibleName(name)) return { kind: 'missing' };
  if (categories.has(name)) return { kind: 'category' };

  const spellings = [name];
  for (let layer = 0; layer < MAX_ENCODINGS; layer++) {
    const current = spellings[spellings.length - 1] ?? name;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break;
    }
    if (decoded === current) break;
    if (categories.has(decoded)) return { kind: 'moved', name: decoded };
    spellings.push(decoded);
  }

  // Letter case last, and only when it is unambiguous.
  const byCase = new Map<string, string | null>();
  for (const category of categories) {
    const key = category.toLowerCase();
    byCase.set(key, byCase.has(key) ? null : category);
  }
  for (const spelling of spellings) {
    const match = byCase.get(spelling.toLowerCase());
    if (match) return { kind: 'moved', name: match };
  }
  return { kind: 'unlisted' };
}

/** The category page's query, as the page reads it. */
export type CategoryQuery = {
  biome?: string;
  station?: string;
  type?: string;
  /** Only `compare` means anything; any other value is the list. */
  view?: 'compare';
  tab?: string;
};

/** What Next hands a page as `searchParams`. */
type RawQuery = Record<string, string | string[] | undefined>;

/**
 * Longer than any category, biome, station or type the wiki has (the data
 * layer refuses the same length); a longer value names nothing.
 */
const MAX_VALUE = 120;

/**
 * Control characters name nothing either, and NUL is worse than nothing:
 * Postgres refuses it in a text parameter, so `?station=%00` was a server
 * error rather than an empty page.
 */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Whether a value from the URL could be one of the wiki's names. */
export function isPlausibleName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_VALUE && !CONTROL.test(value);
}

/**
 * The category page's search params, normalised: the first value of a
 * repeated parameter (`?biome=a&biome=b`, which arrives as an array and used
 * to reach the queries as one), trimmed, empty ones dropped.
 *
 * `invalid` is set when a value cannot name anything — too long, or with a
 * control character in it — so the page can answer "not found" instead of
 * querying for it.
 */
export function parseCategoryQuery(raw: RawQuery): { query: CategoryQuery; invalid: boolean } {
  const first = (value: string | string[] | undefined): string =>
    (Array.isArray(value) ? value[0] : value)?.trim() ?? '';

  const query: CategoryQuery = {};
  let invalid = false;
  for (const key of ['biome', 'station', 'type', 'tab'] as const) {
    const value = first(raw[key]);
    if (!value) continue;
    if (!isPlausibleName(value)) invalid = true;
    query[key] = value;
  }
  if (first(raw.view) === 'compare') query.view = 'compare';
  return { query, invalid };
}

/** The facet part of a category query: what decides which articles are listed. */
export function facetQuery(query: CategoryQuery): Pick<CategoryQuery, 'biome' | 'station' | 'type'> {
  return {
    ...(query.biome ? { biome: query.biome } : {}),
    ...(query.station ? { station: query.station } : {}),
    ...(query.type ? { type: query.type } : {}),
  };
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
