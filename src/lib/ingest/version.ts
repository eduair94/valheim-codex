/**
 * Version of everything the ingest derives from a page's HTML: the reading
 * document (`extractArticle`), the retrieval sections and tables
 * (`extractSections`), the infobox tree and the chunks built from them.
 *
 * Bump it in the same change as any parser edit that alters the output for
 * the same HTML, and record the new output's fingerprint below. Each article
 * records the version that built it (`articles.parser_version`). Without it a
 * parser fix reached only the pages someone happened to edit afterwards: the
 * maths clean-up of August 2026 never reached the 14 articles it was for.
 *
 * Every ingest counts the pages an older version built, and says so;
 * `pnpm ingest --reparse` rebuilds them. That is a deliberate step rather
 * than part of every run because of what it touches: one page fetch each,
 * and a stale translation for every article whose text the new parser
 * changes — most of them, the first time. When the output does not change it
 * costs nothing else: chunks keep their vectors by content hash, and an
 * article whose text is the same keeps its `updated_at`, so its translations
 * stay fresh.
 *
 * History
 *   0  Before versions were recorded.
 *   1  Tables read with spans, stacked headers and empty columns dropped; line
 *      breaks kept in cells, list items and infobox values; notice banners
 *      and maintenance categories; leads past banners, figures and tabbed
 *      infoboxes; icons kept out of galleries; maths as text. A th-less
 *      first row promoted to a header only when it looks like one; th rows
 *      of a one-column table as group headings. See article-types.ts.
 *   2  Tabbers in the body (tabber.ts): one that only held infoboxes goes
 *      whatever wraps it, so its labels are no lead ("Baked\n\nUnbaked");
 *      one of text or tables is read tab by tab, each under its own heading
 *      or its label, in the reading document and the retrieval sections
 *      alike, and its labels are never text. An infobox's level tabs come
 *      from its first tabber with data: an armor piece's picture tabber took
 *      them, and its levels — armor, durability, weight, recipe — were lost.
 *      A page with one infobox per tab names those tabs (`infobox.variants`:
 *      an armor set's is its helmet's). The station facet needs a recipe
 *      that states something, not a repair level or "n/a", which kept the
 *      traders Hildir and Haldor from becoming stations once those levels
 *      were read.
 *   3  A section under MIN_PROSE_TOKENS keeps its chunk when it has a heading
 *      and a word of three letters or more (chunker.ts): "Flax › Usage ›
 *      Taming" is "Lox", and eight such sections, five of them Usage lists,
 *      had no chunk at all. No saved page has one, so the fingerprint below
 *      did not move; tests/unit/chunker.test.ts builds one.
 */
export const PARSER_VERSION = 3;

/**
 * What PARSER_VERSION's parser builds from the saved pages in tests/fixtures,
 * hashed. tests/unit/parser-version.test.ts rebuilds it, so a change to the
 * parser's output fails there until this is updated — next to the version
 * that has to move with it. A new or edited fixture changes it too, and then
 * only this needs updating.
 */
export const PARSER_OUTPUT_HASH = 'd72024c1501e2f43';
