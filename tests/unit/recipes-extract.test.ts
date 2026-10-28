import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractRecipes, type PageRecipes, type RawInfobox } from '@/lib/wiki/recipes';
import { RECIPES_OUTPUT_HASH, RECIPES_VERSION } from '@/lib/wiki/recipes-version';

/**
 * The extractor over saved pages of the live wiki (tests/fixtures/recipes,
 * and the saved pages one directory up). Each page is here for one shape of
 * recipe; see tests/fixtures/recipes/README.md.
 *
 * A wrong number here becomes a wrong shopping list: 80 bronze for a Karve
 * whose 80 nails are four crafts, or a cape without its bone fragments. So
 * the cases pin the exact entries, not just that something was read.
 */

type Saved = { parse: { title: string; text: string } };

async function saved(name: string): Promise<Saved['parse']> {
  const raw = await readFile(`tests/fixtures/${name}.json`, 'utf8');
  return (JSON.parse(raw) as Saved).parse;
}

/** A saved page's recipes, read as the ingest reads them: with the page's title. */
async function recipes(name: string): Promise<PageRecipes> {
  const page = await saved(name);
  return extractRecipes(page.text, { title: page.title });
}

/** `Wood:2`: what an entry links to, or its text when it links nowhere. */
const named = (box: RawInfobox) =>
  box.levels.map((level) => level.entries.map((e) => `${e.link?.title ?? e.text}:${e.qty}`));

/** A page of one infobox whose recipe cell holds `materials`, for shapes no saved page has. */
const box = (materials: string, title = 'Thing') =>
  `<aside class="portable-infobox"><h2 class="pi-title">${title}</h2>` +
  `<div class="pi-item pi-data"><h3 class="pi-data-label">Crafting Materials</h3>` +
  `<div class="pi-data-value">${materials}</div></div></aside>`;

/** A labelled value of an infobox. */
const data = (label: string, value: string) =>
  `<div class="pi-item pi-data"><h3 class="pi-data-label">${label}</h3><div class="pi-data-value">${value}</div></div>`;

/** An infobox with one numbered quality tab per panel, as every upgradeable item has. */
const tabbed = (panels: string[]) =>
  `<aside class="portable-infobox"><h2 class="pi-title">Sword</h2><section class="pi-item pi-panel wds-tabber">` +
  `<div class="wds-tabs__wrapper"><ul class="wds-tabs">` +
  panels.map((_, i) => `<li class="wds-tabs__tab"><div class="wds-tabs__tab-label">${i + 1}</div></li>`).join('') +
  `</ul></div>${panels.map((panel) => `<div class="wds-tab__content">${panel}</div>`).join('')}</section></aside>`;

