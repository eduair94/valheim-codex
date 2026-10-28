import type { CategorySummary } from '@/lib/db/wiki-repo';
import { SOURCES } from './sources';

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
export const BIOME_ORDER = [
  'Meadows',
  'Black Forest',
  'Swamp',
  'Mountain',
  'Plains',
  'Mistlands',
  'Ashlands',
  'Deep North',
  'Ocean',
] as const;

export type Biome = (typeof BIOME_ORDER)[number];

/**
 * A biome named anywhere in a piece of text, as whole words.
 *
 * Whole words because the wiki's free text says "Shorelines of rivers and
 * oceans", which is not the Ocean, and "Fuling Village in the Plains biome",
 * which is the Plains. "Mountains" is the one plural the wiki uses for a
 * biome, and it is the same rung as "Mountain": left apart, the ladder would
 * show the mountain twice.
 */
const BIOME_MENTION = new RegExp(
  `(?<![\\p{L}\\p{N}])(meadows|black forest|swamp|mountains?|plains|mistlands|ashlands|deep north|ocean)(?![\\p{L}\\p{N}])`,
  'iu',
);

/** The first biome a text names, by its canonical name; null when it names none. */
export function canonicalBiome(text: string | null | undefined): Biome | null {
  if (!text) return null;
  const found = BIOME_MENTION.exec(text)?.[1]?.toLowerCase().replace(/^mountains$/, 'mountain');
  return BIOME_ORDER.find((biome) => biome.toLowerCase() === found) ?? null;
}

/** What an article's infobox says about where it is, as the biome query reads it. */
export type BiomeEvidence = {
  /** The lifted `biome` facet: "Main biome", "Biome" or "Biomes". */
  facet: string | null;
  /** The infobox "Location" row: structures and points of interest. */
  location: string | null;
  /** The infobox "Source" row. */
  source: string | null;
  /** Whether the infobox states a recipe, which makes "Source" a station. */
  craftable: boolean;
};

/**
 * The one biome an article belongs to on the browse ladder.
 *
 * Only 83 of about a thousand articles carry a biome facet, and the Meadows
 * tile listed eight of them — creatures and trees, and none of the places,
 * plants or materials a player finds there. The rest say it in other rows, so
 * those are read too, in order of how directly they answer "where is this":
 *
 *   1. the biome facet itself, when it names a known biome ("Sealed tower"
 *      and "Rivers" are true of an article and name no rung);
 *   2. "Location", which is where a structure or a point of interest stands;
 *   3. "Source" on something that cannot be crafted, where it says where the
 *      thing comes from ("Found in the Ashlands"). On a craftable item the
 *      same row names a bench.
 *
 * "Hospitable Biomes" is deliberately not read: it says where a crop can be
 * planted, and twelve of its sixteen values start with the Meadows, which
 * would file carrots and onions there. A row that names several biomes counts
 * for the first, the same rule the facet has always followed.
 *
 * The facet text itself is left alone for display — "Sealed tower" is still
 * what the article header says — this only decides the rung.
 */
export function articleBiome(evidence: BiomeEvidence): Biome | null {
  return (
    canonicalBiome(evidence.facet) ??
    canonicalBiome(evidence.location) ??
    (evidence.craftable ? null : canonicalBiome(evidence.source))
  );
}

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
 *
 * Two spellings of one biome ("Mountain", "Mountains") become one rung, with
 * their counts added.
 */
export function orderedBiomes(items: CategorySummary[]): CategorySummary[] {
  const merged = new Map<Biome, CategorySummary>();
  for (const item of items) {
    const biome = canonicalBiome(item.name);
    if (!biome || !sameBiomeName(item.name, biome)) continue;
    const held = merged.get(biome);
    merged.set(
      biome,
      held
        ? { ...held, count: held.count + item.count, icon: held.icon ?? item.icon }
        : { ...item, name: biome },
    );
  }
  return BIOME_ORDER.flatMap((biome) => {
    const item = merged.get(biome);
    return item ? [item] : [];
  });
}

/** `Mountains` is the Mountain; `Meadows and Plains` is not the Meadows. */
function sameBiomeName(name: string, biome: Biome): boolean {
  const key = name.trim().toLowerCase();
  return key === biome.toLowerCase() || (biome === 'Mountain' && key === 'mountains');
}

/**
 * The wiki's own bookkeeping categories — "Unfinished", "Stubs", "Pages with
 * broken file links" — which the notice banners add and which say nothing
 * about the game.
 *
 * The ingest drops them from articles it parses from now on (the list lives
 * with the source, in sources.ts); this keeps them out of what readers see
 * meanwhile, and out of any article an older ingest stored. Shown, and now
 * translated, they read as real categories: a search for the iron shield
 * said "Escudo · Sin terminar · Armas".
 */
const MAINTENANCE = new Set(SOURCES.flatMap((source) => source.maintenanceCategories ?? []).map((c) => c.toLowerCase()));

/** Whether a category is the wiki's bookkeeping rather than a kind of thing. */
export function isMaintenanceCategory(name: string): boolean {
  return MAINTENANCE.has(name.trim().toLowerCase());
}

/**
 * The kinds of thing, minus the recipe lists and the bookkeeping.
 *
 * "Forge recipes" and "Workbench recipes" answer "what can I make at this
 * bench", which is exactly the question the crafting-stations axis is for.
 * Showing both puts near-duplicate tiles side by side and buries the
 * categories that answer a different question.
 */
export function mainCategories(items: CategorySummary[]): CategorySummary[] {
  return items.filter((item) => !/\brecipes$/i.test(item.name) && !isMaintenanceCategory(item.name));
}

/** A crafting station's level. "Cauldron (level 3)", "Artisan table level 2". */
const STATION_LEVEL = /\s*\(?\blevel\s*(\d+)\)?$/i;

/**
 * The same, as a Postgres regular expression, for grouping and filtering in
 * SQL. `\y` is Postgres' word boundary; the rest is the same pattern.
 */
export const STATION_LEVEL_SQL = '\\s*\\(?\\ylevel\\s*\\d+\\)?$';

/** `Cauldron (level 3)` → the bench and its level; a plain bench has no level. */
export function splitStationLevel(name: string): { base: string; level: number | null } {
  const match = STATION_LEVEL.exec(name);
  if (!match) return { base: name.trim(), level: null };
  return { base: name.slice(0, match.index).trim(), level: Number(match[1]) };
}

/**
 * Values the station facet carries that name no bench: the generic verb, the
 * traders who sell rather than craft, and the explicit blank. The parser no
 * longer lifts a trader as a station (`statesRecipe` in article.ts); this
 * keeps them off the tiles for rows an older parser stored, and for any the
 * wiki writes some new way.
 */
const NOT_A_STATION = new Set(['n/a', 'Crafting', 'Smelting', 'Console', 'Hildir', 'Haldor', 'Player crafting menu']);

/**
 * The benches, each listed once.
 *
 * A station's upgrade levels are the same bench in the same spot; as separate
 * tiles they read as separate places to walk to. The station queries already
 * count "Cauldron (level 3)" under Cauldron, so a levelled value only reaches
 * here from an older caller, and it is dropped rather than shown twice.
 */
export function mainStations(items: CategorySummary[]): CategorySummary[] {
  return items.filter((item) => !STATION_LEVEL.test(item.name) && !NOT_A_STATION.has(item.name));
}
