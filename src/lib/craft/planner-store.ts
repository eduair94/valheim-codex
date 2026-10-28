import { createLocalStore, type LocalStore } from '@/lib/local-store';
import type { ItemId } from './types';

/**
 * The crafting planner's list as the reader's device keeps it: the targets
 * to make and what the reader already holds.
 *
 * Stored under `wv-craft-v1`, written by this build, read later by this one,
 * an older or a newer one, and editable by hand. So reading checks every
 * entry on its own and drops only what is malformed, and a target the
 * recipes do not know (a newer graph's item, or one the wiki renamed away)
 * is kept for the planner to name, never thrown out: losing a reader's list
 * is worse than showing an item it cannot price. A change of shape that an
 * older build would misread takes a new key, `wv-craft-v2`, rather than
 * reusing this one.
 *
 * Every change is a pure function of the state, stamped with the time the
 * caller passes in. Apply one with `plannerStore.update`, which reads storage
 * at the moment of the change, so another tab's list is built on rather than
 * overwritten (`src/lib/local-store.ts`).
 */

export const PLANNER_KEY = 'wv-craft-v1';
export const MAX_PLAN_ITEMS = 100;
/** Items, not crafts: 99 crafts of 20 nails still fit. */
export const MAX_ITEM_QTY = 9999;
export const MAX_HAVE = 99999;

/** The highest level a target may ask for: well above every item's maximum today, so a newer graph's levels still fit. */
const MAX_LEVEL = 20;

/** Longer than any id the graph makes: game ids, and `page:<slug>#<anchor>` with an 80-character slug. */
const MAX_ID_LENGTH = 120;

/**
 * One thing to make: the item, the level wanted, the level already owned (0
 * to make it new) and how many items, not crafts: 30 nails, though a craft
 * makes 20.
 */
export type PlanItem = { id: ItemId; level: number; from: number; qty: number };

/** The list and the counts the reader holds, which the shopping list and "what I have" share. `at` is the last change. */
export type PlannerState = { v: 1; items: PlanItem[]; have: Record<ItemId, number>; at: string | null };

/** Never changed in place: every function here returns a new state. */
export const EMPTY_PLANNER: PlannerState = emptyPlanner();

function emptyPlanner(): PlannerState {
  return { v: 1, items: [], have: {}, at: null };
}

function isItemId(value: unknown): value is ItemId {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A plan item as this module keeps one, or null when the value cannot be
 * one: an id of 1 to 120 characters and whole numbers for the rest. The
 * numbers are clamped rather than refused (level 1 to 20, the level owned
 * below it, 1 to `MAX_ITEM_QTY` items), because "level 99" still says which
 * item the reader wants. The share links read their parts with it too, so a
 * list means the same in storage and in an address.
 */
export function cleanPlanItem(value: unknown): PlanItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { id, level, from, qty } = value as Record<string, unknown>;
  if (!isItemId(id) || !Number.isInteger(level) || !Number.isInteger(from) || !Number.isInteger(qty)) return null;
  const top = clamp(level as number, 1, MAX_LEVEL);
  return { id, level: top, from: clamp(from as number, 0, top - 1), qty: clamp(qty as number, 1, MAX_ITEM_QTY) };
}

/** Garbage, another shape or nothing at all is an empty plan: whatever is there could not be used anyway. */
export function parsePlanner(raw: string | null): PlannerState {
  let value: unknown;
  try {
    value = raw === null ? null : JSON.parse(raw);
  } catch {
    return emptyPlanner();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyPlanner();
  const { v, items, have, at } = value as Record<string, unknown>;
  if (v !== 1) return emptyPlanner();

  const kept: PlanItem[] = [];
  for (const entry of Array.isArray(items) ? items : []) {
    if (kept.length >= MAX_PLAN_ITEMS) break;
    const item = cleanPlanItem(entry);
    if (item) kept.push(item);
  }
  return { v: 1, items: kept, have: cleanHave(have), at: typeof at === 'string' ? at : null };
}

/** The counts worth keeping: whole numbers above 0 for usable ids, capped at `MAX_HAVE`. */
function cleanHave(value: unknown): Record<ItemId, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const kept: [ItemId, number][] = [];
  for (const [id, count] of Object.entries(value)) {
    if (isItemId(id) && Number.isInteger(count) && (count as number) > 0) kept.push([id, Math.min(count as number, MAX_HAVE)]);
  }
  // Built as own properties, never assigned one by one: an id such as
  // `__proto__` stays a key like any other.
  return Object.fromEntries(kept);
}

