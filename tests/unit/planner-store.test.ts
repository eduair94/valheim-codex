import { describe, expect, it } from 'vitest';
import {
  addItem,
  clearPlan,
  EMPTY_PLANNER,
  MAX_HAVE,
  MAX_ITEM_QTY,
  MAX_PLAN_ITEMS,
  mergeItems,
  parsePlanner,
  PLANNER_KEY,
  plannerStore,
  removeItem,
  replaceItems,
  serializePlanner,
  setHave,
  updateItem,
  type PlanItem,
  type PlannerState,
} from '@/lib/craft/planner-store';

/*
 * The planner's list as it is kept on the device (`wv-craft-v1`). Whatever is
 * stored there was written by this build, an older or a newer one, or edited
 * by hand: reading it keeps everything usable, drops what is malformed one
 * entry at a time, and never loses an item because the recipes no longer
 * know it.
 */

const NOW = '2026-10-27T18:00:00.000Z';
const LATER = '2026-10-27T19:00:00.000Z';

const sword: PlanItem = { id: 'SwordIron', level: 4, from: 0, qty: 1 };
const nails: PlanItem = { id: 'BronzeNails', level: 1, from: 0, qty: 20 };

function planOf(items: PlanItem[], have: Record<string, number> = {}): PlannerState {
  return { v: 1, items, have, at: NOW };
}

describe('parsePlanner', () => {
  it('drops what is malformed and keeps the rest', () => {
    const raw = JSON.stringify({
      v: 1,
      items: [{ id: 'SwordIron', level: 4, from: 0, qty: 1 }, { id: '', level: 1 }, 'x', { id: 'Karve', level: 9, from: 12, qty: -3 }],
      have: { Wood: 12, Iron: 'x', Tin: -1 },
      at: 'z',
    });
    expect(parsePlanner(raw)).toEqual({
      v: 1,
      items: [
        { id: 'SwordIron', level: 4, from: 0, qty: 1 },
        { id: 'Karve', level: 9, from: 8, qty: 1 },
      ],
      have: { Wood: 12 },
      at: 'z',
    });
  });

  it('reads garbage as an empty plan', () => {
    for (const raw of [null, '', '{', '[]', '{"v":2}', 'null', '"text"', '42', '{"v":"1"}']) {
      expect(parsePlanner(raw), String(raw)).toEqual(EMPTY_PLANNER);
    }
  });

  it('keeps ids the graph does not know', () => {
    const raw = JSON.stringify({ v: 1, items: [{ id: 'FutureThing', level: 1, from: 0, qty: 2 }], have: {}, at: null });
    expect(parsePlanner(raw).items).toEqual([{ id: 'FutureThing', level: 1, from: 0, qty: 2 }]);
  });

  it('keeps a level above what the recipes reach today, for the list to name', () => {
    // A newer graph may know a fifth level; the list says so rather than
    // quietly lowering what the reader asked for.
    const raw = JSON.stringify({ v: 1, items: [{ id: 'SwordIron', level: 7, from: 0, qty: 1 }], have: {}, at: null });
    expect(parsePlanner(raw).items[0]?.level).toBe(7);
  });

  it('caps the list', () => {
    const items = Array.from({ length: 150 }, (_, i) => ({ id: `Item${i}`, level: 1, from: 0, qty: 1 }));
    const parsed = parsePlanner(JSON.stringify({ v: 1, items, have: {}, at: null }));
    expect(parsed.items).toHaveLength(MAX_PLAN_ITEMS);
    expect(parsed.items[0]?.id).toBe('Item0');
    expect(parsed.items.at(-1)?.id).toBe(`Item${MAX_PLAN_ITEMS - 1}`);
  });

  it('clamps levels and quantities, and drops what is not a whole number', () => {
    const items = [
      { id: 'A', level: 0, from: 0, qty: 1 },
      { id: 'B', level: 25, from: -2, qty: MAX_ITEM_QTY + 1 },
      { id: 'C', level: 2.5, from: 0, qty: 1 },
      { id: 'D', level: 1, from: 0, qty: '3' },
      { id: 'E', level: 1, from: 0 },
      { id: 'x'.repeat(121), level: 1, from: 0, qty: 1 },
      { id: 'y'.repeat(120), level: 1, from: 0, qty: 1 },
      { id: 7, level: 1, from: 0, qty: 1 },
      [1, 2, 3],
      null,
    ];
    expect(parsePlanner(JSON.stringify({ v: 1, items, have: {}, at: null })).items).toEqual([
      { id: 'A', level: 1, from: 0, qty: 1 },
      { id: 'B', level: 20, from: 0, qty: MAX_ITEM_QTY },
      { id: 'y'.repeat(120), level: 1, from: 0, qty: 1 },
    ]);
  });

  it('keeps only the counts it can use', () => {
    const have = { Wood: 12, Iron: 'x', Tin: -1, Coal: 0, Resin: 2.5, Stone: MAX_HAVE + 5, '': 3, ['z'.repeat(121)]: 2 };
    expect(parsePlanner(JSON.stringify({ v: 1, items: [], have, at: null })).have).toEqual({ Wood: 12, Stone: MAX_HAVE });
    for (const bad of [null, [], 'x', 5]) {
      expect(parsePlanner(JSON.stringify({ v: 1, items: [sword], have: bad, at: null })).have).toEqual({});
    }
  });

  it('reads a missing or malformed item list as empty, keeping the counts', () => {
    expect(parsePlanner(JSON.stringify({ v: 1, items: 'x', have: { Wood: 1 }, at: null }))).toEqual({
      v: 1,
      items: [],
      have: { Wood: 1 },
      at: null,
    });
  });

  it('reads back exactly what it wrote', () => {
    const state = planOf([sword, nails, { id: 'page:wood-structures#wood-wall', level: 1, from: 0, qty: 30 }], { Wood: 12 });
    expect(parsePlanner(serializePlanner(state))).toEqual(state);
  });

  it('writes only the fields it reads', () => {
    const state = { ...planOf([{ ...sword, note: 'x' } as PlanItem]), extra: true } as PlannerState;
    expect(JSON.parse(serializePlanner(state))).toEqual({ v: 1, items: [sword], have: {}, at: NOW });
  });
});