describe('extractRecipes: items', () => {
  it('reads Iron Sword per quality: step costs and forge levels', async () => {
    const { infoboxes } = await recipes('Iron_Sword');
    expect(infoboxes).toHaveLength(1);
    expect(infoboxes[0]).toMatchObject({ tab: null, internalId: 'SwordIron', source: { text: 'Forge' } });
    expect(
      infoboxes[0]!.levels.map((l) => [
        l.quality,
        l.stationLevel,
        l.entries.map((e) => `${e.link?.title ?? e.text}:${e.qty}`),
      ]),
    ).toEqual([
      [1, 2, ['Wood:2', 'Iron:20', 'Leather scraps:3']],
      [2, 3, ['Wood:1', 'Iron:10', 'Leather scraps:2']],
      [3, 4, ['Wood:2', 'Iron:20', 'Leather scraps:4']],
      [4, 5, ['Wood:3', 'Iron:30', 'Leather scraps:6']],
    ]);
  });

  it('keeps the yield of Bronze Nails and Iron Nails', async () => {
    expect((await recipes('recipes/Bronze_Nails')).infoboxes[0]!.levels[0]).toMatchObject({
      quality: 1,
      yield: 20,
      entries: [{ text: 'Bronze', qty: 1, link: { title: 'Bronze', fragment: null } }],
    });
    expect((await recipes('recipes/Iron_Nails')).infoboxes[0]!.levels[0]).toMatchObject({ yield: 10 });
  });

  it('leaves the yield unknown where the wiki states none', async () => {
    // Unknown, not 1: whether a craft makes one is for the graph to decide.
    expect((await recipes('recipes/Karve')).infoboxes[0]!.levels[0]!.yield).toBeNull();
  });

  it("reads the Karve's 80 nails through the link, whatever the text says", async () => {
    const [karve] = (await recipes('recipes/Karve')).infoboxes;
    expect(karve!.levels[0]!.entries).toContainEqual({
      text: 'Bronze nails',
      qty: 80,
      link: { title: 'Bronze nails', fragment: null, text: 'Bronze nails' },
    });
  });

  it('reads every source a material is made at, with its links', async () => {
    const [bronze] = (await recipes('recipes/Bronze')).infoboxes;
    expect(bronze!.source).toEqual({
      text: 'Forge\nSmelter',
      links: [
        { title: 'Forge', fragment: null, text: 'Forge' },
        { title: 'Smelter', fragment: null, text: 'Smelter' },
      ],
    });
    expect(named(bronze!)).toEqual([['Copper:2', 'Tin:1']]);
  });

  it('keeps a creature as the source of a raw material, with no recipe', async () => {
    const [raw] = (await recipes('recipes/Deer_Meat')).infoboxes;
    expect(raw).toMatchObject({ tab: null, internalId: 'DeerMeat', source: { text: 'Deer' }, levels: [] });
  });
});

describe('extractRecipes: several infoboxes on a page', () => {
  it('reads every infobox on a page, each with its own tab', async () => {
    const boxes = (await recipes('recipes/Poison_Resistance_Mead')).infoboxes;
    expect(boxes.map((b) => b.tab)).toEqual([null, 'Mead base']); // labels as the page shows them
    expect(boxes.map((b) => b.internalId)).toEqual(['MeadPoisonResist', 'MeadBasePoisonResist']);
    expect(boxes[0]!.levels[0]).toMatchObject({
      yield: 6,
      entries: [{ qty: 1, link: { title: 'Mead base: Poison resistance' } }],
    });
    expect(boxes[1]!.levels[0]!.entries.map((e) => e.link?.title)).toEqual(['Honey', 'Thistle', 'Neck tail', 'Coal']);
    expect(boxes[1]!.source?.links.map((l) => l.title)).toEqual(['Mead ketill']);
  });

  it('gives a secondary infobox titled like its page a tab of its own', async () => {
    const boxes = (await recipes('recipes/Anti-Sting_Concoction')).infoboxes;
    expect(new Set(boxes.map((b) => b.tab)).size).toBe(boxes.length);
    expect(boxes.map((b) => [b.title, b.tab, b.internalId])).toEqual([
      ['Anti-Sting Concoction', null, 'MeadBugRepellent'],
      ['Anti-Sting Concoction', 'Mead base', 'MeadBaseBugRepellent'],
    ]);
  });

  it('reads the cooked meat and the dough as their own items', async () => {
    const meat = (await recipes('recipes/Deer_Meat')).infoboxes;
    expect(meat.map((b) => b.tab)).toEqual([null, 'Cooked']);
    expect(meat[1]!.levels[0]!.entries).toEqual([
      { text: 'Deer meat', qty: 1, link: { title: 'Deer meat', fragment: null, text: 'Deer meat' } },
    ]);

    const bread = (await recipes('recipes/Bread')).infoboxes;
    expect(bread.map((b) => [b.title, b.tab])).toEqual([
      ['Bread', null],
      ['Bread dough', 'Unbaked'],
    ]);
    expect(bread[1]!.levels[0]).toMatchObject({ yield: 2, entries: [{ qty: 10, link: { title: 'Barley flour' } }] });
  });

  it('reads quantity-first armor rows per piece', async () => {
    const boxes = (await recipes('recipes/Troll_Set')).infoboxes;
    expect(boxes.every((b) => b.levels.every((l) => l.entries.length > 0))).toBe(true);
    expect(boxes.map((b) => b.levels.length)).toEqual([4, 4, 4, 4]);
    expect(named(boxes[0]!)[0]).toEqual(['Troll hide:5', 'Bone fragments:3']);
    // The cape runs the second quantity into its link: "10<a>Bone fragments</a>".
    expect(named(boxes[3]!)).toEqual([
      ['Troll hide:10', 'Bone fragments:10'],
      ['Troll hide:5', 'Bone fragments:5'],
      ['Troll hide:10', 'Bone fragments:10'],
      ['Troll hide:15', 'Bone fragments:15'],
    ]);
    expect(boxes[3]!.levels.map((l) => l.stationLevel)).toEqual([2, 3, 4, 5]);
  });

  it('names every piece of a set by its tab, since none of them is the page', async () => {
    const boxes = (await recipes('recipes/Troll_Set')).infoboxes;
    expect(boxes.map((b) => [b.title, b.tab])).toEqual([
      ['Troll leather hood', 'Helmet'],
      ['Troll leather tunic', 'Tunic'],
      ['Troll leather trousers', 'Trousers'],
      ['Troll hide cape', 'Cape'],
    ]);
    // The same goes for a saved set from before this module.
    expect((await recipes('Bronze_Armor')).infoboxes.map((b) => b.tab)).not.toContain(null);
  });

  it("takes the first infobox for the page's own when it is not told the page's title", async () => {
    const page = await saved('recipes/Troll_Set');
    expect(extractRecipes(page.text, null).infoboxes.map((b) => b.tab)).toEqual([null, 'Tunic', 'Trousers', 'Cape']);
  });
});

