import type { CraftRef, CraftUse, CraftView } from '@/lib/craft/data';

/**
 * How many uses a station's group shows before its toggle: two full rows of
 * the three columns a wide screen gives the cards, three of the two they
 * get beside the stats. A phone shows the first four of them (craft.css),
 * where each card takes the width. The busiest materials (Wood's 84 uses at
 * the Workbench) still open on a page, not a wall.
 */
export const USES_SHOWN = 6;

export type UseGroup = { station: CraftRef | null; shown: CraftUse[]; hidden: CraftUse[] };

/**
 * "Usado en" as the article lays it out: the view's groups in the view's
 * order (the busiest station first, no station last), each split into the uses
 * shown and the rest, which a `<details>` keeps until asked for. A group
 * with nothing in it is left out, and one only a use longer than `visible`
 * shows all of it: a toggle in place of one card takes as much room as the
 * card, and a tap more.
 */
export function groupUses(usedIn: CraftView['usedIn'], visible: number = USES_SHOWN): UseGroup[] {
  return usedIn
    .filter((group) => group.items.length > 0)
    .map((group) => {
      const cut = group.items.length > visible + 1 ? visible : group.items.length;
      return { station: group.station, shown: group.items.slice(0, cut), hidden: group.items.slice(cut) };
    });
}
