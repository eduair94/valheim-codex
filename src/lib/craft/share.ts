import { cleanPlanItem, MAX_PLAN_ITEMS, type PlanItem } from './planner-store';

/**
 * A planner list as a link, the way a list moves to another device or to a
 * friend: `/wiki/craft?l=SwordIron.4.0.1~BronzeNails.1.0.20`, each item its
 * id, the level wanted, the level owned and the quantity, joined by dots,
 * items joined by tildes. Both are characters an address carries as they
 * are, so a list of game ids reads as plain text.
 *
 * Links get edited by hand, cut short by chat apps and pasted with junk
 * around them. Decoding reads every part on its own and keeps those it can
 * use, as reading the stored list does (`cleanPlanItem`), caps how much it
 * reads, and never throws. Opening one never replaces the reader's list by
 * itself: the planner asks first.
 *
 * Ids are escaped with `encodeURIComponent`, and `.` and `~` too, which it
 * leaves alone. The address escapes the whole param once more (`craftHref`):
 * a page reads its query decoded once, which would otherwise turn the
 * escaped separators back into real ones.
 */

export const SHARE_PARAM = 'l';
/**
 * As many items as a list holds, so a full list travels whole: sharing is
 * how a reader whose browser cannot save keeps a list. The length below
 * bounds the address whatever the count; a hundred of the graph's longest
 * ids take about 2,500 characters.
 */
export const MAX_SHARE_ITEMS = MAX_PLAN_ITEMS;
/** Longer than any link this app writes (`encodeShare` stops short of it); a longer one is not read at all. */
export const MAX_SHARE_LENGTH = 4000;

const ITEMS = '~';
const FIELDS = '.';

/** A level, level owned or quantity: plain digits, few enough to stay an exact whole number. */
const NUMBER = /^\d{1,9}$/;

/**
 * An id as one field of a link, or null for an id no link can carry: one
 * with half of a surrogate pair, which `encodeURIComponent` refuses.
 */
function encodeId(id: string): string | null {
  try {
    return encodeURIComponent(id).replaceAll('.', '%2E').replaceAll('~', '%7E');
  } catch {
    return null;
  }
}

/** The id a field holds, or null for a broken escape or an id no link could have written. */
function decodeId(field: string): string | null {
  try {
    const id = decodeURIComponent(field);
    return encodeId(id) === null ? null : id;
  } catch {
    return null;
  }
}

/** The parts a link writes for `items`: the first ones, as many as fit in a link that is read back whole. */
function shareParts(items: PlanItem[]): string[] {
  const parts: string[] = [];
  let length = 0;
  for (const item of items) {
    if (parts.length >= MAX_SHARE_ITEMS) break;
    const clean = cleanPlanItem(item);
    const id = clean && encodeId(clean.id);
    if (!clean || !id) continue;
    const part = [id, clean.level, clean.from, clean.qty].join(FIELDS);
    const grown = length + (parts.length > 0 ? ITEMS.length : 0) + part.length;
    // Past the length nothing is read back, so a list that long is cut here,
    // whole items at a time, rather than lost when it is opened.
    if (grown > MAX_SHARE_LENGTH) break;
    parts.push(part);
    length = grown;
  }
  return parts;
}

/** "SwordIron.4.0.1~BronzeNails.1.0.20": the items from the first, as many as fit in a link that is read back whole. */
export function encodeShare(items: PlanItem[]): string {
  return shareParts(items).join(ITEMS);
}

/**
 * How many of `items` the link `encodeShare` writes for them carries: all
 * of them, unless the ids are so long that the link would pass
 * `MAX_SHARE_LENGTH`. Below the list's own length, the planner says that
 * the link holds only the first ones (`craftShareCut`), rather than letting
 * the reader think the whole list went.
 */
export function sharedCount(items: PlanItem[]): number {
  return shareParts(items).length;
}

/**
 * The items a link's param holds, as a page reads it from its address
 * (decoded once). A part is read only with exactly four fields and three
 * plain numbers: with five, which four are meant is a guess, and it is
 * dropped whole. At most `MAX_SHARE_ITEMS` items; an empty list for nothing
 * usable.
 */
export function decodeShare(param: string | null | undefined): PlanItem[] {
  if (!param || param.length > MAX_SHARE_LENGTH) return [];
  const items: PlanItem[] = [];
  for (const part of param.split(ITEMS)) {
    if (items.length >= MAX_SHARE_ITEMS) break;
    const fields = part.split(FIELDS);
    if (fields.length !== 4) continue;
    const [field, level, from, qty] = fields as [string, string, string, string];
    if (!NUMBER.test(level) || !NUMBER.test(from) || !NUMBER.test(qty)) continue;
    const id = decodeId(field);
    const item = id === null ? null : cleanPlanItem({ id, level: Number(level), from: Number(from), qty: Number(qty) });
    if (item) items.push(item);
  }
  return items;
}
