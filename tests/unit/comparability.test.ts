import { describe, expect, it } from 'vitest';
import { comparability } from '@/lib/db/wiki-repo';

/**
 * Column ranking for the comparison table.
 *
 * Ordering by how often a field appears put "Internal ID" in the first column:
 * every item has one, and none of them help you choose a weapon. These are the
 * three shapes that decide whether a column earns its place.
 */
describe('comparability', () => {
  it('rates numeric columns highest, because they rank the rows', () => {
    expect(comparability(['55', '73', '110', '20'])).toBe(3);
    expect(comparability(['0.8', '1.2', '2.0'])).toBe(3);
    // A number with a unit still ranks.
    expect(comparability(['55 slash', '73 slash', '110 pierce'])).toBe(3);
  });

  it('rates a repeated categorical value in the middle, because it groups them', () => {
    expect(comparability(['Sword', 'Sword', 'Axe', 'Axe'])).toBe(2);
    expect(comparability(['One-handed', 'Two-handed', 'One-handed', 'One-handed'])).toBe(2);
  });

  it('rates a distinct string per row lowest, because that is identity', () => {
    // "Internal ID": unique per row, and the row header already identifies it.
    expect(comparability(['SwordIron', 'AxeBronze', 'SpearFlint', 'BowFine'])).toBe(0.4);
  });

  it('treats a mostly-numeric column as numeric', () => {
    expect(comparability(['55', '73', 'varies'])).toBe(3);
  });

  it('treats a barely-numeric column as text', () => {
    expect(comparability(['n/a', 'unknown', 'varies', '3'])).toBeLessThan(3);
  });

  it('scores an empty column at zero rather than dividing by zero', () => {
    expect(comparability([])).toBe(0);
  });

  it('ranks a stat above an identifier for the same frequency', () => {
    const stat = comparability(['200', '250', '300', '350']);
    const identity = comparability(['SwordIron', 'AxeBronze', 'SpearFlint', 'BowFine']);
    expect(stat).toBeGreaterThan(identity);
  });
});
