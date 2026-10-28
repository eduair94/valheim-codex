import type { Route } from 'next';
import { logError, logWarn } from '@/lib/log';
import { articleHref } from '@/lib/routes';
import { normalizeTerm, type LinkTarget } from '@/lib/wiki/links';

/**
 * Where an item chip in the guide leads.
 *
 * To the Codex's own article whenever there is one. Those open in the app,
 * work offline and keep the reader's place in the guide one Back away; the
 * guide used to send every chip to the original wiki's search in a new tab,
 * including the two hundred-odd names the Codex already has a page for.
 *
 * The original wiki's search stays as the fallback, for the five names the
 * Codex has no page for (Vegvisir, Raw Meat, Fuling Archer, and the two Deep
 * North creatures that are not in the game yet), because a search on the
 * source wiki always lands somewhere useful, where a guessed article URL
 * would be a dead page the moment the guess missed.
 */

/** Normalised article title → slug. */
export type GuideLinks = ReadonlyMap<string, string>;

export const NO_GUIDE_LINKS: GuideLinks = new Map();

export const FANDOM_SEARCH = 'https://valheim.fandom.com/wiki/Special:Search?query=';

/**
 * Names the guide writes the way the game shows them, whose article is titled
 * differently: the wiki files dungeons and berries under the plural, armor
 * pieces under their set, and a few things under another name altogether.
 *
 * Only names that always mean the same article belong here. A word that means
 * different things in different sentences — "Root" the item or the creature,
 * "Crafting" the skill or the menu — names its article where it is used
 * instead (`<Item article="Root (item)">`).
 */
export const ARTICLE_FOR: Readonly<Record<string, string>> = {
  'Burial Chamber': 'Burial Chambers',
  'Sunken Crypt': 'Sunken Crypts',
  'Frost Cave': 'Frost Caves',
  Raspberry: 'Raspberries',
  Blueberry: 'Blueberries',
  'Core Wood': 'Corewood',
  'Fine Wood': 'Finewood',
  Seagull: 'Gull',
  'Fishing Bait': 'Bait',
  Zil: 'Zil & Thungr',
  Thungr: 'Zil & Thungr',
  "Hildir's Brass Chest": "Hildir's Chests",
  "Hildir's Silver Chest": "Hildir's Chests",
  "Hildir's Bronze Chest": "Hildir's Chests",
  'Bronze Plate Cuirass': 'Bronze Armor',
  'Bronze Helmet': 'Bronze Armor',
  'Iron Helmet': 'Iron Armor',
  'Iron Scale Mail': 'Iron Armor',
  'Root Mask': 'Root Set',
  'Root Harnesk': 'Root Set',
  'Root Leggings': 'Root Set',
  'Flametal Helmet': 'Flametal Armor',
  'Flametal Breastplate': 'Flametal Armor',
  'Flametal Greaves': 'Flametal Armor',
  'Robes of Embla': 'Embla Set',
  Fenris: 'Fenris Set',
  'Eitr-weave': 'Eitr-weave Set',
  Berserkir: 'Berserkir Axes',
  'The Hare': 'Hare',
  Cooking: 'Cooking (skill)',
  Farming: 'Farming (skill)',
  // The two heads are found, not crafted; the axes' article says where.
  'Curious Axe Head': 'Early Axes',
  'Mysterious Axe Head': 'Early Axes',
};

/**
 * The page a name falls back to when it has no article of its own: the wiki
 * keeps every trophy on one list, with what drops it and where it hangs.
 * Tried after the name itself, so a trophy that ever gets its own page wins.
 */
function familyArticle(name: string): string | undefined {
  return name.endsWith(' Trophy') ? 'Trophies' : undefined;
}

/**
 * The lookup table for one render, from the link index.
 *
 * Built from the English index: every chip is an English name, whatever the
 * reader's language, and a Spanish title that happened to spell the same as
 * some other article's English one must not get to claim it.
 */
export function buildGuideLinks(index: readonly LinkTarget[]): GuideLinks {
  const links = new Map<string, string>();
  for (const target of index) {
    const key = normalizeTerm(target.match);
    // The index is sorted by title; the first spelling of a name keeps it.
    if (key && !links.has(key)) links.set(key, target.slug);
  }
  return links;
}

/** How long the guide waits for the link index before it renders without it. */
export const LINKS_WAIT_MS = 300;

/**
 * The lookup table, or none if the index is not there in time.
 *
 * The index comes from the data cache and is almost always there in a few
 * milliseconds. When it is not — a cold cache after a deploy, a database that
 * is slow or down — the guide does not wait on it: the page is hand-written
 * text the reader came for, and a chip that opens the original wiki is a
 * small price next to a page that takes seconds to arrive. The load is not
 * abandoned, so it still fills the cache for the next reader.
 */
export async function loadGuideLinks(
  load: () => Promise<readonly LinkTarget[]>,
  waitMs = LINKS_WAIT_MS,
): Promise<GuideLinks> {
  const links = Promise.resolve()
    .then(load)
    .then(buildGuideLinks, (error: unknown) => {
      // Logged once, here, whether or not the page is still waiting.
      logError('guide', error, { step: 'link-index' });
      return NO_GUIDE_LINKS;
    });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, waitMs, null);
  });
  try {
    const ready = await Promise.race([links, late]);
    if (ready) return ready;
    logWarn('guide', 'link index not ready; chips point at the original wiki for this view', {
      step: 'link-index',
      waitMs,
    });
    return NO_GUIDE_LINKS;
  } finally {
    clearTimeout(timer);
  }
}

export type ItemTarget = { href: Route; internal: true } | { href: string; internal: false };

/**
 * The article a chip names, tried most specific first: the one the sentence
 * asked for, then the name's usual article, then the name itself, then the
 * list the name belongs to — so an alias that the corpus later stops matching
 * falls back to the plain title before it falls back to the other site.
 */
export function itemTarget(name: string, links: GuideLinks, article?: string): ItemTarget {
  for (const title of [article, ARTICLE_FOR[name], name, familyArticle(name)]) {
    if (!title) continue;
    const slug = links.get(normalizeTerm(title));
    if (slug) return { href: articleHref(slug), internal: true };
  }
  return { href: `${FANDOM_SEARCH}${encodeURIComponent(name)}`, internal: false };
}