describe('extractRecipes: stations and extensions', () => {
  it('reads a station and an extension', async () => {
    const [cauldron] = (await recipes('recipes/Cauldron')).infoboxes;
    expect(cauldron).toMatchObject({ maxLevel: 6, internalId: 'piece_cauldron', upgrades: null });
    expect(cauldron!.improvements.map((l) => l.title)).toEqual([
      'Spice rack',
      "Butcher's table",
      'Pots and pans',
      'Mortar and pestle',
      'Rolling pins and cutting boards',
    ]);
    expect((await recipes('recipes/Forge_Cooler')).infoboxes[0]!.upgrades?.title).toBe('Forge');
  });

  it('reads a lone entry outside any list, and no picture tab as a level', async () => {
    // The Cauldron's pictures sit in tabs ("Icon", "Appearance"); only numbered tabs are levels.
    const [cauldron] = (await recipes('recipes/Cauldron')).infoboxes;
    expect(cauldron!.levels).toEqual([
      {
        quality: 1,
        stationLevel: null,
        yield: null,
        entries: [{ text: 'Tin', qty: 10, link: { title: 'Tin', fragment: null, text: 'Tin' } }],
      },
    ]);
  });

  it('decodes link titles and fragments', async () => {
    // As the wiki's link reads: `/wiki/Smith%27s_anvil`.
    const [forge] = (await recipes('Forge')).infoboxes;
    expect(forge!.maxLevel).toBe(7);
    expect(forge!.improvements.map((l) => l.title)).toContain("Smith's anvil");

    const linked = (link: string) => extractRecipes(box(`<ul><li>${link} x2</li></ul>`), null).infoboxes[0]!;
    const cooked = linked('<a href="/wiki/Deer_Meat#Cooked" title="Deer Meat">Cooked deer meat</a>');
    expect(cooked.levels[0]!.entries[0]!.link).toEqual({ title: 'Deer Meat', fragment: 'Cooked', text: 'Cooked deer meat' });
    const trophy = linked('<a href="/wiki/Trophies#Black_Forest">Troll trophy</a>');
    expect(trophy.levels[0]!.entries[0]!.link).toMatchObject({ title: 'Trophies', fragment: 'Black Forest' });
    // A page that does not exist yet is still the title the wiki wrote.
    const missing = linked(
      '<a href="/wiki/Dyrnwyn_hilt_fragment?action=edit&amp;redlink=1" class="new">Dyrnwyn hilt fragment</a>',
    );
    expect(missing.levels[0]!.entries[0]!.link).toMatchObject({ title: 'Dyrnwyn hilt fragment', fragment: null });
    // A broken escape is read as written rather than thrown on.
    const broken = linked('<a href="/wiki/Wood%E0%A4%A">Wood</a>');
    expect(broken.levels[0]!.entries[0]!.link?.title).toBe('Wood%E0%A4%A');
  });

  it("reads a self-link as the page's own title", () => {
    // The Cooked egg, on the Egg page, is made from the page's subject, which
    // MediaWiki writes as `<strong class="mw-selflink selflink">`, no href.
    const html = box('<ul><li><strong class="mw-selflink selflink">Egg</strong> x1</li></ul>', 'Cooked egg');
    expect(extractRecipes(html, { title: 'Egg' }).infoboxes[0]!.levels[0]!.entries).toEqual([
      { text: 'Egg', qty: 1, link: { title: 'Egg', fragment: null, text: 'Egg' } },
    ]);
    expect(extractRecipes(html, null).infoboxes[0]!.levels[0]!.entries[0]!.link).toBeNull();
  });

  it('links a material only where a link names it', () => {
    // Taken by position, the mead base's link would be "Mead base", and 80
    // Bronze nails would be 80 Bronze: a cost twenty times the real one.
    // Without a link, the graph finds each by its name or reports it.
    const entries = (cell: string) => extractRecipes(box(cell), null).infoboxes[0]!.levels[0]!.entries;
    expect(
      entries('<ul><li><a href="/wiki/Mead_base">Mead base</a>: <a href="/wiki/Poison_resistance">Poison resistance</a> x1</li></ul>'),
    ).toEqual([{ text: 'Mead base: Poison resistance', qty: 1, link: null }]);
    expect(entries('<ul><li><a href="/wiki/Bronze">Bronze</a> nails x80</li></ul>')).toEqual([
      { text: 'Bronze nails', qty: 80, link: null },
    ]);
    // A link around the material and its count names that one material.
    expect(entries('<ul><li><a href="/wiki/Wood">Wood x2</a></li></ul>')).toEqual([
      { text: 'Wood', qty: 2, link: { title: 'Wood', fragment: null, text: 'Wood x2' } },
    ]);
  });

  it('keeps the link the wiki wrote, even to the wrong page', async () => {
    // "Root" points at the disambiguation page, not Root (item): the graph's overrides fix it.
    const [mask] = (await recipes('recipes/Root_Set')).infoboxes;
    expect(named(mask!)[0]).toEqual(['Root:10', 'Ancient bark:10', 'Leather scraps:4']);
  });

  it('keeps the internal ID the wiki wrote, even one copied from another piece', async () => {
    // Two pieces share their neighbour's ID on the wiki, so an ID alone does
    // not tell two items apart: the graph has to notice, not the extractor.
    expect((await recipes('recipes/Troll_Set')).infoboxes.map((b) => [b.title, b.internalId])).toEqual([
      ['Troll leather hood', 'HelmetTrollLeather'],
      ['Troll leather tunic', 'HelmetTrollLeather'],
      ['Troll leather trousers', 'ArmorTrollLeatherLegs'],
      ['Troll hide cape', 'CapeTrollHide'],
    ]);
    expect((await recipes('recipes/Root_Set')).infoboxes.map((b) => b.internalId)).toEqual([
      'HelmetRoot',
      'ArmorRootChest',
      'ArmorRootChest',
    ]);
  });
});

