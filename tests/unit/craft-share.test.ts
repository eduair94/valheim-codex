import { describe, expect, it } from 'vitest';
import { MAX_PLAN_ITEMS, type PlanItem } from '@/lib/craft/planner-store';
import { decodeShare, encodeShare, MAX_SHARE_ITEMS, MAX_SHARE_LENGTH, SHARE_PARAM, sharedCount } from '@/lib/craft/share';
import { craftHref } from '@/lib/routes';

/*
 * A list travels as a link: `/wiki/craft?l=SwordIron.4.0.1~BronzeNails.1.0.20`
 * (id, level, level owned, quantity). Links get edited, truncated by chat
 * apps and pasted with garbage: decoding keeps every part it can read, caps
 * how much it reads, and never throws.
 */

const items: PlanItem[] = [
  { id: 'SwordIron', level: 4, from: 2, qty: 1 },
  { id: 'page:wood-structures#wood-wall.2~x', level: 1, from: 0, qty: 30 },
];

/** The param as a page reads it from the address `craftHref` builds: decoded once, by the URL. */
function throughTheAddressBar(share: string): string | null {
  return new URL(craftHref(share), 'https://codex.example').searchParams.get(SHARE_PARAM);
}

describe('encodeShare', () => {
  it('writes a list as the address shows it', () => {
    expect(
      encodeShare([
        { id: 'SwordIron', level: 4, from: 0, qty: 1 },
        { id: 'BronzeNails', level: 1, from: 0, qty: 20 },
      ]),
    ).toBe('SwordIron.4.0.1~BronzeNails.1.0.20');
    expect(encodeShare([])).toBe('');
  });

  it('escapes what would split an id', () => {
    expect(encodeShare([items[1]!])).toBe('page%3Awood-structures%23wood-wall%2E2%7Ex.1.0.30');
  });

  it('carries a full list whole', () => {
    // A list the planner keeps travels whole: the backup the "not saved" note offers.
    expect(MAX_SHARE_ITEMS).toBe(MAX_PLAN_ITEMS);
    const full = Array.from({ length: MAX_PLAN_ITEMS }, (_, i) => ({ id: `piece_workbench_ext${i}`, level: 3, from: 1, qty: 9999 }));
    expect(decodeShare(encodeShare(full))).toEqual(full);
    expect(sharedCount(full)).toBe(MAX_PLAN_ITEMS);
  });

  it('writes no more items than a link is read for', () => {
    const many = Array.from({ length: MAX_SHARE_ITEMS + 10 }, (_, i) => ({ id: `Item${i}`, level: 1, from: 0, qty: 1 }));
    const decoded = decodeShare(encodeShare(many));
    expect(decoded).toEqual(many.slice(0, MAX_SHARE_ITEMS));
    expect(sharedCount(many)).toBe(MAX_SHARE_ITEMS);
  });

  it('stops before a link grows too long to be read back, and says how many it carries', () => {
    // Forty ids of 120 accented letters would be 28,960 characters escaped.
    const long = Array.from({ length: 40 }, (_, i) => ({ id: `${i}`.padEnd(120, 'ñ'), level: 1, from: 0, qty: 1 }));
    const share = encodeShare(long);
    expect(share.length).toBeLessThanOrEqual(MAX_SHARE_LENGTH);
    const decoded = decodeShare(share);
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded).toEqual(long.slice(0, decoded.length));
    // The planner says the link holds only part of the list.
    expect(sharedCount(long)).toBe(decoded.length);
    expect(sharedCount(long)).toBeLessThan(long.length);
  });

  it('counts what a link carries of a list that fits', () => {
    expect(sharedCount(items)).toBe(2);
    expect(sharedCount([])).toBe(0);
    // An item no link can carry is left out, and not counted.
    expect(sharedCount([{ id: '', level: 1, from: 0, qty: 1 }, items[0]!])).toBe(1);
  });

  it('leaves out an item it could not read back', () => {
    expect(encodeShare([{ id: '', level: 1, from: 0, qty: 1 }, items[0]!])).toBe('SwordIron.4.2.1');
  });
});