describe('addItem', () => {
  it('adds into the same target', () => {
    const once = addItem(EMPTY_PLANNER, sword, NOW);
    const twice = addItem(once.state, sword, LATER);
    expect(twice.added).toBe(true);
    expect(twice.state.items).toEqual([{ ...sword, qty: 2 }]);
    expect(twice.state.at).toBe(LATER);
  });

  it('keeps a different level or starting level as its own target', () => {
    let state = addItem(EMPTY_PLANNER, sword, NOW).state;
    state = addItem(state, { ...sword, level: 3 }, NOW).state;
    state = addItem(state, { ...sword, from: 2 }, NOW).state;
    expect(state.items).toEqual([sword, { ...sword, level: 3 }, { ...sword, from: 2 }]);
  });

  it('refuses a new target once the list is full, and changes nothing', () => {
    const full = planOf(Array.from({ length: MAX_PLAN_ITEMS }, (_, i) => ({ id: `Item${i}`, level: 1, from: 0, qty: 1 })));
    const result = addItem(full, sword, LATER);
    expect(result).toEqual({ state: full, added: false });
    expect(result.state).toBe(full);
    // Adding to a target already on it still works: the list does not grow.
    const more = addItem(full, { id: 'Item3', level: 1, from: 0, qty: 4 }, LATER);
    expect(more.added).toBe(true);
    expect(more.state.items[3]?.qty).toBe(5);
  });

  it('caps the quantity a target can reach', () => {
    const state = addItem(planOf([{ ...nails, qty: MAX_ITEM_QTY - 5 }]), nails, NOW).state;
    expect(state.items).toEqual([{ ...nails, qty: MAX_ITEM_QTY }]);
  });

  it('clamps what it is given as reading does, and refuses what it cannot read', () => {
    expect(addItem(EMPTY_PLANNER, { id: 'Karve', level: 9, from: 12, qty: -3 }, NOW).state.items).toEqual([
      { id: 'Karve', level: 9, from: 8, qty: 1 },
    ]);
    expect(addItem(EMPTY_PLANNER, { id: '', level: 1, from: 0, qty: 1 }, NOW)).toEqual({ state: EMPTY_PLANNER, added: false });
    expect(addItem(EMPTY_PLANNER, { ...sword, qty: Number.NaN }, NOW).added).toBe(false);
  });

  it('never changes the state it was given', () => {
    const state = planOf([sword], { Wood: 1 });
    const copy = structuredClone(state);
    addItem(state, sword, LATER);
    addItem(state, nails, LATER);
    expect(state).toEqual(copy);
  });
});

