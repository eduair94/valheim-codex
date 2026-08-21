import type { CategorySummary } from '@/lib/db/wiki-repo';

/**
 * Curating the browsing axes.
 *
 * The raw counts from the database are an accurate description of the wiki and
 * a poor front page: they lead with "Forge recipes, 50" next to "Forge, 72",
 * and they sort the biomes by how much has been written about each. What a
 * player actually holds in their head is a progression and a handful of kinds
 * of thing, so the shaping happens here — pure functions, away from the query
 * and away from the markup, because the decisions are the part worth testing.
 */

/**
 * The biomes in the order the game gives them to you.
 *
 * Valheim is a ladder: you leave the Meadows for the Black Forest because the
 * Black Forest is next, and every item, boss and material sits on one rung.
 * Listing them by article count would sort Ashlands above Meadows and throw
 * away the single most useful thing the list could tell a new player.
 */
const BIOME_ORDER = [
  'Meadows',
  'Black Forest',
  'Swamp',
  'Mountain',
  'Mountains',
  'Plains',
  'Mistlands',
  'Ashlands',
  'Deep North',
  'Ocean',
] as const;

/**
 * The biomes, numbered by that order.
 *
 * The facet is free text on the wiki, so it also carries dungeons ("Sealed
 * tower"), map features ("Rivers") and compound answers ("Meadows and Plains").
 * Those are true of an article and wrong as a rung: appended to a numbered
 * ladder they claim Rivers is the tenth place the game sends you. The list is
 * therefore the known biomes and nothing else — the price is that a biome added
 * to the game needs a line here, which is a line worth writing to keep the
 * numbers honest.
 */
export function orderedBiomes(items: CategorySummary[]): CategorySummary[] {
  const rank = (name: string): number =>
    BIOME_ORDER.indexOf(name as (typeof BIOME_ORDER)[number]);

  return items.filter((item) => rank(item.name) !== -1).sort((a, b) => rank(a.name) - rank(b.name));
}

/**
 * The kinds of thing, minus the recipe lists.
 *
 * "Forge recipes" and "Workbench recipes" answer "what can I make at this
 * bench", which is exactly the question the crafting-stations axis is for.
 * Showing both puts near-duplicate tiles side by side and buries the
 * categories that answer a different question.
 */
export function mainCategories(items: CategorySummary[], limit: number): CategorySummary[] {
  return items.filter((item) => !/\brecipes$/i.test(item.name)).slice(0, limit);
}

/** A crafting station's level. "Cauldron (level 3)", "Artisan table level 2". */
const STATION_LEVEL = /\s*\(?\blevel\s*\d+\)?$/i;

/**
 * Values the station facet carries that name no bench: the generic verb, the
 * NPC who sells rather than crafts, and the explicit blank.
 */
const NOT_A_STATION = new Set(['n/a', 'Crafting', 'Smelting', 'Console', 'Hildir', 'Player crafting menu']);

/**
 * The benches, each listed once.
 *
 * A station's upgrade levels are the same bench in the same spot; as separate
 * tiles they read as separate places to walk to.
 */
export function mainStations(items: CategorySummary[], limit: number): CategorySummary[] {
  return items
    .filter((item) => !STATION_LEVEL.test(item.name) && !NOT_A_STATION.has(item.name))
    .slice(0, limit);
}
