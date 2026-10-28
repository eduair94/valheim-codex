import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { describe, expect, it } from 'vitest';
import { nestedTableLabel, nestedTables, readNotice, readTableGrid } from '@/lib/wiki/table';

/**
 * The shapes here are the wiki's own, cut down: each one is a table that the
 * position-based reader got wrong in production (see BWR-07).
 */

function grid(html: string) {
  const $ = cheerio.load(html);
  return readTableGrid($, $('table').first().get(0) as Element);
}

function notice(html: string) {
  const $ = cheerio.load(html);
  return readNotice($, $('table').first().get(0) as Element);
}

const ICON = (name: string, size = 30) =>
  `<a href="/wiki/${name}" title="${name}"><img alt="${name}" src="https://static.example/${name}.png/revision/latest/scale-to-width-down/${size}" width="${size}" height="${size}"></a>`;

describe('readTableGrid — headers', () => {
  it('merges a second header row into the labels a span above it opened', () => {
    // Birch "Drops": Amount/Item/Chance span two rows, "Average per Tree" spans
    // four columns, and G1–Y2 sit under it. The old reader kept only the
    // first row and left four blank labels.
    const t = grid(`<table>
      <tr><th rowspan="2">Amount</th><th rowspan="2">Item</th><th rowspan="2">Chance</th><th colspan="4">Average per Tree</th></tr>
      <tr><th>G1</th><th>G2</th><th>Y1</th><th>Y2</th></tr>
      <tr><td>2</td><td>Large Birch Logs</td><td>100%</td><td>2</td><td>2</td><td>2</td><td>2</td></tr>
    </table>`)!;

    expect(t.headers).toEqual([
      'Amount', 'Item', 'Chance',
      'Average per Tree › G1', 'Average per Tree › G2', 'Average per Tree › Y1', 'Average per Tree › Y2',
    ]);
    expect(t.rows).toEqual([['2', 'Large Birch Logs', '100%', '2', '2', '2', '2']]);
  });

  it('reads a following th row as data when no span opened slots for it', () => {
    // Planting tables mark the biomes a tree grows in with th. Read as headers,
    // only the biomes it does *not* grow in survived.
    const t = grid(`<table><caption>Allowed Biomes:</caption>
      <tr><th>Meadows</th><th>Yes</th></tr>
      <tr><th>Black Forest</th><th>Yes</th></tr>
      <tr><td>Swamp</td><td>No</td></tr>
      <tr><th>Plains</th><th>Yes</th></tr>
    </table>`)!;

    expect(t.caption).toBe('Allowed Biomes:');
    expect(t.headers).toEqual([]);
    expect(t.rows).toEqual([
      ['Meadows', 'Yes'],
      ['Black Forest', 'Yes'],
      ['Swamp', 'No'],
      ['Plains', 'Yes'],
    ]);
  });

  it('skips a header row that a long table repeats, instead of losing its header', () => {
    const t = grid(`<table>
      <tr><th>Name</th><th>Damage</th></tr>
      <tr><td>Club</td><td>12</td></tr>
      <tr><th>Name</th><th>Damage</th></tr>
      <tr><td>Torch</td><td>4</td></tr>
    </table>`)!;
    expect(t.headers).toEqual(['Name', 'Damage']);
    expect(t.rows).toEqual([['Club', '12'], ['Torch', '4']]);
  });

  it('promotes a first row of ordinary cells when the table has no th at all', () => {
    // Boar "Breeding", Controls, Crafting: the header is a plain first row.
    const t = grid(`<table>
      <tr><td>Creature</td><td>Required love points</td><td>Pregnancy<br>duration</td></tr>
      <tr><td>Boar</td><td>3</td><td>1 minute</td></tr>
    </table>`)!;
    expect(t.headers).toEqual(['Creature', 'Required love points', 'Pregnancy duration']);
    expect(t.rows).toEqual([['Boar', '3', '1 minute']]);
  });

  it.each([
    ['bold', '<td><b>Type</b></td><td><b>Drops</b></td>', '<td>Berry</td><td>Raspberries</td>'],
    ['capitals', '<td>NAME</td><td>SOURCE</td><td>UPGRADE 1 COST (craft lvl+1)</td>', '<td>Club</td><td>inventory</td><td>5 bone fragments</td>'],
    ['level numbers', '<td>Quality</td><td>1</td><td>2</td><td>3</td>', '<td>Durability</td><td>200</td><td>400</td><td>600</td>'],
  ])('promotes a th-less first row set apart by %s', (_, head, body) => {
    // Bushes, Crafting and Hoe: the three other ways the wiki's plain tables
    // mark their header row.
    const t = grid(`<table><tr>${head}</tr><tr>${body}</tr></table>`)!;
    expect(t.headers).not.toEqual([]);
    expect(t.rows).toHaveLength(1);
  });

  it('reads a th-less first row as data when nothing sets it apart', () => {
    // Promoted, "Meadows" became the label of every biome and "Carrot" of
    // every food, and the index said a wolf's "Meadows" was "Mountain".
    const t = grid(`<table>
      <tr><td>Boar</td><td>Meadows</td><td>Carrot</td></tr>
      <tr><td>Wolf</td><td>Mountain</td><td>Raw meat</td></tr>
      <tr><td>Lox</td><td>Plains</td><td>Cloudberries</td></tr>
    </table>`)!;
    expect(t.headers).toEqual([]);
    expect(t.rows.map((r) => r[0])).toEqual(['Boar', 'Wolf', 'Lox']);
  });

  it('does not promote a key and its value', () => {
    const t = grid('<table><tr><td>Health</td><td>500</td></tr><tr><td>Damage</td><td>30</td></tr></table>')!;
    expect(t.headers).toEqual([]);
    expect(t.rows).toHaveLength(2);
    // Not even in bold, or as a quality level.
    expect(grid('<table><tr><td><b>Health</b></td><td><b>500</b></td></tr><tr><td>Damage</td><td>30</td></tr></table>')!.headers).toEqual([]);
    expect(grid('<table><tr><td>Quality</td><td>1</td></tr><tr><td>Durability</td><td>200</td></tr></table>')!.headers).toEqual([]);
  });

  it('keeps th rows under a column-spanning header as data unless they only label its parts', () => {
    // A "Comfort" cell over two columns made every following th row one more
    // level of header, until none was left and the table vanished.
    const t = grid(`<table>
      <tr><th>Biome</th><th colspan="2">Comfort</th></tr>
      <tr><th>Meadows</th><th>1</th><th>2</th></tr>
      <tr><th>Swamp</th><th>3</th><th>4</th></tr>
    </table>`)!;
    expect(t.headers).toEqual(['Biome', 'Comfort', 'Comfort']);
    expect(t.rows).toEqual([['Meadows', '1', '2'], ['Swamp', '3', '4']]);

    // Labels under the split columns alone are a second level of header.
    const stacked = grid(`<table>
      <tr><th>Name</th><th colspan="2">Damage</th></tr>
      <tr><th></th><th>Slash</th><th>Pierce</th></tr>
      <tr><td>Sword</td><td>35</td><td>0</td></tr>
    </table>`)!;
    expect(stacked.headers).toEqual(['Name', 'Damage › Slash', 'Damage › Pierce']);
    expect(stacked.rows).toEqual([['Sword', '35', '0']]);
  });

  it('never lets a header take every row', () => {
    const t = grid(`<table>
      <tr><th rowspan="3">Meadows</th><th>Boar</th></tr>
      <tr><th>Deer</th></tr>
      <tr><th>Neck</th></tr>
    </table>`);
    expect(t).not.toBeNull();
    expect(t!.rows.map((r) => r.at(-1))).toEqual(['Deer', 'Neck']);
  });

  it('keeps the header above a closing Total row of th cells', () => {
    // Read as a sign that the table writes its data in th, the Total row used
    // to wipe the real header and turn "Piece | Materials" into a row.
    const t = grid(`<table>
      <tr><th>Piece</th><th>Materials</th></tr>
      <tr><td>Forge cooler</td><td>25 Finewood</td></tr>
      <tr><td>Anvils</td><td>5 Wood</td></tr>
      <tr><th>Total</th><th>30 Wood</th></tr>
    </table>`)!;
    expect(t.headers).toEqual(['Piece', 'Materials']);
    expect(t.rows.at(-1)).toEqual(['Total', '30 Wood']);
  });

  it('skips a stacked header that a long table repeats, and keeps it', () => {
    const t = grid(`<table>
      <tr><th rowspan="2">Name</th><th colspan="2">Damage</th></tr>
      <tr><th>Blunt</th><th>Slash</th></tr>
      <tr><td>Club</td><td>12</td><td>0</td></tr>
      <tr><th rowspan="2">Name</th><th colspan="2">Damage</th></tr>
      <tr><th>Blunt</th><th>Slash</th></tr>
      <tr><td>Axe</td><td>0</td><td>20</td></tr>
    </table>`)!;
    expect(t.headers).toEqual(['Name', 'Damage › Blunt', 'Damage › Slash']);
    expect(t.rows).toEqual([['Club', '12', '0'], ['Axe', '0', '20']]);
  });

  it('reads the th rows of a one-column table as headings over the lines below them', () => {
    // Hugin and Munin: each line of dialogue under the event that prompts it.
    // As the table's header, "Welcome" labelled every line of the table.
    const t = grid(`<table>
      <tr><th>Welcome</th></tr><tr><td>Welcome to the tenth world, warrior</td></tr>
      <tr><th>Vegvisirs</th></tr><tr><td>This stone is a Vegvisir</td></tr>
    </table>`)!;
    expect(t.headers).toEqual([]);
    expect(t.groupRows).toEqual([0, 2]);
    expect(t.rows).toEqual([
      ['Welcome'], ['Welcome to the tenth world, warrior'], ['Vegvisirs'], ['This stone is a Vegvisir'],
    ]);
  });

  it('takes a lone full-width th above everything as the caption', () => {
    const t = grid(`<table>
      <tr><th colspan="2">Creature Feeding Habit</th></tr>
      <tr><th>Creature</th><th>Required Food</th></tr>
      <tr><td>Boar</td><td>Carrot</td></tr>
    </table>`)!;
    expect(t.caption).toBe('Creature Feeding Habit');
    expect(t.headers).toEqual(['Creature', 'Required Food']);
  });

  it('never invents "Column N" labels', () => {
    const t = grid('<table><tr><td>a</td><td>1</td></tr></table>')!;
    expect(t.headers).toEqual([]);
    expect(JSON.stringify(t)).not.toMatch(/Column \d/);
  });

  it('reads a header line break as a space', () => {
    const t = grid('<table><tr><th>Damage Types<br>(Min/Max)</th></tr><tr><td>Pierce: 22/31</td></tr></table>')!;
    expect(t.headers).toEqual(['Damage Types (Min/Max)']);
  });
});