describe('extractRecipes: list pages', () => {
  it('reads structure list rows and food rows', async () => {
    const structures = await recipes('recipes/Wood_Structures');
    expect(structures.listRows.length).toBeGreaterThan(10);
    expect(structures.listRows[0]).toEqual({
      name: 'Wood floor 1x1',
      entries: [{ text: 'Wood', qty: 1, link: { title: 'Wood', fragment: null, text: 'Wood' } }],
      anchor: 'Floors and stairs',
      notes: [],
    });
    expect(new Set(structures.listRows.map((row) => row.anchor))).toEqual(
      new Set(['Floors and stairs', 'Walls', 'Poles and beams', 'Doors']),
    );

    const food = (await recipes('recipes/Food')).foodRows;
    expect(food.find((r) => r.item.title === "Queen's jam" || r.item.text === "Queen's jam")).toEqual({
      item: { title: "Queen's jam", fragment: null, text: "Queen's jam" },
      station: 'Cauldron',
      stationLevel: 1,
      multiplier: 4,
    });
    expect(food.find((r) => r.item.title === 'Salad')).toMatchObject({ station: 'Cauldron', stationLevel: 5, multiplier: 3 });
    // Raw food is found, not made: "(Meadows)" is where, not a station.
    expect(food.find((r) => r.item.title === 'Raspberries')).toMatchObject({ station: null, stationLevel: null, multiplier: null });
  });

  it("reads a station's table of extensions, the only record of the Artisan press", async () => {
    // No page is titled Artisan Press: the wiki's redirect for it points at
    // this table ("Artisan Table#Upgrades"), and this row is its recipe.
    const page = await recipes('recipes/Artisan_Table');
    expect(page.infoboxes[0]!.improvements.map((link) => link.title)).toEqual(['Artisan press']);
    expect(page.listRows).toEqual([
      {
        name: 'Artisan Press',
        entries: [
          { text: 'Black marble', qty: 5, link: { title: 'Black marble', fragment: null, text: 'Black marble' } },
          { text: 'Bronze', qty: 5, link: { title: 'Bronze', fragment: null, text: 'Bronze' } },
          {
            text: 'Majestic carapace',
            qty: 1,
            link: { title: 'Majestic carapace', fragment: null, text: 'Majestic carapace' },
          },
        ],
        anchor: 'Upgrades',
        notes: [],
      },
    ]);
  });

  it('reads every extension in the table but not its total', async () => {
    // The Smoker is in the Cauldron's table and not in its infobox, and has
    // no page: whether it is in the game yet is for the graph to decide.
    const cauldron = (await recipes('recipes/Cauldron')).listRows;
    expect(cauldron.map((row) => row.name)).toEqual([
      'Spice rack',
      "Butcher's table",
      'Pots and pans',
      'Mortar and pestle',
      'Rolling pins and cutting boards',
      'Smoker',
    ]);
    expect(cauldron.every((row) => row.anchor === 'Upgrades' && row.notes.length === 0)).toBe(true);
    expect(cauldron.at(-1)!.entries.map((e) => `${e.link?.title ?? e.text}:${e.qty}`)).toEqual([
      'Bloodgold:5',
      'Timberwood:6',
    ]);

    // The last row, "Total (Forge included)", sums the others; a remark
    // beside an extension's materials stays a note.
    const forge = (await recipes('Forge')).listRows;
    expect(forge.map((row) => row.name)).toEqual([
      'Forge Cooler',
      'Anvils',
      "Smith's Anvil",
      'Forge Toolrack',
      'Forge Bellows',
      'Grinding Wheel',
    ]);
    expect(forge.at(-1)).toMatchObject({
      entries: [{ text: 'Wood', qty: 25 }, { text: 'Sharpening stone', qty: 1 }],
      notes: ['(Requires Stonecutter)'],
    });
  });

  it('reads no other table on a page that has an infobox', () => {
    // A material's page lists what it goes into, and every one of those
    // states its own recipe; a station's other tables are not its extensions.
    const usage =
      `<h2><span class="mw-headline" id="Usage">Usage</span></h2><table class="article-table"><tbody>` +
      `<tr><th>Name</th><th>Materials</th></tr>` +
      `<tr><td><a href="/wiki/Boar_jerky">Boar jerky</a></td><td><a href="/wiki/Honey">Honey</a> x1</td></tr>` +
      `</tbody></table>`;
    expect(extractRecipes(box('n/a', 'Honey') + usage, { title: 'Honey' }).listRows).toEqual([]);
    const station = box('<a href="/wiki/Tin">Tin</a> x10', 'Cauldron').replace(
      '</aside>',
      `${data('Improvements', '<a href="/wiki/Spice_rack">Spice rack</a>')}</aside>`,
    );
    expect(extractRecipes(station + usage, { title: 'Cauldron' }).listRows).toEqual([]);
    expect(extractRecipes(station, { title: 'Cauldron' }).infoboxes[0]!.improvements).toHaveLength(1);
  });

  it('reads the food table on its own page only', async () => {
    expect((await recipes('Iron_Sword')).foodRows).toEqual([]);
  });

  it('reads only tables of building pieces as list rows', () => {
    const table = (header: string, row: string) =>
      `<h2><span class="mw-headline" id="List">List</span></h2><table class="wikitable">` +
      `<tbody><tr>${header}</tr><tr>${row}</tr></tbody></table>`;
    const pieces = table(
      '<th>Structure</th><th>Materials</th><th>Size</th>',
      '<td>Stone wall 1x1</td><td><a href="/wiki/Stone">Stone</a> x6</td><td>1x1x1</td>',
    );
    expect(extractRecipes(pieces, null).listRows).toEqual([
      {
        name: 'Stone wall 1x1',
        entries: [{ text: 'Stone', qty: 6, link: { title: 'Stone', fragment: null, text: 'Stone' } }],
        anchor: 'List',
        notes: [],
      },
    ]);
    // Things carried rather than built (the Crafting page's inventory recipes,
    // the feasts, the trinkets) each have an article that states the recipe.
    const items = table('<th>Item</th><th>Materials</th>', '<td>Stone axe</td><td>4 Stone<br>5 Wood</td>');
    expect(extractRecipes(items, null).listRows).toEqual([]);
  });
});