describe('decodeShare', () => {
  it('round-trips a share link with awkward ids', () => {
    expect(decodeShare(encodeShare(items))).toEqual(items);
    const odd = [
      { id: '100% chance', level: 1, from: 0, qty: 2 },
      { id: 'Hidromiel de resistencia al veneno', level: 1, from: 0, qty: 6 },
      { id: 'a.b~c:d#e%f&g=h+i', level: 3, from: 1, qty: 9999 },
    ];
    expect(decodeShare(encodeShare(odd))).toEqual(odd);
  });

  it('survives the address bar, which decodes the param once before the page reads it', () => {
    for (const list of [items, [{ id: '100%25 sure', level: 2, from: 1, qty: 3 }]]) {
      expect(decodeShare(throughTheAddressBar(encodeShare(list)))).toEqual(list);
    }
  });

  it('keeps the valid parts of an edited link', () => {
    expect(decodeShare('SwordIron.4.0.1~~garbage~BronzeNails.1.0.20.7~Karve.a.b.c')).toEqual([
      { id: 'SwordIron', level: 4, from: 0, qty: 1 },
    ]);
  });

  it('drops an entry with five parts whole, rather than guessing which four are meant', () => {
    expect(decodeShare('BronzeNails.1.0.20.7')).toEqual([]);
  });

  it('clamps numbers the way the stored list does', () => {
    expect(decodeShare('SwordIron.99.120.1~Karve.0.0.0~BronzeNails.1.0.123456')).toEqual([
      { id: 'SwordIron', level: 20, from: 19, qty: 1 },
      { id: 'Karve', level: 1, from: 0, qty: 1 },
      { id: 'BronzeNails', level: 1, from: 0, qty: 9999 },
    ]);
  });

  it('drops numbers that are not plain digits', () => {
    for (const part of ['A.-1.0.1', 'A.1.0.1e3', 'A.1.0.+1', 'A.1.0.1.5', 'A.1. 0.1', 'A.1.0.', 'A.1.0.12345678901234567890']) {
      expect(decodeShare(part), part).toEqual([]);
    }
  });

  it('drops an id it cannot unescape, an empty one and one too long', () => {
    expect(decodeShare('abc%E0%A4%A.1.0.1~%ZZ.1.0.1~.1.0.1~ok.1.0.1')).toEqual([{ id: 'ok', level: 1, from: 0, qty: 1 }]);
    expect(decodeShare(`${'x'.repeat(121)}.1.0.1`)).toEqual([]);
  });

  it('caps a long link', () => {
    // 500 parts of seven characters, 3,999 in all: read up to the cap.
    const parts = Array.from({ length: 500 }, () => 'a.1.0.1').join('~');
    expect(parts.length).toBeLessThanOrEqual(MAX_SHARE_LENGTH);
    expect(decodeShare(parts)).toHaveLength(MAX_SHARE_ITEMS);
    // Past the length nothing is read: no link this app makes is that long.
    const long = `SwordIron.4.0.1~${'x'.repeat(5000)}`;
    expect(decodeShare(long)).toEqual([]);
  });

  it('reads nothing from nothing', () => {
    expect(decodeShare(null)).toEqual([]);
    expect(decodeShare(undefined)).toEqual([]);
    expect(decodeShare('')).toEqual([]);
    expect(decodeShare('~~~')).toEqual([]);
  });

  it('never throws, whatever the link holds', () => {
    const junk = ['%', '%%%', '~%~', '.', '...', '\u0000.1.0.1', '💥.1.0.1', '\uD800.1.0.1', 'a'.repeat(4000), '%E0%A4%A.%.%.%'];
    for (const param of junk) expect(() => decodeShare(param), param).not.toThrow();
    // A lone surrogate cannot be written back into a link, so it is not read either.
    expect(decodeShare('%ED%A0%80.1.0.1')).toEqual([]);
    expect(decodeShare('💥.1.0.1')).toEqual([{ id: '💥', level: 1, from: 0, qty: 1 }]);
  });
});