describe('readTableGrid — spans and columns', () => {
  it('puts a colspan total under the column it still covers, and drops the icon column', () => {
    // Forge: the Icon column is pictures only. The Total row starts in it with
    // colspan=2, which kept the column alive and put the totals under "Name".
    const t = grid(`<table>
      <tr><th>Icon</th><th>Name</th><th>Materials</th></tr>
      <tr><td>${ICON('Forge Cooler', 64)}</td><td>Forge Cooler</td><td><p>25 Finewood<br>10 Copper</p></td></tr>
      <tr><td>${ICON('Anvils', 64)}</td><td>Anvils</td><td><p>5 Wood<br>2 Bronze</p></td></tr>
      <tr><th colspan="2">Total (Forge included)</th><td>30 Wood<br>12 Copper</td></tr>
    </table>`)!;

    expect(t.headers).toEqual(['Name', 'Materials']);
    expect(t.rows).toEqual([
      ['Forge Cooler', '25 Finewood\n10 Copper'],
      ['Anvils', '5 Wood\n2 Bronze'],
      ['Total (Forge included)', '30 Wood\n12 Copper'],
    ]);
  });

  it('puts a colspan value once, in the first slot, so later values keep their columns', () => {
    const t = grid(`<table>
      <tr><th>Amount</th><th>Item</th><th>Chance</th><th>G1</th><th>G2</th></tr>
      <tr><td>1-2</td><td>Resin</td><td>25%</td><td>0.375</td><td>0.18</td></tr>
      <tr><th colspan="3">...where X equals:</th><td>2</td><td>1</td></tr>
    </table>`)!;
    expect(t.rows[1]).toEqual(['...where X equals:', '', '', '2', '1']);
  });

  it('copies a rowspan value into every row it covers', () => {
    // Each card on a phone, and each row in the index, is read on its own.
    const t = grid(`<table>
      <tr><th>Instance</th><th>Type</th><th>Amount</th></tr>
      <tr><td rowspan="2">SunkenCrypt4</td><td>Draugr</td><td>30%</td></tr>
      <tr><td>Oozer</td><td>30%</td></tr>
    </table>`)!;
    expect(t.rows).toEqual([
      ['SunkenCrypt4', 'Draugr', '30%'],
      ['SunkenCrypt4', 'Oozer', '30%'],
    ]);
  });

  it('keeps a full-width row as a group heading', () => {
    const t = grid(`<table>
      <tr><th>Name</th><th>Damage</th></tr>
      <tr><th colspan="2">One-handed</th></tr>
      <tr><td>Bronze sword</td><td>35</td></tr>
    </table>`)!;
    expect(t.groupRows).toEqual([0]);
    expect(t.rows).toEqual([['One-handed', ''], ['Bronze sword', '35']]);
  });

  it('never absorbs a full-width group row into a stacked header', () => {
    const t = grid(`<table>
      <tr><th rowspan="2">Name</th><th colspan="2">Velocity</th></tr>
      <tr><th>Min</th><th>Max</th></tr>
      <tr><th colspan="3">Bows</th></tr>
      <tr><td>Crude bow</td><td>2</td><td>35</td></tr>
    </table>`)!;
    expect(t.headers).toEqual(['Name', 'Velocity › Min', 'Velocity › Max']);
    expect(t.groupRows).toEqual([0]);
    expect(t.rows[1]).toEqual(['Crude bow', '2', '35']);
  });

  it('names what a list of pictures shows, but drops a lone icon next to its own name', () => {
    // Weapons lists each category's weapons only as icons; Bows has one icon
    // per row beside the bow's name.
    const weapons = grid(`<table>
      <tr><th colspan="2">Melee</th></tr>
      <tr><td>Axes</td><td>${ICON('Stone Axe', 48)}${ICON('Flint Axe', 48)}</td></tr>
    </table>`)!;
    expect(weapons.caption).toBe('Melee');
    expect(weapons.rows).toEqual([['Axes', 'Stone Axe\nFlint Axe']]);

    const bows = grid(`<table>
      <tr><th>Name</th><th>Icon</th><th>Stamina</th></tr>
      <tr><td>Crude bow</td><td>${ICON('Crude Bow', 64)}</td><td>4 / s</td></tr>
      <tr><td>Finewood bow</td><td>${ICON('Crow 0S', 64)}</td><td>6 / s</td></tr>
    </table>`)!;
    expect(bows.headers).toEqual(['Name', 'Stamina']);
  });

  it('fills a "same as above" row heading only when the table starts with one', () => {
    const spawns = grid(`<table>
      <tr><th>Biome</th><th>Place</th></tr>
      <tr><td>Meadows</td><td>Boar runestone</td></tr>
      <tr><td></td><td>Stone Grave</td></tr>
      <tr><td>Black Forest</td><td>Burial grounds</td></tr>
      <tr><td></td><td>Small ruins</td></tr>
    </table>`)!;
    expect(spawns.rows.map((r) => r[0])).toEqual(['Meadows', 'Meadows', 'Black Forest', 'Black Forest']);

    // Biomes puts its "Early Game" headings in the second column; a blank
    // first cell there is not a continuation.
    const biomes = grid(`<table>
      <tr><th>Biome</th><th>Description</th></tr>
      <tr><td></td><th>Early Game</th></tr>
      <tr><td>Meadows</td><td>Starting biome</td></tr>
      <tr><td></td><th>Mid Game</th></tr>
    </table>`)!;
    expect(biomes.rows.map((r) => r[0])).toEqual(['', 'Meadows', '']);
  });

  it('keeps every row rectangular', () => {
    const t = grid(`<table>
      <tr><th>A</th><th>B</th><th>C</th></tr>
      <tr><td>1</td></tr>
      <tr><td>2</td><td>x</td><td>y</td></tr>
    </table>`)!;
    for (const row of t.rows) expect(row).toHaveLength(t.headers.length);
  });

  it('reads a malformed span the way a browser does, and caps an absurd one', () => {
    // `colspan="2""` is on the live wiki (Forsaken Altars).
    const t = grid('<table><tr><th colspan="2"">Summoning item</th><th>Biome</th></tr><tr><td>a</td><td>b</td><td>Swamp</td></tr></table>')!;
    expect(t.headers).toEqual(['Summoning item', 'Summoning item', 'Biome']);
    expect(grid('<table><tr><td colspan="100000">x</td></tr><tr><td>y</td></tr></table>')).not.toBeNull();
  });

  it('keeps line breaks inside cells and list items as separate lines', () => {
    const t = grid(`<table>
      <tr><th>Quality</th><th>1</th></tr>
      <tr><th>Crafting</th><td>2 ${ICON('Wood')} Wood<br>20 ${ICON('Iron')} Iron<br>3 Leather scraps</td></tr>
      <tr><th>Notes</th><td><ul><li>First</li><li>Second</li></ul></td></tr>
    </table>`)!;
    expect(t.rows[0]).toEqual(['Crafting', '2 Wood\n20 Iron\n3 Leather scraps']);
    expect(t.rows[1]).toEqual(['Notes', 'First\nSecond']);
  });

  it('returns null for a table with no body rows', () => {
    expect(grid('<table><tr><th>A</th><th>B</th></tr></table>')).toBeNull();
    expect(grid('<table></table>')).toBeNull();
  });
});