describe('extractRecipes: what it cannot read', () => {
  it('keeps unreadable cells as notes and never throws', async () => {
    const page = await saved('recipes/Yuleklapp');
    expect(() => extractRecipes(page.text, { title: page.title })).not.toThrow();
  });

  it('does not merge three sizes into one recipe', async () => {
    // Small, medium and large Yuleklapp in one cell: 9 Finewood for one gift is a number nobody stated.
    const [gift] = (await recipes('recipes/Yuleklapp')).infoboxes;
    expect(gift!.levels).toEqual([]);
    expect(gift!.internalId).toBeNull();
    expect(gift!.notes.join('\n')).toContain('Small:');
    expect(gift!.notes.join('\n')).toContain('Raspberries x1');
  });

  it('does not merge sizes headed on their own materials\' lines either', () => {
    // Read as names, "Small: Finewood" and "Medium: Finewood" would be 5
    // Finewood for one gift, however the heading is set.
    const finewood = '<a href="/wiki/Finewood">Finewood</a>';
    for (const cell of [
      `<p>Small: ${finewood} x2<br>Medium: ${finewood} x3</p>`,
      `<ul><li><b>Small:</b> ${finewood} x2</li><li><b>Medium:</b> ${finewood} x3</li></ul>`,
    ]) {
      expect(extractRecipes(box(cell, 'Yuleklapp'), { title: 'Yuleklapp' }).infoboxes[0]).toMatchObject({
        levels: [],
        notes: ['Small: Finewood x2', 'Medium: Finewood x3'],
      });
    }
  });

  it('reads "none" as nothing, and an odd line as a note', () => {
    expect(extractRecipes(box('n/a'), null).infoboxes[0]).toMatchObject({ levels: [], notes: [] });
    expect(
      extractRecipes(box('<ul><li><a href="/wiki/Wood">Wood</a> x2</li><li>(Requires Stonecutter)</li></ul>'), null)
        .infoboxes[0],
    ).toMatchObject({
      levels: [{ entries: [{ text: 'Wood', qty: 2 }] }],
      notes: ['(Requires Stonecutter)'],
    });
    expect(extractRecipes('<p>No infobox here.</p>', null)).toEqual({ infoboxes: [], listRows: [], foodRows: [] });
  });

  it('gives no recipe at all rather than part of one', () => {
    // The Pots: one count of shards per size, then the resin. Without the
    // shards, "1 Charcoal resin" would be a whole recipe for a pot.
    const pots = box(
      `<ul><li><a href="/wiki/Pot_shard">Pot shard</a> x3, x4, x5</li>` +
        `<li><a href="/wiki/Charcoal_resin">Charcoal resin</a> x1</li></ul>`,
      'Green Pots',
    );
    expect(extractRecipes(pots, null).infoboxes[0]).toMatchObject({
      levels: [],
      notes: ['Pot shard x3, x4, x5\nCharcoal resin x1'],
    });
    // A count of none is no material, so the rest is not the recipe either.
    const none = box('<ul><li><a href="/wiki/Finewood">Finewood</a> x0</li><li><a href="/wiki/Resin">Resin</a> x2</li></ul>');
    expect(extractRecipes(none, null).infoboxes[0]).toMatchObject({ levels: [], notes: ['Finewood x0\nResin x2'] });
  });

  it('says which quality a note comes from', () => {
    // A fourth tab nobody could read is still a fourth level: without its
    // number, the sword would look like one that stops at three.
    const [sword] = extractRecipes(
      tabbed([
        data('Crafting Materials', 'Wood x2') + data('Crafting Level', '1'),
        data('Crafting Materials', 'Wood x1<br>(Requires Stonecutter)') + data('Crafting Level', '2'),
        data('Crafting Materials', 'Wood x2') + data('Crafting Level', 'about 3'),
        data('Crafting Materials', 'Wood x3, Iron x30') + data('Crafting Level', '4'),
      ]),
      { title: 'Sword' },
    ).infoboxes;
    expect(sword!.levels.map((level) => [level.quality, level.stationLevel])).toEqual([
      [1, 1],
      [2, 2],
      [3, null],
    ]);
    expect(sword!.notes).toEqual([
      'Quality 2: (Requires Stonecutter)',
      'Quality 3: Crafting Level: about 3',
      'Quality 4: Wood x3, Iron x30',
    ]);
  });
});

