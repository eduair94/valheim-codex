import { describe, expect, it } from 'vitest';
import { parseProgress } from '@/components/wiki/guide/guide-progress';

/**
 * What survives in localStorage is whatever an older version of the page, an
 * extension or a hand edit left there. Reading it must never throw, and must
 * never tick a box the page does not have.
 */
describe('parseProgress', () => {
  const known = new Set(['c-bosses', 'm-wood', 'ml-x1']);

  it('restores the ticks the page still has', () => {
    expect([...parseProgress('["m-wood","ml-x1"]', known)]).toEqual(['m-wood', 'ml-x1']);
  });

  it('drops ids the page no longer has, and anything that is not an id', () => {
    expect([...parseProgress('["m-wood","gone",3,null,{"id":"c-bosses"}]', known)]).toEqual(['m-wood']);
  });

  it('starts empty from nothing, from broken JSON and from the wrong shape', () => {
    for (const raw of [null, '', 'not json', '{"m-wood":true}', '"m-wood"', '42']) {
      expect(parseProgress(raw, known).size, String(raw)).toBe(0);
    }
  });
});