describe('nested tables', () => {
  const HTML = `<table id="outer">
    <tr><th>Level 1-50</th><th>Level 51-100</th></tr>
    <tr>
      <td><table><tr><th>Level</th><th>XP</th></tr><tr><td>1</td><td>1.0</td></tr></table></td>
      <td><table><tr><th>Level</th><th>XP</th></tr><tr><td>51</td><td>182.6</td></tr></table></td>
    </tr>
  </table>`;

  it('reads only the table’s own rows, never those of a table in a cell', () => {
    // The Skills page's wrapper table used to gain both inner tables' rows.
    expect(grid(HTML)).toBeNull();
  });

  it('finds the inner tables and the column label each sat under', () => {
    const $ = cheerio.load(HTML);
    const outer = $('#outer').get(0) as Element;
    const inner = nestedTables($, outer);
    expect(inner).toHaveLength(2);
    expect(inner.map((t) => nestedTableLabel($, outer, t))).toEqual(['Level 1-50', 'Level 51-100']);
    expect(readTableGrid($, inner[1]!)!.rows).toEqual([['51', '182.6']]);
  });
});

describe('readNotice', () => {
  const banner = (heading: string, body: string) =>
    `<table style="border:2px solid red"><tbody><tr><td>${ICON('Hammer', 64)}</td><td><span>${heading}</span><br><span>${body}</span></td></tr></tbody></table>`;

  it.each([
    ['This article is a <a href="/wiki/Category:Work_in_progress">work in progress</a>', 'Information may be incomplete.'],
    ['This page is a candidate for deletion', 'Remember to check what links here.'],
    ['This article is a stub', 'You can help Valheim Wiki by expanding it.'],
    ['This article is a disambiguation page for Wood (disambiguation)', 'The following is a list of links.'],
  ])('marks a banner about editing the wiki as maintenance: %s', (heading, body) => {
    expect(notice(banner(heading, body))?.kind).toBe('maintenance');
  });

  it.each([
    ['This article is about <a href="/wiki/Category:Unfinished">unfinished</a> content', 'unfinished'],
    ['This article is about removed content', 'removed'],
    ['This article is for a DLC item or feature.', 'dlc'],
    ['This article is about an upcoming or planned feature', 'upcoming'],
  ])('keeps a banner that says something about the game: %s', (heading, kind) => {
    expect(notice(banner(heading, 'Details.'))?.kind).toBe(kind);
  });

  it('gives the heading a full stop so the lines still read when joined', () => {
    expect(notice(banner('This article is about removed content', 'It was removed.'))?.text).toBe(
      'This article is about removed content.\nIt was removed.',
    );
    expect(notice(banner('This article is for a DLC item or feature.', 'It may not be available.'))?.text).toBe(
      'This article is for a DLC item or feature.\nIt may not be available.',
    );
  });

  it('ignores ordinary tables', () => {
    expect(notice('<table><tr><td>Boar</td><td>3</td></tr></table>')).toBeNull();
    expect(notice('<table><tr><td>This article</td></tr><tr><td>two rows</td></tr></table>')).toBeNull();
  });
});