/**
 * Everything the extractor reads from every saved page, hashed. Stored
 * recipes record the version that read them, and only a new version gets
 * them read again: an extractor edit that changes the output without a bump
 * would reach only the pages someone happens to edit afterwards.
 */
async function recipesOutputHash(): Promise<string> {
  const hash = createHash('sha256');
  for (const dir of ['tests/fixtures', 'tests/fixtures/recipes']) {
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
    for (const file of files) {
      const page = (JSON.parse(await readFile(`${dir}/${file}`, 'utf8')) as Saved).parse;
      hash.update(JSON.stringify({ file: `${dir}/${file}`, recipes: extractRecipes(page.text, { title: page.title }) }));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

describe('RECIPES_VERSION', () => {
  it('matches the recorded output fingerprint', async () => {
    const actual = await recipesOutputHash();
    expect(
      actual,
      `What extractRecipes reads from the saved pages changed. If the extractor changed, bump ` +
        `RECIPES_VERSION (now ${RECIPES_VERSION}) in src/lib/wiki/recipes-version.ts, so the next ` +
        `\`pnpm ingest --recipes\` reads every page again. Then set RECIPES_OUTPUT_HASH there to ` +
        `'${actual}' (alone, if only a saved page changed).`,
    ).toBe(RECIPES_OUTPUT_HASH);
  });
});
