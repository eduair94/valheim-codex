import { describe, expect, it } from 'vitest';
import { comparability } from '@/lib/db/wiki-repo';

/**
 * Column ranking for the comparison table.
 *
 * Ordering by how often a field appears put "Internal ID" in the first column:
 * every item has one, and none of them help you choose a weapon. These are the
 * shapes that decide whether a column earns its place, and a score of zero
 * keeps a column out of the table.
 */
describe('comparability', () => {
  it('rates numeric columns highest, because they rank the rows', () => {
    expect(comparability(['55', '73', '110', '20'])).toBe(3);
    expect(comparability(['0.8', '1.2', '2.0'])).toBe(3);
    // A number with a unit still ranks.
    expect(comparability(['55 slash', '73 slash', '110 pierce'])).toBe(3);
    // So does a number with its alternatives, one per line.
    expect(comparability(['21 (0 skill)\n31.5 (100 skill)', '2 (0 skill)\n3 (100 skill)'])).toBe(3);
  });

  it('rates a repeated categorical value in the middle, because it groups them', () => {
    expect(comparability(['Sword', 'Sword', 'Axe', 'Axe'])).toBe(2);
    expect(comparability(['One-handed', 'Two-handed', 'One-handed', 'One-handed'])).toBe(2);
    // Mostly one entry, as Creatures' "Weak to (x1.5)" is.
    expect(comparability(['Fire', 'Pierce', 'Fire', 'Fire, Spirit', 'Pierce', 'Fire'])).toBe(2);
  });

  it('leaves out an identifier, one word that differs on every row', () => {
    // "Internal ID": the row header already says which item it is.
    expect(comparability(['SwordIron', 'AxeBronze', 'SpearFlint', 'BowFine'])).toBe(0);
    expect(comparability(['FeastAshlands_Material', 'AsksvinMeat', 'BjornMeat', 'CookedBjornMeat', 'Bread'])).toBe(0);
    // A creature's is often its plain name; over enough rows, unique still says identifier.
    const creatures = ['Troll', 'Deathsquito', 'Abomination', 'Boar', 'Neck', 'Greyling', 'Draugr', 'Wraith', 'Lox', 'Serpent'];
    expect(comparability(creatures)).toBe(0);
    // A point of interest can have several, and a pot one per size.
    expect(
      comparability([
        'AbandonedLogCabin02; AbandonedLogCabin03; AbandonedLogCabin04',
        'WoodHouse1; WoodHouse2',
        'Crypt3',
        'StoneTowerRuins04; StoneTowerRuins05',
        'piece_pot3 (small); piece_pot1 (medium); piece_pot2 (large)',
        'TrollCave02',
      ]),
    ).toBe(0);
  });

  it('keeps a word column that only differs on every row because the rows are few', () => {
    // Two creatures from two biomes: no identifier, just a small table.
    expect(comparability(['Swamp', 'Plains'])).toBe(0.4);
    expect(comparability(['Swamp', 'Plains', 'Mountain', 'Meadows'])).toBe(0.4);
  });

  it('leaves out a description, a sentence that differs on every row', () => {
    // Food's descriptions: a median of 42 characters, every one a sentence.
    expect(
      comparability([
        'Smells a bit smokey, even when raw.',
        'Tastes like victory.',
        'This fatty meat was once meant to sustain a body through hibernation.',
        'Keep it warm to see what comes out.',
      ]),
    ).toBe(0);
    // Past 40 characters, whatever the punctuation.
    expect(
      comparability([
        'a long run of words that never stops to end a sentence',
        'another long run of words that does not stop either',
        'and a third one that goes on and on past forty letters',
      ]),
    ).toBe(0);
  });

  it('leaves out a column of lists, which neither ranks nor groups', () => {
    // Drops and abilities, one entry per line as values are stored.
    expect(comparability(['Coins\nTroll hide\nTroll trophy', 'Deathsquito trophy\nNeedle', 'Guck\nRoot'])).toBe(0);
    // Resistances as the wiki writes them; the same few lists repeat, and still read as paragraphs.
    expect(
      comparability(['Spirit, Chop, Pickaxe', 'Spirit, Chop, Pickaxe', 'Frost, Poison, Spirit, Chop, Pickaxe', 'Spirit, Chop, Pickaxe']),
    ).toBe(0);
    // Rows stored before values kept their lines joined entries with "; ".
    expect(comparability(['Swing (7s); Slam (8s)', 'Shoot; Melee', 'Bite'])).toBe(0);
  });

  it('leaves out a recipe that puts its quantities first, which only looks like a number', () => {
    // The armor pieces' "Crafting Materials", a different one on every row.
    const recipes = Array.from({ length: 12 }, (_, i) => `${10 + i} Linen thread\n${i + 2} Leather scraps`);
    expect(comparability(recipes)).toBe(0);
    // Block armor in alternatives repeats from weapon to weapon, and ranks.
    const blockArmor = Array.from({ length: 12 }, (_, i) => `${i % 3 ? 21 : 2} (0 skill)\n${i % 3 ? 31.5 : 3} (100 skill)`);
    expect(comparability(blockArmor)).toBe(3);
  });

  it('leaves out a column with one value on every row, which neither ranks nor groups', () => {
    // Food's "Teleportable": Yes, 77 times out of 77.
    expect(comparability(['Yes', 'Yes', 'Yes'])).toBe(0);
    // Mead's stack and weight, numbers that are the same for every mead.
    expect(comparability(Array.from({ length: 20 }, () => '10'))).toBe(0);
    expect(comparability([' 1.0', '1.0 '])).toBe(0);
    // One row that differs is enough to rank or group.
    expect(comparability(['2', '2', '1'])).toBe(3);
    expect(comparability(['Yes', 'Yes', 'No', 'Yes'])).toBe(2);
  });

  it('ranks any other string that differs on every row last, but keeps it', () => {
    expect(comparability(['Deer trophy', 'Ancient seed', 'Wither bone', 'Dragon egg'])).toBe(0.4);
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
