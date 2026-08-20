# Wiki browser — design

**Date:** 2026-08-20
**Status:** implemented

A mobile-first reader for the same Valheim index the chat already searches.
Fandom is hard to consult on a phone; this replaces that use, in the same app,
behind the same password.

---

## 1. What the user asked for

All four of: find the article fast, read it comfortably on a phone, browse what
exists, and compare items. Plus installable with offline reading of visited
articles, and unified with the chat so citations open internal articles.

## 2. Data

The stored chunks reconstruct an article's text but hold no images and flatten
the infobox to `key: value` lines — right for retrieval, wrong for reading. So
the ingest gains a second output.

One parse, two consumers:

```
action=parse HTML
      ├──▶ chunks    (retrieval: embeddings, fts)      unchanged
      └──▶ articles  (reading: blocks, infobox, images)  new
```

```
articles
  page_key    text primary key  → pages(key) on delete cascade
  title, url, categories[]
  lead        text
  blocks      jsonb   ordered [{kind:'paragraph'|'list'|'table', section, …}]
  infobox     jsonb   {title, image, common:[group], tabs:[{label, groups}]}
  images      jsonb   [{url, alt, caption}]
  facets      jsonb   {biome, station, type, …}
  search_text text    title + categories + lead, for the client index
```

`facets` is what makes browsing and comparing possible: biome and crafting
station already sit in the infoboxes (`Main biome: Plains`, `Source: Forge`);
lifting them into a queryable field is the whole feature.

Images are hotlinked from `static.wikia.nocookie.net`. Verified: 200, WebP,
about 1 KB per icon, with `scale-to-width-down` thumbnails by URL. For a
private app with a handful of readers this is negligible traffic on a CDN built
to serve it; storing copies would add blob storage for no gain.

## 3. Reading

The complaint about Fandom on a phone is that the infobox buries the page and
the facts are below the fold. The article page inverts that: **the data is the
page, and prose follows.** Nobody opens "Iron Sword" to read prose.

- Identity strip: icon, name, type, crafting station.
- Upgrade levels as a segmented control, not four stacked tables.
- Stat rows: label left, value right, monospaced so numbers align.
- Wide tables scroll inside their own container with a sticky first column, so
  the page itself never scrolls sideways.
- "Ask about this" at the foot, opening the chat with the article in context.

## 4. Navigation

Bottom tab bar on phones (Search · Browse · Chat); the existing sidebar gains
the same sections on desktop.

**Search is split by what it is good at.** The title index — 1,027 titles with
their categories, about 35 KB gzipped — is sent to the client and filtered as
you type: instant, no request, and offline for free. Content search stays on
the server, reusing the weighted `tsvector` already built for retrieval.

**Browse** uses the wiki's own categories (Materials 165, Weapons 158, Food 79,
Creatures 68, …) plus the biome and station facets.

**Compare** is generic: within a category, take the union of infobox labels and
render items as rows, sortable by any column. No per-item-type schema to write
or maintain.

## 5. Offline

A service worker with three strategies:
- app shell and the title index: cache-first, revalidated in the background;
- article pages: stale-while-revalidate, so a visited article opens offline;
- `/api/chat`: never cached — it cannot work offline and a stale answer would
  be worse than an honest failure.

A web app manifest makes it installable. The UI states plainly when it is
serving a cached copy and the chat is unavailable.

## 6. Testing

- **Unit** — block extraction order, infobox structure and tabs, image
  extraction, facet lifting, the client-side title matcher.
- **Integration** — article build and round-trip through Postgres; category and
  facet queries; that the chunk pipeline is unchanged (retrieval eval must not
  move).
- **E2E** — search to article in one interaction, article renders stats before
  prose, no horizontal page scroll at 390 px, category browse, compare sorting,
  a chat citation opening the internal article, and the service worker serving
  a visited article with the network offline.

## 7. What the build changed

Four things the design did not anticipate, each found by something rather than
guessed at:

1. **Gallery images live inside `<noscript>`.** An HTML parser exposes that
   element's content as *text*, so walking elements found no images at all and
   dropped a raw `<img …>` string into the article as a paragraph. Caught by a
   test asserting no markup survives extraction.
2. **`Source` means two things.** On an item it names the crafting station; on a
   creature or a place it names an origin. Reading both as a station filled
   "browse by crafting station" with biomes and village names. It is now read as
   a station only when the same infobox states crafting materials.
3. **`Link` does not interpolate dynamic segments from an object href.**
   `{ pathname: '/wiki/a/[slug]', query: { slug } }` renders literally as
   `/wiki/a/[slug]?slug=iron-sword` and 404s — every link in the reader was
   broken. Route building now lives in `src/lib/routes.ts` with a regression
   test.
4. **`navigator.onLine` cannot answer "am I offline".** It reports whether a
   network interface exists, and Chromium resets it across a navigation even
   under emulated offline. The banner asks the server instead, via a tiny
   uncached `/api/health`.

And one ranking mistake worth recording: ordering comparison columns by how
often a field appears put "Internal ID" first. Columns are now ranked by how
comparable their values are — numeric ranks, categorical groups, distinct-per-
row is identity.

## 8. Not building

Editing, accounts, per-user favourites, a Spanish translation of article bodies
(the wiki is English; the chat is what answers in Spanish), and image hosting of
our own.
