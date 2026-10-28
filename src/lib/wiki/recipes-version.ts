/**
 * Version of what `extractRecipes` (recipes.ts) reads from a page's HTML:
 * the infoboxes with their levels, yields, links and notes, the structure
 * list rows and the food table's rows.
 *
 * It moves on its own, apart from PARSER_VERSION (src/lib/ingest/version.ts):
 * reading the recipes again costs one page fetch each and touches nothing a
 * reader sees until the graph is rebuilt, while re-parsing an article marks
 * its Spanish translation stale. So recipes can be re-read without
 * re-parsing articles, and the other way round.
 *
 * Bump it in the same change as any extractor edit that alters the output
 * for the same HTML, and record the new output's fingerprint below. Each
 * page's stored recipes record the version that read them
 * (`page_recipes.recipes_version`), and `pnpm ingest --recipes` reads again
 * every page an older version read. Without the bump a fix would reach only
 * the pages someone happened to edit afterwards, which is how the parser's
 * August 2026 maths fix missed the 14 articles it was written for.
 *
 * History
 *   1  Every infobox on a page, each named by its tab (none for the page's
 *      own, and none at all on an armor set); per quality tab its crafting
 *      level, its "Crafts N" yield and its materials, in either order, each
 *      with the link whose text is its name (a self-link as the page's
 *      title); Source with its links; Max Level, Improvements and "Upgrades
 *      X". The tables of building pieces on pages with no infobox, a
 *      station's table of extensions, and the food table's station, level
 *      and multiplier. Whatever a cell says that is none of these is a note,
 *      numbered by its quality tab, and a cell with a line it cannot read
 *      gives no recipe rather than part of one.
 *   2  Also the page's own item's table of upgrades ("Upgrade information"):
 *      per quality its materials and the station level its level row
 *      states, so the graph can set it beside the infobox (the Wood Tower
 *      Shield's two first steps) and take a quality only the table states
 *      (the Staff of Protection's fourth). A line of several linked
 *      materials, "Pike x1 Tuna x1", is each of them, where it was one
 *      unreadable note.
 */
export const RECIPES_VERSION = 2;

/**
 * What RECIPES_VERSION's extractor reads from the saved pages in
 * tests/fixtures and tests/fixtures/recipes, hashed.
 * tests/unit/recipes-extract.test.ts rebuilds it, so a change to the
 * extractor's output fails there until this is updated, next to the version
 * that has to move with it. A new or edited saved page changes it too, and
 * then only this needs updating.
 */
export const RECIPES_OUTPUT_HASH = 'a508b433e3263bf9';
