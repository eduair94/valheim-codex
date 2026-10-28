/**
 * Whether the crafting planner ("Taller", `/wiki/craft`) is live.
 *
 * The planner lands over several releases, and the ways in to it (the tab,
 * the app shortcut, the sitemap entry) would point at a page that does not
 * exist yet. They stay out of every build until the route ships, and are
 * switched on together with it. Browser-safe: the tab bar reads it.
 */
export const CRAFT_PLANNER_LIVE: boolean = false;