describe('updateItem and removeItem', () => {
  const state = planOf([sword, nails], { Wood: 3 });

  it('changes one target and stamps the change', () => {
    const next = updateItem(state, 1, { qty: 40 }, LATER);
    expect(next.items).toEqual([sword, { ...nails, qty: 40 }]);
    expect(next.have).toEqual({ Wood: 3 });
    expect(next.at).toBe(LATER);
  });

  it('keeps the level owned below the level asked for', () => {
    const owned = updateItem(state, 0, { from: 3 }, NOW);
    expect(owned.items[0]).toEqual({ ...sword, from: 3 });
    expect(updateItem(owned, 0, { level: 2 }, NOW).items[0]).toEqual({ ...sword, level: 2, from: 1 });
  });

  it('ignores an index that is not there and a value that is not a number', () => {
    expect(updateItem(state, 5, { qty: 2 }, LATER)).toBe(state);
    expect(updateItem(state, -1, { qty: 2 }, LATER)).toBe(state);
    expect(updateItem(state, 0, { level: Number.NaN }, LATER)).toBe(state);
  });

  it('removes one target', () => {
    expect(removeItem(state, 0, LATER)).toEqual({ ...state, items: [nails], at: LATER });
    expect(removeItem(state, 2, LATER)).toBe(state);
  });
});

describe('a shared list', () => {
  const mine = planOf([sword, nails], { Wood: 3 });

  it('adds into mine target by target, the way addItem does', () => {
    const merged = mergeItems(mine, [{ ...nails, qty: 40 }, { id: 'Karve', level: 1, from: 0, qty: 1 }], LATER);
    expect(merged.items).toEqual([sword, { ...nails, qty: 60 }, { id: 'Karve', level: 1, from: 0, qty: 1 }]);
    expect(merged.have).toEqual({ Wood: 3 });
    expect(merged.at).toBe(LATER);
  });

  it('adds only what fits', () => {
    const almostFull = planOf(Array.from({ length: MAX_PLAN_ITEMS - 1 }, (_, i) => ({ id: `Item${i}`, level: 1, from: 0, qty: 1 })));
    const merged = mergeItems(almostFull, [sword, nails, { id: 'Item0', level: 1, from: 0, qty: 2 }], LATER);
    expect(merged.items).toHaveLength(MAX_PLAN_ITEMS);
    expect(merged.items.at(-1)).toEqual(sword);
    expect(merged.items[0]?.qty).toBe(3);
  });

  it('replaces my targets and keeps what I hold', () => {
    const replaced = replaceItems(mine, [{ id: 'Karve', level: 1, from: 0, qty: 1 }, { id: 'Karve', level: 1, from: 0, qty: 1 }], LATER);
    expect(replaced).toEqual({ v: 1, items: [{ id: 'Karve', level: 1, from: 0, qty: 2 }], have: { Wood: 3 }, at: LATER });
  });
});

describe('setHave and clearPlan', () => {
  const state = planOf([sword], { Wood: 3 });

  it('records a count, and deletes it at zero or below', () => {
    expect(setHave(state, 'Iron', 20, LATER)).toEqual({ ...state, have: { Wood: 3, Iron: 20 }, at: LATER });
    expect(setHave(state, 'Wood', 0, LATER).have).toEqual({});
    expect(setHave(state, 'Wood', -4, LATER).have).toEqual({});
  });

  it('counts whole items, up to the cap', () => {
    expect(setHave(state, 'Wood', 7.8, LATER).have).toEqual({ Wood: 7 });
    expect(setHave(state, 'Wood', MAX_HAVE * 10, LATER).have).toEqual({ Wood: MAX_HAVE });
  });

  it('ignores a count that is not a number, an unusable id, and a change that changes nothing', () => {
    expect(setHave(state, 'Wood', Number.NaN, LATER)).toBe(state);
    expect(setHave(state, 'Wood', Number.POSITIVE_INFINITY, LATER)).toBe(state);
    expect(setHave(state, '', 3, LATER)).toBe(state);
    expect(setHave(state, 'Wood', 3, LATER)).toBe(state);
    expect(setHave(state, 'Iron', 0, LATER)).toBe(state);
  });

  it('empties the list and keeps what the reader holds', () => {
    expect(clearPlan(state, LATER)).toEqual({ v: 1, items: [], have: { Wood: 3 }, at: LATER });
  });
});

describe('plannerStore', () => {
  it('keeps the list under its versioned key', () => {
    expect(PLANNER_KEY).toBe('wv-craft-v1');
    expect(plannerStore.key).toBe(PLANNER_KEY);
  });

  it('reads an empty plan where there is no storage, as on the server', () => {
    expect(plannerStore.read()).toEqual(EMPTY_PLANNER);
    expect(plannerStore.read()).toBe(plannerStore.read());
  });
});