/** Only the fields `parsePlanner` reads, in its order. */
export function serializePlanner(state: PlannerState): string {
  return JSON.stringify({
    v: 1,
    items: state.items.map(({ id, level, from, qty }) => ({ id, level, from, qty })),
    have: state.have,
    at: state.at,
  });
}

/** Whether two items are the same target: one item, from one level to another. */
function sameTarget(a: PlanItem, b: PlanItem): boolean {
  return a.id === b.id && a.level === b.level && a.from === b.from;
}

/**
 * Adds a target, or adds its quantity to the same target already listed.
 * At `MAX_PLAN_ITEMS` a new target is refused (`added: false`, the same
 * state), for the interface to say the list is full; an item it cannot read
 * is refused the same way.
 */
export function addItem(state: PlannerState, item: PlanItem, now: string): { state: PlannerState; added: boolean } {
  const clean = cleanPlanItem(item);
  if (!clean) return { state, added: false };
  const index = state.items.findIndex((target) => sameTarget(target, clean));
  if (index >= 0) {
    const items = state.items.map((target, i) =>
      i === index ? { ...target, qty: Math.min(target.qty + clean.qty, MAX_ITEM_QTY) } : target,
    );
    return { state: { ...state, items, at: now }, added: true };
  }
  if (state.items.length >= MAX_PLAN_ITEMS) return { state, added: false };
  return { state: { ...state, items: [...state.items, clean], at: now }, added: true };
}

/**
 * Changes one target's level, level owned or quantity, clamped as reading
 * clamps: lowering the level lowers the level owned with it. A target this
 * makes equal to another stays its own row; merging the two would move the
 * row the reader is editing. An index or a value it cannot use changes
 * nothing.
 */
export function updateItem(state: PlannerState, index: number, patch: Partial<Omit<PlanItem, 'id'>>, now: string): PlannerState {
  const current = state.items[index];
  if (!current) return state;
  const clean = cleanPlanItem({ ...current, ...patch, id: current.id });
  if (!clean) return state;
  return { ...state, items: state.items.map((target, i) => (i === index ? clean : target)), at: now };
}

export function removeItem(state: PlannerState, index: number, now: string): PlannerState {
  if (!state.items[index]) return state;
  return { ...state, items: state.items.filter((_, i) => i !== index), at: now };
}

/** "Sumar a mi lista": each item added as `addItem` adds it, while the list has room. */
export function mergeItems(state: PlannerState, items: PlanItem[], now: string): PlannerState {
  let next = state;
  for (const item of items) next = addItem(next, item, now).state;
  return next;
}

/** "Reemplazar mi lista": the items, the same targets summed, and the counts the reader holds kept. */
export function replaceItems(state: PlannerState, items: PlanItem[], now: string): PlannerState {
  return { ...mergeItems({ ...state, items: [] }, items, now), at: now };
}

/**
 * Records how many of an item the reader holds, in whole items up to
 * `MAX_HAVE`; 0 or less deletes the entry. A count that is not a number
 * changes nothing, so a stray keystroke in a count field never wipes one.
 */
export function setHave(state: PlannerState, id: ItemId, count: number, now: string): PlannerState {
  if (!isItemId(id) || !Number.isFinite(count)) return state;
  const whole = Math.min(Math.floor(count), MAX_HAVE);
  const current = Object.hasOwn(state.have, id) ? state.have[id] : undefined;
  if (whole <= 0) {
    if (current === undefined) return state;
    const { [id]: _removed, ...rest } = state.have;
    return { ...state, have: rest, at: now };
  }
  if (current === whole) return state;
  return { ...state, have: { ...state.have, [id]: whole }, at: now };
}

/** "Vaciar lista": no targets left; what the reader holds stays. */
export function clearPlan(state: PlannerState, now: string): PlannerState {
  return state.items.length === 0 ? state : { ...state, items: [], at: now };
}

/** The list on this device, shared by every component and tab that shows it. */
export const plannerStore: LocalStore<PlannerState> = createLocalStore(PLANNER_KEY, {
  parse: parsePlanner,
  serialize: serializePlanner,
});
