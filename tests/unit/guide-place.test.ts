import { describe, expect, it } from 'vitest';
import { PLACE_KEY, readPlace, withoutPlace, withPlace } from '@/components/wiki/guide/guide-place';

/**
 * The reader's place in the guide rides in the history entry's state, next to
 * the router's own keys. Whatever is in that state when the entry comes back
 * — an older build's place, another script's, nothing — must never break the
 * guide or the router.
 */

const ROUTER = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', {}], renderedSearch: '' } };
const PLACE = { y: 10200, w: 390, lang: 'es', sizes: { meadows: 1083.5, mistlands: 1584.2 } };

describe('readPlace', () => {
  it('reads back what the guide wrote', () => {
    expect(readPlace(withPlace(ROUTER, PLACE))).toEqual(PLACE);
  });

  it('finds nothing in an entry the guide never wrote', () => {
    for (const state of [null, undefined, 'x', 3, [], {}, ROUTER, { [PLACE_KEY]: null }, { [PLACE_KEY]: 'x' }]) {
      expect(readPlace(state)).toBeNull();
    }
  });

  it('rejects a place of the wrong shape', () => {
    const bad = [
      { ...PLACE, y: 'top' },
      { ...PLACE, y: Number.NaN },
      { ...PLACE, w: undefined },
      { ...PLACE, lang: 1 },
      { ...PLACE, sizes: [] },
      { ...PLACE, sizes: null },
    ];
    for (const place of bad) expect(readPlace({ [PLACE_KEY]: place }), JSON.stringify(place)).toBeNull();
  });

  it('keeps the element the place is pinned to, and drops one it could not find again', () => {
    const pinned = { ...PLACE, anchor: { id: 'ml-x1', top: 212.5 } };
    expect(readPlace({ [PLACE_KEY]: pinned })?.anchor).toEqual({ id: 'ml-x1', top: 212.5 });
    for (const anchor of [null, 'ml-x1', { id: '', top: 3 }, { id: 'ml-x1' }, { id: 'ml-x1', top: Number.NaN }]) {
      const place = readPlace({ [PLACE_KEY]: { ...PLACE, anchor } });
      expect(place, JSON.stringify(anchor)).not.toBeNull();
      expect(place?.anchor, JSON.stringify(anchor)).toBeUndefined();
    }
  });

  it('drops a size that could not be an element’s height and keeps the rest', () => {
    const place = { ...PLACE, sizes: { meadows: 1083.5, swamp: -4, plains: 0, ashlands: 'tall', mountain: Infinity } };
    expect(readPlace({ [PLACE_KEY]: place })?.sizes).toEqual({ meadows: 1083.5 });
  });
});

describe('withPlace', () => {
  it('keeps the router’s keys, which it needs to restore the page on Back', () => {
    const state = withPlace(ROUTER, PLACE);
    expect(state.__NA).toBe(true);
    expect(state.__PRIVATE_NEXTJS_INTERNALS_TREE).toBe(ROUTER.__PRIVATE_NEXTJS_INTERNALS_TREE);
  });

  it('replaces an older place rather than adding to it', () => {
    const later = { ...PLACE, y: 15480 };
    expect(readPlace(withPlace(withPlace(ROUTER, PLACE), later))?.y).toBe(15480);
  });
});

describe('withoutPlace', () => {
  it('gives an in-page jump the router’s state without the place it was made from', () => {
    const state = withoutPlace(withPlace(ROUTER, PLACE));
    expect(state).toEqual(ROUTER);
    expect(readPlace(state)).toBeNull();
  });
});
