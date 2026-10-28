import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { assembleGraph, redirectTitles, type AssemblyPage, type Redirects } from '@/lib/craft/assemble';
import { decodeGraph, encodeGraph } from '@/lib/craft/codec';
import { expandRaw, indexGraph, missingSteps, stepCost, totalCost } from '@/lib/craft/math';
import { OVERRIDES } from '@/lib/craft/recipe-overrides';
import type { ItemId, RecipeGraph } from '@/lib/craft/types';
import { extractRecipes } from '@/lib/wiki/recipes';
import { slugify } from '@/lib/wiki/slug';

/**
 * The assembly over saved pages of the live wiki (tests/fixtures and
 * tests/fixtures/recipes), read through the extractor as the ingest reads
 * them, plus one-infobox pages for the materials and stations those pages
 * name and the saved set lacks.
 *
 * What is pinned is what a reader would check by hand: the Iron Sword's
 * steps at Forge levels 2 to 5, a Karve's 80 nails coming to 8 copper ore and
 * 4 tin ore, a mead base that is its own item, and every doubt the wiki
 * leaves (an unknown name, a level past a station's maximum, a step stated
 * twice) in the report rather than quietly settled.
 */

type Saved = { parse: { title: string; text: string; categories?: { category: string; hidden?: boolean }[] } };

/** A saved page as the ingest stores it: slug, title, categories without the hidden ones, and its recipes. */
function saved(name: string, categories?: string[]): AssemblyPage {
  const page = (JSON.parse(readFileSync(`tests/fixtures/${name}.json`, 'utf8')) as Saved).parse;
  return {
    slug: slugify(page.title),
    title: page.title,
    categories:
      categories ?? (page.categories ?? []).filter((c) => !c.hidden).map((c) => c.category.replace(/_/g, ' ')),
    recipes: extractRecipes(page.text, { title: page.title }),
  };
}

/** A labelled value of an infobox, as Fandom writes one. */
const data = (label: string, value: string) =>
  `<div class="pi-item pi-data"><h3 class="pi-data-label">${label}</h3><div class="pi-data-value">${value}</div></div>`;

/** A link to a page of the wiki, as its `href` names it. */
const link = (title: string) => `<a href="/wiki/${title.replace(/ /g, '_')}">${title}</a>`;

/** A page of one infobox, read through the extractor. */
function infoboxPage(title: string, values: string[], categories: string[], boxTitle = title): AssemblyPage {
  const html = `<aside class="portable-infobox"><h2 class="pi-title">${boxTitle}</h2>${values.join('')}</aside>`;
  return { slug: slugify(title), title, categories, recipes: extractRecipes(html, { title }) };
}

/** A material with no recipe, and where it comes from. */
function material(title: string, id: string, source?: string): AssemblyPage {
  return infoboxPage(title, [data('Internal ID', id), ...(source ? [data('Source', link(source))] : [])], ['Materials']);
}

/** A crafting station, with its levels when it has some. */
function station(title: string, id: string, maxLevel?: number): AssemblyPage {
  return infoboxPage(
    title,
    [data('Internal ID', id), ...(maxLevel ? [data('Max Level', String(maxLevel))] : [])],
    ['Crafting structures'],
  );
}

/** Something made at a station, with one recipe cell. */
function made(
  title: string,
  id: string,
  at: string,
  materials: [string, number][],
  more: { level?: number; yield?: number; categories?: string[]; boxTitle?: string } = {},
): AssemblyPage {
  const cell =
    (more.yield ? `<b>Crafts ${more.yield}</b>` : '') +
    `<ul>${materials.map(([name, qty]) => `<li>${link(name)} x${qty}</li>`).join('')}</ul>`;
  return infoboxPage(
    title,
    [
      data('Internal ID', id),
      data('Source', link(at)),
      ...(more.level ? [data('Crafting Level', String(more.level))] : []),
      data('Crafting Materials', cell),
    ],
    more.categories ?? ['Materials'],
    more.boxTitle,
  );
}

/** A page that describes no one thing, such as a disambiguation page or a list. */
const bare = (title: string, categories: string[] = []): AssemblyPage => ({
  slug: slugify(title),
  title,
  categories,
  recipes: { infoboxes: [], listRows: [], foodRows: [] },
});

/** A materials cell of table rows, quantity first, one material a line, as the wiki's tables write them. */
const materialsCell = (materials: [string, number][]) => materials.map(([name, qty]) => `${qty} ${link(name)}`).join('<br />');

/**
 * A station's page as the wiki writes one: its infobox, with its Max Level and
 * Improvements, and under "Upgrades" the table of what each extension costs.
 */
function stationWithTable(
  title: string,
  id: string,
  maxLevel: number,
  improvements: string[],
  rows: [string, [string, number][]][],
): AssemblyPage {
  const infobox =
    `<aside class="portable-infobox"><h2 class="pi-title">${title}</h2>` +
    data('Internal ID', id) +
    data('Source', link('Workbench')) +
    data('Max Level', String(maxLevel)) +
    data('Improvements', improvements.map(link).join('<br />')) +
    '</aside>';
  const table =
    '<table><tbody><tr><th>Icon</th><th>Name</th><th>Materials</th></tr>' +
    rows.map(([name, materials]) => `<tr><td></td><td>${link(name)}</td><td>${materialsCell(materials)}</td></tr>`).join('') +
    '</tbody></table>';
  const html = `${infobox}<h2><span class="mw-headline" id="Upgrades">Upgrades</span></h2>${table}`;
  return { slug: slugify(title), title, categories: ['Crafting structures'], recipes: extractRecipes(html, { title }) };
}

/**
 * A page of one infobox with a tab per quality level, as the wiki writes an
 * item that upgrades: each tab with its Crafting Level (the quality, unless
 * `firstLevel` starts them higher) and its materials. `after` is the rest of
 * the page, such as its table of upgrades.
 */
function levelledPage(
  title: string,
  id: string,
  source: string,
  levels: [number, [string, number][]][],
  more: { firstLevel?: number; after?: string } = {},
): AssemblyPage {
  const labels = levels.map(([quality]) => `<li><div class="wds-tabs__tab-label">${quality}</div></li>`).join('');
  const panels = levels
    .map(
      ([quality, materials]) =>
        `<div class="wds-tab__content">${data('Crafting Level', String((more.firstLevel ?? 1) + quality - 1))}` +
        data('Crafting Materials', `<ul>${materials.map(([name, qty]) => `<li>${link(name)} x${qty}</li>`).join('')}</ul>`) +
        '</div>',
    )
    .join('');
  const html =
    `<aside class="portable-infobox"><h2 class="pi-title">${title}</h2>${data('Internal ID', id)}${data('Source', source)}` +
    `<div class="wds-tabber"><div class="wds-tabs__wrapper"><ul class="wds-tabs">${labels}</ul></div>${panels}</div></aside>` +
    (more.after ?? '');
  return { slug: slugify(title), title, categories: ['Weapons'], recipes: extractRecipes(html, { title }) };
}

/**
 * An item's table of upgrades, as the wiki writes one under "Upgrade
 * information": a column per quality, its materials quantity first, and the
 * station's level, `[quality, level, materials]` each.
 */
function upgradeTable(station: string, levels: [number, number, [string, number][]][]): string {
  const cells = (cell: (level: (typeof levels)[number]) => string) => levels.map((level) => `<td>${cell(level)}</td>`).join('');
  return (
    '<h2><span class="mw-headline" id="Upgrade_information">Upgrade information</span></h2>' +
    `<table class="article-table"><tbody><tr><th>Quality</th>${levels.map(([quality]) => `<th>${quality}</th>`).join('')}</tr>` +
    `<tr><th>Crafting</th>${cells(([, , materials]) => materialsCell(materials))}</tr>` +
    `<tr><th>${station} level</th>${cells(([, level]) => String(level))}</tr></tbody></table>`
  );
}

/** A list page: no infobox, one table of building pieces with the given columns. */
function listPage(title: string, header: string[], rows: string[][]): AssemblyPage {
  const html =
    `<table><tbody><tr>${header.map((label) => `<th>${label}</th>`).join('')}</tr>` +
    rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('') +
    '</tbody></table>';
  return { slug: slugify(title), title, categories: [], recipes: extractRecipes(html, { title }) };
}

const BUILT_AT = '2026-10-27T18:00:00.000Z';

/** The redirects these pages link through, as the wiki answers for them. */
const REDIRECTS: Redirects = new Map([
  ['Bronze nails', { title: 'Bronze Nails', fragment: null }],
  ['Mead base: Poison resistance', { title: 'Poison Resistance Mead', fragment: 'Mead base' }],
  ['Mead base: Anti-sting', { title: 'Anti-Sting Concoction', fragment: 'Mead base' }],
  ['Mead ketill', { title: 'Mead Ketill', fragment: null }],
  ['Cooked deer meat', { title: 'Deer Meat', fragment: 'Cooked' }],
  ['Forge cooler', { title: 'Forge Cooler', fragment: null }],
  ['Artisan press', { title: 'Artisan Table', fragment: 'Upgrades' }],
  ['Deer trophy', { title: 'Trophies', fragment: 'Meadows' }],
]);

const WORLD: AssemblyPage[] = [
  saved('Iron_Sword'),
  saved('Iron'),
  saved('Forge', ['Crafting structures', 'Crafting', 'Building']),
  saved('Bronze_Armor', ['Armor']),
  saved('recipes/Forge_Cooler'),
  saved('recipes/Bronze_Nails'),
  saved('recipes/Karve'),
  saved('recipes/Tin'),
  saved('recipes/Bronze'),
  saved('recipes/Troll_Set'),
  saved('recipes/Poison_Resistance_Mead'),
  saved('recipes/Anti-Sting_Concoction'),
  saved('recipes/Deer_Meat'),
  saved('recipes/Cauldron'),
  saved('recipes/Wood_Structures'),
  saved('recipes/Food'),
  saved('recipes/Yuleklapp'),
  saved('recipes/Root_Set'),
  saved('recipes/Artisan_Table'),
  // What those pages name and the saved set lacks.
  material('Wood', 'Wood'),
  material('Leather Scraps', 'LeatherScraps'),
  material('Scrap Iron', 'IronScrap'),
  material('Copper Ore', 'CopperOre', 'Copper deposit'),
  material('Tin Ore', 'TinOre'),
  material('Coal', 'Coal'),
  material('Finewood', 'FineWood'),
  material('Corewood', 'RoundLog'),
  material('Deer Hide', 'DeerHide', 'Deer'),
  material('Resin', 'Resin'),
  material('Honey', 'Honey'),
  material('Thistle', 'Thistle'),
  material('Neck Tail', 'NeckTail'),
  material('Troll Hide', 'TrollHide'),
  material('Bone Fragments', 'BoneFragments'),
  material('Root (item)', 'Root'),
  material('Ancient Bark', 'ElderBark'),
  bare('Root'),
  bare('Deer', ['Creatures', 'Passive creatures']),
  bare('Copper deposit', ['Ore deposits', 'Resource nodes']),
  bare('Trophies', ['Trophies', 'Items']),
  made('Copper', 'Copper', 'Smelter', [['Copper ore', 1]]),
  made('Troll Hide Cape', 'CapeTrollHide', 'Workbench', [['Troll hide', 10], ['Bone fragments', 10]], {
    level: 2,
    categories: ['Armor', 'Capes'],
    boxTitle: 'Troll hide cape',
  }),
  made('Salad', 'Salad', 'Cauldron', [['Thistle', 3]], { yield: 3, categories: ['Food'] }),
  made('Stagbreaker', 'SledgeStagbreaker', 'Workbench', [['Wood', 20], ['Deer trophy', 1]], { categories: ['Weapons'] }),
  material('Ymir Flesh', 'YmirRemains', 'Haldor'),
  bare('Haldor', ['NPCs']),
  made('Ymir Charm', 'YmirCharm', 'Workbench', [['Ymir flesh', 1]], { categories: ['Trinket'] }),
  station('Workbench', 'piece_workbench', 5),
  station('Smelter', 'smelter'),
  station('Mead Ketill', 'piece_MeadCauldron'),
  station('Fermenter', 'fermenter'),
  station('Charcoal Kiln', 'charcoal_kiln'),
];

const { graph, report } = assembleGraph(WORLD, REDIRECTS, BUILT_AT);
const item = (id: ItemId) => graph.items.find((i) => i.id === id);
/** The steps the maths plans with, in quality order. */
const stepsOf = (g: RecipeGraph, id: ItemId) => g.recipes.filter((r) => r.product === id && !r.alt);
const steps = (id: ItemId) => stepsOf(graph, id);

describe('assembleGraph: items and their steps', () => {
  it('reads Iron Sword as SwordIron: four steps at Forge levels 2 to 5', () => {
    expect(item('SwordIron')).toMatchObject({ en: 'Iron Sword', slug: 'iron-sword', kind: 'item', maxQuality: 4 });
    expect(steps('SwordIron').map((r) => [r.quality, r.station, r.stationLevel, r.inputs])).toEqual([
      [1, 'forge', 2, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 3]]],
      [2, 'forge', 3, [['Wood', 1], ['Iron', 10], ['LeatherScraps', 2]]],
      [3, 'forge', 4, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 4]]],
      [4, 'forge', 5, [['Wood', 3], ['Iron', 30], ['LeatherScraps', 6]]],
    ]);
    expect(steps('SwordIron').every((r) => r.method === 'craft' && r.yield === 1 && r.yieldKnown)).toBe(true);
    expect(new Set(steps('SwordIron').map((r) => r.from))).toEqual(new Set(['Iron Sword']));
  });

  it("keeps the nails' yield and resolves the Karve's nails by their link", () => {
    expect(steps('BronzeNails')).toEqual([
      expect.objectContaining({ station: 'forge', yield: 20, yieldKnown: true, inputs: [['Bronze', 1]] }),
    ]);
    expect(steps('Karve')).toEqual([
      expect.objectContaining({
        station: 'piece_workbench',
        method: 'build',
        inputs: [['FineWood', 30], ['DeerHide', 10], ['Resin', 20], ['BronzeNails', 80]],
      }),
    ]);
    expect(item('Karve')).toMatchObject({ kind: 'piece' });
  });

  it('makes a mead base its own item, reached through its redirect and brewed at the mead ketill', () => {
    expect(item('MeadBasePoisonResist')).toMatchObject({
      en: 'Mead base: Poison resistance',
      slug: 'poison-resistance-mead',
      anchor: 'mead-base',
      kind: 'item',
    });
    expect(steps('MeadBasePoisonResist')).toEqual([
      expect.objectContaining({
        station: 'piece_MeadCauldron',
        method: 'brew',
        from: 'Poison Resistance Mead#Mead base',
        inputs: [['Honey', 10], ['Thistle', 5], ['NeckTail', 1], ['Coal', 10]],
      }),
    ]);
    expect(steps('MeadPoisonResist')).toEqual([
      expect.objectContaining({ station: 'fermenter', method: 'ferment', yield: 6, inputs: [['MeadBasePoisonResist', 1]] }),
    ]);
  });

  it("keeps a secondary infobox titled like its page apart from the page's own item", () => {
    // Both infoboxes of Anti-Sting Concoction are titled "Anti-Sting Concoction".
    expect(item('MeadBugRepellent')).toMatchObject({ en: 'Anti-Sting Concoction', slug: 'anti-sting-concoction' });
    expect(item('MeadBugRepellent')!.anchor).toBeUndefined();
    // Named by the redirect that points at it, rather than by its page's title again.
    expect(item('MeadBaseBugRepellent')).toMatchObject({ en: 'Mead base: Anti-sting', anchor: 'mead-base' });
    expect(steps('MeadBugRepellent')[0]!.inputs).toEqual([['MeadBaseBugRepellent', 1]]);
    expect(graph.recipes.filter((r) => r.inputs.some(([id]) => id === r.product))).toEqual([]);
    // Of two redirects to the tab, the name the recipes link by is the one it goes by.
    const both: Redirects = new Map([
      ...REDIRECTS,
      ['Mead Base: Anti-Sting', { title: 'Anti-Sting Concoction', fragment: 'Mead base' }],
    ]);
    const named = assembleGraph(WORLD, both, BUILT_AT).graph.items.find((i) => i.id === 'MeadBaseBugRepellent');
    expect(named).toMatchObject({ en: 'Mead base: Anti-sting' });
  });

  it('reads a cooked meat as its own item, made from the raw one', () => {
    expect(item('CookedDeerMeat')).toMatchObject({ en: 'Cooked deer meat', slug: 'deer-meat', anchor: 'cooked' });
    expect(steps('CookedDeerMeat')[0]!.inputs).toEqual([['DeerMeat', 1]]);
  });

  it("follows a link's own section, and a redirect's, to the tab they name", () => {
    // `/wiki/Deer_Meat#Cooked`, underscores and all, and "Cooked deer meat",
    // a redirect to the same tab: both are the cooked meat, never the raw.
    const stew = infoboxPage(
      'Deer Stew',
      [
        data('Internal ID', 'DeerStew'),
        data('Source', link('Cauldron')),
        data(
          'Crafting Materials',
          '<ul><li><a href="/wiki/Deer_Meat#Cooked" title="Deer Meat">Cooked deer meat</a> x1</li>' +
            '<li><a href="/wiki/Cooked_deer_meat" class="mw-redirect">Cooked deer meat</a> x2</li></ul>',
        ),
      ],
      ['Food'],
    );
    const { graph: g } = assembleGraph([...WORLD, stew], REDIRECTS, BUILT_AT);
    expect(stepsOf(g, 'DeerStew')[0]!.inputs).toEqual([
      ['CookedDeerMeat', 1],
      ['CookedDeerMeat', 2],
    ]);
  });

  it('reaches a secondary infobox by its title where the redirect names no tab', () => {
    // "Unbaked sweetbread" redirects to Frosted Sweetbread as a whole; the
    // page's second infobox is titled "Unbaked sweetbread".
    const page = saved('Frosted_Sweetbread', ['Food']);
    const redirects: Redirects = new Map([...REDIRECTS, ['Unbaked sweetbread', { title: 'Frosted Sweetbread', fragment: null }]]);
    const viaRedirect = assembleGraph([...WORLD, page], redirects, BUILT_AT);
    expect(stepsOf(viaRedirect.graph, 'VikingCupcake')[0]!.inputs).toEqual([['VikingCupcakeUncooked', 1]]);
    // And by the title alone, where no redirect is known at all.
    const byTitle = assembleGraph([...WORLD, page], REDIRECTS, BUILT_AT);
    expect(stepsOf(byTitle.graph, 'VikingCupcake')[0]!.inputs).toEqual([['VikingCupcakeUncooked', 1]]);
    expect(byTitle.report.unresolved.map((u) => u.text)).not.toContain('Unbaked sweetbread');
  });

  it("gives a list row the game's ID its table states", () => {
    // The Banners table's "Internal id" column, which the extractor does not keep yet.
    const banners = listPage(
      'Banners',
      ['Banner', 'Materials', 'Internal id'],
      [['Black banner', materialsCell([['Finewood', 2], ['Leather Scraps', 6]]), 'piece_banner01']],
    );
    const { graph: g, report: r } = assembleGraph([...WORLD, banners], REDIRECTS, BUILT_AT);
    expect(g.items.find((i) => i.id === 'piece_banner01')).toMatchObject({
      en: 'Black banner',
      slug: 'banners',
      anchor: 'black-banner',
      kind: 'piece',
    });
    expect(stepsOf(g, 'piece_banner01')[0]).toMatchObject({ inputs: [['FineWood', 2], ['LeatherScraps', 6]], from: 'Banners' });
    expect(r.applied).toContainEqual({
      override: 'internalIds: Banners#Black banner',
      reason: OVERRIDES.internalIds['Banners#Black banner']!.reason,
      count: 1,
    });
  });

  it('builds each Yuleklapp size at the workbench its own page names', () => {
    // The Storage page names no station; the Yuleklapp's Source says "Workbench".
    const storage = listPage(
      'Storage',
      ['Name', 'Materials', 'Storage'],
      [['Yuleklapp (small)', materialsCell([['Finewood', 2], ['Bone Fragments', 1]]), '1x2']],
    );
    const { graph: g, report: r } = assembleGraph([...WORLD, storage], REDIRECTS, BUILT_AT);
    expect(stepsOf(g, 'piece_gift1')).toEqual([
      expect.objectContaining({ station: 'piece_workbench', method: 'build', from: 'Storage' }),
    ]);
    expect(r.applied).toContainEqual(expect.objectContaining({ override: 'listStations: Storage#Yuleklapp (small)' }));
  });

  it('makes structure list rows pieces of their own, built at the station the list names', () => {
    expect(item('page:wood-structures#wood-floor-1x1')).toMatchObject({
      en: 'Wood floor 1x1',
      slug: 'wood-structures',
      anchor: 'wood-floor-1x1',
      kind: 'piece',
      maxQuality: 1,
    });
    expect(steps('page:wood-structures#wood-floor-1x1')).toEqual([
      {
        product: 'page:wood-structures#wood-floor-1x1',
        quality: 1,
        station: 'piece_workbench',
        stationLevel: 1,
        yield: 1,
        yieldKnown: true,
        inputs: [['Wood', 1]],
        method: 'build',
        from: 'Wood Structures',
      },
    ]);
    expect(report.applied).toContainEqual(
      expect.objectContaining({
        override: 'listStations: Wood Structures',
        reason: OVERRIDES.listStations['Wood Structures']!.reason,
      }),
    );
  });

  it('upgrades a thing made by hand at the station its table of upgrades names, from its second level on', () => {
    // The Club's Source is the Player crafting menu, which makes its first
    // level only; the game upgrades it where it is repaired, which its
    // "Upgrade information" table names: "Workbench level 1 2 3 4".
    const source = '<a href="/wiki/Crafting_Menu#Player_Inventory">Player crafting menu</a>';
    const levels: [number, [string, number][]][] = [
      [1, [['Wood', 6]]],
      [2, [['Bone Fragments', 5]]],
      [3, [['Bone Fragments', 10]]],
      [4, [['Bone Fragments', 15]]],
    ];
    const table = upgradeTable('Workbench', levels.map(([quality, materials]) => [quality, quality, materials]));
    const club = levelledPage('Club', 'Club', source, levels, { after: table });
    const { graph: g, report: r } = assembleGraph([...WORLD, club], REDIRECTS, BUILT_AT);
    const where = (graphOf: RecipeGraph) => stepsOf(graphOf, 'Club').map((s) => [s.quality, s.station, s.stationLevel, s.method]);
    expect(where(g)).toEqual([
      [1, null, 1, 'craft'],
      [2, 'piece_workbench', 2, 'craft'],
      [3, 'piece_workbench', 3, 'craft'],
      [4, 'piece_workbench', 4, 'craft'],
    ]);
    expect(r.costConflicts).toEqual([]);

    // A page with no such table leaves the upgrades at no station at all,
    // until an override names the one its text does.
    const bare = levelledPage('Club', 'Club', source, levels);
    expect(stepsOf(assembleGraph([...WORLD, bare], REDIRECTS, BUILT_AT).graph, 'Club').map((s) => s.station)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    const told = assembleGraph([...WORLD, bare], REDIRECTS, BUILT_AT, {
      ...OVERRIDES,
      upgradeStations: { Club: { station: 'piece_workbench', reason: 'Its text.' } },
    });
    expect(where(told.graph)).toEqual(where(g));
    expect(told.report.applied).toContainEqual({ override: 'upgradeStations: Club', reason: 'Its text.', count: 3 });
  });

  it('takes the Cauldron level the food table states where the infobox says plain "Cauldron"', () => {
    // Salad's infobox says "Cauldron"; the Food page's table says "Cauldron (5)".
    expect(steps('Salad')).toEqual([
      expect.objectContaining({ station: 'piece_cauldron', stationLevel: 5, method: 'cook', yield: 3, yieldKnown: true }),
    ]);
  });
});

describe('assembleGraph: stations and extensions', () => {
  it('gives a station its levels and its extensions, in the order the wiki lists them', () => {
    expect(item('forge')).toMatchObject({ kind: 'station', station: { maxLevel: 7 } });
    expect(item('forge')!.station!.extensions).toEqual([
      'page:forge#forge-bellows',
      'page:forge#anvils',
      'page:forge#grinding-wheel',
      'page:forge#smith-s-anvil',
      'forge_ext5',
      'page:forge#forge-toolrack',
    ]);
    expect(item('forge_ext5')).toMatchObject({ kind: 'extension', extends: 'forge' });
    expect(item('smelter')).toMatchObject({ kind: 'station', station: { maxLevel: 1, extensions: [] } });
  });

  it("takes an extension's recipe from its station's table when no page states it", () => {
    // The Artisan press has no page; the wiki's redirect for it points at the table.
    expect(item('piece_artisanstation')!.station).toEqual({
      maxLevel: 2,
      extensions: ['page:artisan-table#artisan-press'],
    });
    expect(item('page:artisan-table#artisan-press')).toMatchObject({
      en: 'Artisan Press',
      kind: 'extension',
      extends: 'piece_artisanstation',
    });
    expect(steps('page:artisan-table#artisan-press')[0]).toMatchObject({ method: 'build', from: 'Artisan Table#Upgrades' });
  });

  it("leaves out a table row naming no extension the station states, and says so", () => {
    // The Cauldron's table has a Smoker its infobox does not list; without
    // the overrides nothing says it counts.
    const plain = assembleGraph(WORLD, REDIRECTS, BUILT_AT, { ...OVERRIDES, extensions: {}, stationMaxLevel: {} });
    expect(plain.graph.items.some((i) => i.en === 'Smoker')).toBe(false);
    expect(plain.graph.items.find((i) => i.id === 'piece_cauldron')).toMatchObject({ station: { maxLevel: 6 } });
    expect(plain.report.notes).toContainEqual(
      expect.objectContaining({ from: 'Cauldron#Upgrades', text: expect.stringContaining('Smoker') }),
    );
  });

  it('adds the extensions 1.0 brought where the overrides say the station has them, from its own table', () => {
    // Version history, 1.0.00: "Cauldron Extension: Smoker"; the Cauldron's
    // table states its recipe, while its Improvements still list five.
    expect(item('piece_cauldron')!.station).toEqual({
      maxLevel: 7,
      extensions: [
        'page:cauldron#spice-rack',
        'page:cauldron#butcher-s-table',
        'page:cauldron#pots-and-pans',
        'page:cauldron#mortar-and-pestle',
        'page:cauldron#rolling-pins-and-cutting-boards',
        'page:cauldron#smoker',
      ],
    });
    expect(item('page:cauldron#smoker')).toMatchObject({ en: 'Smoker', kind: 'extension', extends: 'piece_cauldron' });
    expect(steps('page:cauldron#smoker')).toEqual([
      expect.objectContaining({ method: 'build', from: 'Cauldron#Upgrades', inputs: [['page:bloodgold', 5], ['page:timberwood', 6]] }),
    ]);
    expect(report.applied).toContainEqual({
      override: 'extensions: Cauldron#Smoker',
      reason: OVERRIDES.extensions['Cauldron#Smoker']!.reason,
      count: 1,
    });
    expect(report.notes.some((n) => n.text.includes('Smoker'))).toBe(false);
  });

  /**
   * Smith's Aprons as its page stands: a page of its own, made at the Black
   * forge, whose Usage says it upgrades the Black forge, though the station's
   * Improvements predate it.
   */
  const APRONS = infoboxPage(
    "Smith's Aprons",
    [
      data('Internal ID', 'blackforge_ext5_gemcutter'),
      data('Source', link('Black forge')),
      data('Usage', `Upgrades ${link('Black forge')}`),
      data(
        'Crafting Materials',
        `<ul><li>${link('Bloodgold')} x5</li><li>${link('Timberwood')} x8</li><li>${link('Moose Hide')} x2</li></ul>`,
      ),
    ],
    ['Crafting structures'],
  );

  /** The endgame stations as their pages stand, and things made at the levels 1.0 did and did not bring. */
  const ENDGAME: AssemblyPage[] = [
    ...WORLD,
    stationWithTable(
      'Black Forge',
      'blackforge',
      5,
      ['Black forge cooler', 'Vice', 'Metal cutter', 'Gem cutter'],
      [
        ['Black Forge Cooler', [['Iron', 5], ['Copper', 5]]],
        ['Vice', [['Iron', 5], ['Copper', 8]]],
        ['Metal Cutter', [['Black marble', 5], ['Flametal', 5]]],
        ['Gem Cutter', [['Flametal', 5], ['Ashwood', 8]]],
        ["Smith's Aprons", [['Bloodgold', 5], ['Timberwood', 8], ['Moose Hide', 2]]],
      ],
    ),
    stationWithTable(
      'Galdr Table',
      'piece_magetable',
      4,
      ['Rune table', 'Unfading candles', 'Feathery wreath'],
      [
        ['Rune Table', [['Black marble', 10], ['Resin', 5]]],
        ['Unfading Candles', [['Black marble', 10], ['Resin', 15]]],
        ['Feathery Wreath', [['Ashwood', 3]]],
      ],
    ),
    made('Slayer', 'THSwordSlayer', 'Black forge', [['Flametal', 30]], { level: 6, categories: ['Weapons'] }),
    made('Primal Slayer', 'THSwordSlayerNature', 'Black forge', [['Flametal', 45]], { level: 7, categories: ['Weapons'] }),
    made('Trollstav', 'StaffClusterbomb', 'Galdr table', [['Resin', 15]], { level: 5, categories: ['Weapons'] }),
  ];

  it("settles the Black forge's and the Galdr table's highest levels from 1.0's extensions", () => {
    const { graph: g, report: r } = assembleGraph([...ENDGAME, APRONS], REDIRECTS, BUILT_AT);
    const find = (id: ItemId) => g.items.find((i) => i.id === id);
    // The Black Forge page: "Smith's Aprons as of 1.0, which enable Black
    // Forge level 6"; the Aprons' own page says it upgrades the Black forge.
    expect(find('blackforge')!.station).toEqual({
      maxLevel: 6,
      extensions: [
        'page:black-forge#black-forge-cooler',
        'page:black-forge#vice',
        'page:black-forge#metal-cutter',
        'page:black-forge#gem-cutter',
        'blackforge_ext5_gemcutter',
      ],
    });
    expect(stepsOf(g, 'blackforge_ext5_gemcutter')).toEqual([
      expect.objectContaining({
        method: 'build',
        from: "Smith's Aprons",
        inputs: [['page:bloodgold', 5], ['page:timberwood', 8], ['page:moose-hide', 2]],
      }),
    ]);
    // Version history, 1.0.00: "Galdr Table Extension: Standing Loom", which
    // no page describes yet: an extension only named, whose cost is unknown.
    expect(find('piece_magetable')!.station).toEqual({
      maxLevel: 5,
      extensions: [
        'page:galdr-table#rune-table',
        'page:galdr-table#unfading-candles',
        'page:galdr-table#feathery-wreath',
        'page:galdr-table#standing-loom',
      ],
    });
    expect(find('page:galdr-table#standing-loom')).toEqual({
      id: 'page:galdr-table#standing-loom',
      en: 'Standing Loom',
      slug: 'galdr-table',
      anchor: 'standing-loom',
      kind: 'extension',
      maxQuality: 1,
      extends: 'piece_magetable',
    });
    expect(stepsOf(g, 'page:galdr-table#standing-loom')).toEqual([]);
    for (const override of [
      'stationMaxLevel: blackforge',
      'stationMaxLevel: piece_magetable',
      'extensions: Galdr Table#Standing Loom',
    ]) {
      expect(r.applied).toContainEqual(expect.objectContaining({ override, count: 1 }));
    }
    expect(r.levelConflicts).toEqual([]);
  });

  it('counts an extension the overrides add only where nothing else finds it', () => {
    // The Aprons' own "Upgrades Black forge" finds it already: an entry
    // adding it changes nothing, and is reported as one to delete.
    const overrides = {
      ...OVERRIDES,
      extensions: { ...OVERRIDES.extensions, "Black Forge#Smith's Aprons": { reason: 'Its table states the recipe.' } },
    };
    const { graph: g, report: r } = assembleGraph([...ENDGAME, APRONS], REDIRECTS, BUILT_AT, overrides);
    expect(g.items.find((i) => i.id === 'blackforge')!.station!.extensions).toHaveLength(5);
    expect(g.items.find((i) => i.id === 'blackforge_ext5_gemcutter')).toMatchObject({ kind: 'extension', extends: 'blackforge' });
    expect(r.applied.map((a) => a.override)).not.toContain("extensions: Black Forge#Smith's Aprons");
    expect(r.notes).toContainEqual({ text: "extensions: Black Forge#Smith's Aprons: changed nothing", from: 'recipe-overrides' });

    // Without the entry, the station's table restates the Aprons' recipe,
    // rather than naming an extension the station lacks.
    const { report: plain } = assembleGraph([...ENDGAME, APRONS], REDIRECTS, BUILT_AT);
    expect(plain.duplicates).toContainEqual({
      product: 'blackforge_ext5_gemcutter',
      quality: 1,
      kept: "Smith's Aprons",
      dropped: 'Black Forge#Upgrades',
    });
    expect(plain.notes.filter((n) => n.text.includes("Smith's Aprons"))).toEqual([]);
  });

  it('reports a step at a level the game does not have yet apart from the contradictions, and keeps it', () => {
    const { graph: g, report: r } = assembleGraph(ENDGAME, REDIRECTS, BUILT_AT);
    // Black forge level 7: no extension reaches it, and the item pages print it "(not yet available)".
    expect(r.unavailable).toEqual([{ station: 'blackforge', stated: 6, required: 7, from: 'Primal Slayer' }]);
    expect(r.levelConflicts).toEqual([]);
    expect(stepsOf(g, 'THSwordSlayerNature')[0]).toMatchObject({ station: 'blackforge', stationLevel: 7 });
    expect(r.applied).toContainEqual({
      override: 'notYetAvailable: blackforge',
      reason: OVERRIDES.notYetAvailable['blackforge']!.reason,
      count: 1,
    });

    // Without the overrides each page's own word stands, and every step past it is a contradiction.
    const plain = assembleGraph(ENDGAME, REDIRECTS, BUILT_AT, {
      ...OVERRIDES,
      extensions: {},
      stationMaxLevel: {},
      notYetAvailable: {},
    });
    expect(plain.report.unavailable).toEqual([]);
    expect(plain.report.levelConflicts).toEqual([
      { station: 'piece_magetable', stated: 4, required: 5, from: 'Trollstav' },
      { station: 'blackforge', stated: 5, required: 6, from: 'Slayer' },
      { station: 'blackforge', stated: 5, required: 7, from: 'Primal Slayer' },
    ]);
    expect(plain.graph.items.find((i) => i.id === 'blackforge')!.station!.maxLevel).toBe(5);
    expect(plain.report.notes).toContainEqual(
      expect.objectContaining({ from: 'Black Forge#Upgrades', text: expect.stringContaining("Smith's Aprons") }),
    );
  });

  it('lists every extension of a station found only through one of them, and counts its levels from them', () => {
    // A new station, documented before anything is made at it: no Max Level yet.
    const loom = infoboxPage(
      'Rune Loom',
      [data('Internal ID', 'piece_runeloom'), data('Improvements', `${link('Loom Weights')}<br />${link('Loom Shuttle')}`)],
      ['Crafting structures'],
    );
    const extension = (title: string, id: string, materials: string) =>
      infoboxPage(
        title,
        [data('Internal ID', id), data('Source', link('Workbench')), data('Usage', `Upgrades ${link('Rune Loom')}`), data('Crafting Materials', materials)],
        ['Crafting structures', 'Crafting station upgrades'],
      );
    const pages = [
      loom,
      extension('Loom Weights', 'runeloom_ext1', `<ul><li>${link('Wood')} x4</li></ul>`),
      // Its recipe not written yet.
      extension('Loom Shuttle', 'runeloom_ext2', 'n/a'),
      // Its page says it upgrades the loom, whose Improvements predate it.
      extension('Loom Bobbin', 'runeloom_ext3', `<ul><li>${link('Wood')} x2</li></ul>`),
    ];
    const { graph: g } = assembleGraph([...WORLD, ...pages], REDIRECTS, BUILT_AT);
    expect(g.items.find((i) => i.id === 'piece_runeloom')).toMatchObject({
      kind: 'station',
      station: { maxLevel: 4, extensions: ['runeloom_ext1', 'runeloom_ext2', 'runeloom_ext3'] },
    });
    expect(g.items.find((i) => i.id === 'runeloom_ext2')).toMatchObject({ kind: 'extension', extends: 'piece_runeloom' });
    expect(g.items.find((i) => i.id === 'runeloom_ext3')).toMatchObject({ kind: 'extension', extends: 'piece_runeloom' });
    expect(() => encodeGraph(g)).not.toThrow();
  });
});

describe('assembleGraph: what the wiki leaves out, from the overrides', () => {
  it('burns 2 coal per bar at the smelter', () => {
    expect(steps('Tin')).toEqual([expect.objectContaining({ station: 'smelter', method: 'smelt', fuel: ['Coal', 2] })]);
    expect(steps('Bronze')[0]!.fuel).toBeUndefined();
    expect(report.applied).toContainEqual(
      expect.objectContaining({ override: 'fuel: smelter', reason: OVERRIDES.fuel['smelter']!.reason }),
    );
  });

  it('adds the charcoal kiln as alternatives, never as the way coal is planned', () => {
    const kiln = graph.recipes.filter((r) => r.product === 'Coal');
    expect(kiln.map((r) => [r.alt, r.inputs, r.station, r.method])).toEqual([
      [1, [['Wood', 1]], 'charcoal_kiln', 'kiln'],
      [2, [['FineWood', 1]], 'charcoal_kiln', 'kiln'],
      [3, [['RoundLog', 1]], 'charcoal_kiln', 'kiln'],
    ]);
    expect(item('charcoal_kiln')).toMatchObject({ kind: 'station' });
    expect(stepCost(indexGraph(graph), 'Coal', 1)).toBeNull();
  });

  it("follows Root Set's Root to the item, not the disambiguation page, and says why", () => {
    expect(steps('HelmetRoot')[0]!.inputs[0]).toEqual(['Root', 10]);
    expect(report.applied).toContainEqual({
      override: 'linkFixes: Root',
      reason: OVERRIDES.linkFixes['Root']!.reason,
      count: 12,
    });
    // Without the fix the link lands on a page that is no one thing, and is reported.
    const unfixed = assembleGraph(WORLD, REDIRECTS, BUILT_AT, { ...OVERRIDES, linkFixes: {} });
    expect(stepsOf(unfixed.graph, 'HelmetRoot')[0]!.inputs[0]).toEqual(['page:root', 10]);
    expect(unfixed.report.unresolved).toContainEqual({ text: 'Root', from: 'Root Set#Mask', count: 4 });
  });

  it('gives each piece its own ID where the wiki copies one onto another', () => {
    expect(item('HelmetTrollLeather')).toMatchObject({ en: 'Troll leather hood', slug: 'troll-set', anchor: 'helmet' });
    expect(item('ArmorTrollLeatherChest')).toMatchObject({ en: 'Troll leather tunic', anchor: 'tunic' });
    expect(item('ArmorRootLegs')).toMatchObject({ en: 'Root leggings' });
    // Without the override, the first keeps the ID, the second falls back to
    // where it is described, and the report says which.
    const plain = assembleGraph(WORLD, REDIRECTS, BUILT_AT, { ...OVERRIDES, internalIds: {} });
    expect(plain.graph.items.find((i) => i.id === 'HelmetTrollLeather')).toMatchObject({ en: 'Troll leather hood' });
    expect(plain.graph.items.find((i) => i.id === 'page:troll-set#tunic')).toMatchObject({ en: 'Troll leather tunic' });
    expect(plain.report.idConflicts).toContainEqual({
      id: 'HelmetTrollLeather',
      kept: 'Troll Set#Helmet',
      moved: 'Troll Set#Tunic',
      as: 'page:troll-set#tunic',
    });
  });

  it('names a trophy after its redirect and has it dropped by its creature', () => {
    expect(item('page:trophies#deer-trophy')).toEqual({
      id: 'page:trophies#deer-trophy',
      en: 'Deer trophy',
      es: 'Trofeo de ciervo',
      slug: 'trophies',
      anchor: 'deer-trophy',
      kind: 'virtual',
      maxQuality: 1,
      obtain: [{ how: 'drop', from: ['Deer'] }],
    });
    expect(steps('SledgeStagbreaker')[0]!.inputs).toEqual([['Wood', 20], ['page:trophies#deer-trophy', 1]]);
  });

  it("reads how a raw material is had from its Source", () => {
    expect(item('DeerHide')!.obtain).toEqual([{ how: 'drop', from: ['Deer'] }]);
    expect(item('CopperOre')!.obtain).toEqual([{ how: 'mine', from: ['Copper deposit'] }]);
    // Only raw materials: the bar is smelted, not found.
    expect(item('Copper')!.obtain).toBeUndefined();
  });

  it("spells out how a material is had where its Source names the main way without a link", () => {
    // Stone's Source: "Stones, Greydwarf, Greydwarf brute, Stone Golem"; only the creatures are linked.
    const stone = infoboxPage(
      'Stone',
      [data('Internal ID', 'Stone'), data('Source', `Stones, ${link('Greydwarf')}, ${link('Stone Golem')}`)],
      ['Materials'],
    );
    const { graph: g, report: r } = assembleGraph([...WORLD, stone], REDIRECTS, BUILT_AT);
    expect(g.items.find((i) => i.id === 'Stone')!.obtain).toEqual(OVERRIDES.obtain['Stone']!.obtain);
    expect(r.applied).toContainEqual(expect.objectContaining({ override: 'obtain: Stone', count: 1 }));
  });

  it("prices what a trader sells from the overrides, since Source names only the trader", () => {
    expect(item('YmirRemains')!.obtain).toEqual([{ how: 'buy', from: 'Haldor', coins: 120 }]);
    const plain = assembleGraph(WORLD, REDIRECTS, BUILT_AT, { ...OVERRIDES, obtain: {} });
    expect(plain.graph.items.find((i) => i.id === 'YmirRemains')!.obtain).toBeUndefined();
  });

  it('names in Spanish what no article translates', () => {
    expect(item('MeadBasePoisonResist')!.es).toBe('Base de hidromiel: Resistencia al veneno');
    expect(item('HelmetTrollLeather')!.es).toBe('Capucha de cuero de trol');
    // A thing with an article is named at serve time, from its translation.
    expect(item('SwordIron')!.es).toBeUndefined();
    expect(report.applied).toContainEqual(
      expect.objectContaining({ override: 'spanishNames[0]', reason: OVERRIDES.spanishNames[0]!.reason }),
    );
  });

  it('leaves out the pages it is told to ignore, and counts only those that state a recipe', () => {
    const overrides = {
      ...OVERRIDES,
      ignore: { 'Cheat Sword': { reason: 'Console only.' }, 'Cheat Sledge': { reason: 'Console only.' } },
    };
    const cheat = made('Cheat Sword', 'SwordCheat', 'Forge', [['Wood', 1]], { categories: ['Weapons'] });
    // As the wiki has it: an infobox with no recipe, which the graph would leave out anyway.
    const sledge = infoboxPage('Cheat Sledge', [data('Internal ID', 'SledgeCheat'), data('Source', link('Console Commands'))], [
      'Weapons',
    ]);
    const { graph: g, report: r } = assembleGraph([...WORLD, cheat, sledge], REDIRECTS, BUILT_AT, overrides);
    expect(g.items.some((i) => i.id === 'SwordCheat')).toBe(false);
    expect(r.applied).toContainEqual(expect.objectContaining({ override: 'ignore: Cheat Sword', count: 1 }));
    expect(r.applied.map((a) => a.override)).not.toContain('ignore: Cheat Sledge');
    expect(r.notes).toContainEqual({ text: 'ignore: Cheat Sledge: changed nothing', from: 'recipe-overrides' });
  });

  it("settles a step the wiki states wrong, by the item's ID and quality", () => {
    // The Troll Set's Helmet tab upgrades in Troll hide alone; the same page's
    // quality tables and the Armor page add 1, 2 and 3 Bone fragments.
    expect(steps('HelmetTrollLeather').map((r) => [r.quality, r.stationLevel, r.inputs])).toEqual([
      [1, 2, [['TrollHide', 5], ['BoneFragments', 3]]],
      [2, 3, [['TrollHide', 2], ['BoneFragments', 1]]],
      [3, 4, [['TrollHide', 4], ['BoneFragments', 2]]],
      [4, 5, [['TrollHide', 6], ['BoneFragments', 3]]],
    ]);
    expect(report.applied).toContainEqual({
      override: 'steps: HelmetTrollLeather@2',
      reason: OVERRIDES.steps['HelmetTrollLeather@2']!.reason,
      count: 1,
    });
    const plain = assembleGraph(WORLD, REDIRECTS, BUILT_AT, { ...OVERRIDES, steps: {} });
    expect(stepsOf(plain.graph, 'HelmetTrollLeather')[1]!.inputs).toEqual([['TrollHide', 2]]);
  });

  it('adds a quality the infobox leaves out, at the station its other steps name', () => {
    // The Staff of Protection's infobox stops at quality 3; its Upgrade
    // information table states a fourth, at Galdr table level 4.
    const staff = levelledPage('Practice Staff', 'StaffPractice', link('Workbench'), [
      [1, [['Wood', 20]]],
      [2, [['Wood', 10]]],
      [3, [['Wood', 20]]],
    ]);
    const overrides = {
      ...OVERRIDES,
      steps: {
        ...OVERRIDES.steps,
        'StaffPractice@4': { inputs: [['Wood', 30]] as [ItemId, number][], stationLevel: 4, reason: 'Its table.' },
      },
    };
    const { graph: g, report: r } = assembleGraph([...WORLD, staff], REDIRECTS, BUILT_AT, overrides);
    expect(stepsOf(g, 'StaffPractice')[3]).toEqual({
      product: 'StaffPractice',
      quality: 4,
      station: 'piece_workbench',
      stationLevel: 4,
      yield: 1,
      yieldKnown: true,
      inputs: [['Wood', 30]],
      method: 'craft',
      from: 'Practice Staff',
    });
    expect(g.items.find((i) => i.id === 'StaffPractice')!.maxQuality).toBe(4);
    expect(r.applied).toContainEqual({ override: 'steps: StaffPractice@4', reason: 'Its table.', count: 1 });
  });

  it('counts no entry that says what the wiki already says, and sweeps it as one to delete', () => {
    // Each of these restates its page: the Iron Sword's ID, the Forge's
    // seven levels, the Bronze nails' 20 a craft, where Copper ore is mined.
    const overrides = {
      ...OVERRIDES,
      internalIds: { ...OVERRIDES.internalIds, 'Iron Sword': { id: 'SwordIron', reason: 'Same.' } },
      stationMaxLevel: { ...OVERRIDES.stationMaxLevel, forge: { maxLevel: 7, reason: 'Same.' } },
      yields: { BronzeNails: { yield: 20, reason: 'Same.' } },
      obtain: { ...OVERRIDES.obtain, CopperOre: { obtain: [{ how: 'mine' as const, from: ['Copper deposit'] }], reason: 'Same.' } },
    };
    const { graph: g, report: r } = assembleGraph(WORLD, REDIRECTS, BUILT_AT, overrides);
    expect(g.version).toBe(graph.version);
    for (const key of ['internalIds: Iron Sword', 'stationMaxLevel: forge', 'yields: BronzeNails', 'obtain: CopperOre']) {
      expect(r.applied.map((a) => a.override)).not.toContain(key);
      expect(r.notes).toContainEqual({ text: `${key}: changed nothing`, from: 'recipe-overrides' });
    }
  });

  it('reports a step entry that changes nothing, or names a step it cannot make', () => {
    const overrides = {
      ...OVERRIDES,
      steps: {
        ...OVERRIDES.steps,
        // What the Iron Sword's page already states: the wiki was fixed.
        'SwordIron@2': { inputs: [['Wood', 1], ['Iron', 10], ['LeatherScraps', 2]] as [ItemId, number][], reason: 'Fixed since.' },
        // A sixth quality, after a fifth the sword does not have.
        'SwordIron@6': { inputs: [['Iron', 50]] as [ItemId, number][], reason: 'No such step.' },
        // A material no page describes.
        'SwordIron@3': { inputs: [['Unobtainium', 1]] as [ItemId, number][], reason: 'Misspelt.' },
      },
    };
    const { graph: g, report: r } = assembleGraph(WORLD, REDIRECTS, BUILT_AT, overrides);
    expect(stepsOf(g, 'SwordIron')).toEqual(steps('SwordIron'));
    for (const key of ['SwordIron@2', 'SwordIron@6', 'SwordIron@3']) {
      expect(r.applied.map((a) => a.override)).not.toContain(`steps: ${key}`);
      expect(r.notes).toContainEqual({ text: `steps: ${key}: changed nothing`, from: 'recipe-overrides' });
    }
  });
});

describe('assembleGraph: the report', () => {
  it("keeps the item's own page where two pages state the same step", () => {
    // The Troll hide cape is stated on its own page and in the Troll Set's Cape tab.
    expect(report.duplicates).toContainEqual({
      product: 'CapeTrollHide',
      quality: 1,
      kept: 'Troll Hide Cape',
      dropped: 'Troll Set#Cape',
    });
    expect(steps('CapeTrollHide').map((r) => [r.quality, r.from, r.stationLevel])).toEqual([
      [1, 'Troll Hide Cape', 2],
      [2, 'Troll Set#Cape', 3],
      [3, 'Troll Set#Cape', 4],
      [4, 'Troll Set#Cape', 5],
    ]);
    // One item, described on its own page.
    expect(graph.items.filter((i) => i.id === 'CapeTrollHide')).toEqual([
      expect.objectContaining({ slug: 'troll-hide-cape', maxQuality: 4 }),
    ]);
    // A station's table of extensions restates the extension's own recipe.
    expect(report.duplicates).toContainEqual({
      product: 'forge_ext5',
      quality: 1,
      kept: 'Forge Cooler',
      dropped: 'Forge#Upgrades',
    });
  });

  it('lists a step two pages state at different costs, until an override settles it', () => {
    expect(report.costConflicts).toEqual([]);
    // The Troll hide cape's own page says 12 Troll hide; the Troll Set's Cape tab says 10.
    const cape = made('Troll Hide Cape', 'CapeTrollHide', 'Workbench', [['Troll hide', 12], ['Bone fragments', 10]], {
      level: 2,
      categories: ['Armor', 'Capes'],
      boxTitle: 'Troll hide cape',
    });
    const world = WORLD.map((page) => (page.title === 'Troll Hide Cape' ? cape : page));
    const { graph: g, report: r } = assembleGraph(world, REDIRECTS, BUILT_AT);
    expect(r.costConflicts).toEqual([
      {
        product: 'CapeTrollHide',
        quality: 1,
        statements: [
          { from: 'Troll Hide Cape', inputs: [['TrollHide', 12], ['BoneFragments', 10]], stationLevel: 2 },
          { from: 'Troll Set#Cape', inputs: [['TrollHide', 10], ['BoneFragments', 10]], stationLevel: 2 },
        ],
      },
    ]);
    // The item's own page is kept meanwhile, as for any step stated twice.
    expect(stepsOf(g, 'CapeTrollHide')[0]!.inputs).toEqual([['TrollHide', 12], ['BoneFragments', 10]]);

    // An entry for the step settles it, even one that keeps what the own page says.
    for (const qty of [10, 12]) {
      const settled = assembleGraph(world, REDIRECTS, BUILT_AT, {
        ...OVERRIDES,
        steps: { ...OVERRIDES.steps, 'CapeTrollHide@1': { inputs: [['TrollHide', qty], ['BoneFragments', 10]], reason: 'Settled.' } },
      });
      expect(settled.report.costConflicts).toEqual([]);
      expect(stepsOf(settled.graph, 'CapeTrollHide')[0]!.inputs).toEqual([['TrollHide', qty], ['BoneFragments', 10]]);
      expect(settled.report.applied).toContainEqual({ override: 'steps: CapeTrollHide@1', reason: 'Settled.', count: 1 });
    }
  });

  it("reports an upgrade off the game's rule, and leaves it for the maths to name until an override settles it", () => {
    // Every upgrade costs the same amount again per quality: the step to
    // quality q is (q - 1) times the step to quality 2, as the Iron Sword's
    // 10, 20 and 30 Iron are. A fourth step twice the third is a slip.
    expect(report.costSuspects).toEqual([]);
    const sword = levelledPage('Slipped Sword', 'SwordSlipped', link('Forge'), [
      [1, [['Wood', 2], ['Iron', 20]]],
      [2, [['Iron', 10]]],
      [3, [['Iron', 20]]],
      [4, [['Iron', 40]]],
    ]);
    const { graph: g, report: r } = assembleGraph([...WORLD, sword], REDIRECTS, BUILT_AT);
    expect(r.costSuspects).toEqual([
      { product: 'SwordSlipped', quality: 4, from: 'Slipped Sword', stated: [['Iron', 40]], linear: [['Iron', 30]] },
    ]);
    // Left out of the graph, so that no total counts it: the item still goes
    // up to quality 4, and the maths names the step it cannot price.
    expect(stepsOf(g, 'SwordSlipped').map((s) => s.quality)).toEqual([1, 2, 3]);
    expect(g.items.find((i) => i.id === 'SwordSlipped')!.maxQuality).toBe(4);
    expect(missingSteps(indexGraph(g), 'SwordSlipped', 0, 4)).toEqual([4]);

    const settled = assembleGraph([...WORLD, sword], REDIRECTS, BUILT_AT, {
      ...OVERRIDES,
      steps: { ...OVERRIDES.steps, 'SwordSlipped@4': { inputs: [['Iron', 30]], reason: 'The rule.' } },
    });
    expect(settled.report.costSuspects).toEqual([]);
    expect(stepsOf(settled.graph, 'SwordSlipped')[3]).toMatchObject({ quality: 4, stationLevel: 4, inputs: [['Iron', 30]] });
  });

  it("settles the Root Set's fourth steps, which its tabs double, from the overrides", () => {
    // Root 2, 4, 8 and Ancient bark 5, 10, 20; the Armor page states 2, 4, 6 and 5, 10, 15.
    for (const id of ['HelmetRoot', 'ArmorRootChest', 'ArmorRootLegs']) {
      expect(steps(id)[3]!.inputs).toEqual([['Root', 6], ['ElderBark', 15]]);
      expect(report.applied).toContainEqual(expect.objectContaining({ override: `steps: ${id}@4`, count: 1 }));
    }
  });

  it("reports a level past the station's stated maximum and keeps the level stated", () => {
    const overforged = made('Overforged Sword', 'SwordOverforged', 'Forge', [['Wood', 2]], {
      level: 8,
      categories: ['Weapons'],
    });
    const { graph: g, report: r } = assembleGraph([...WORLD, overforged], REDIRECTS, BUILT_AT);
    expect(r.levelConflicts).toEqual([{ station: 'forge', stated: 7, required: 8, from: 'Overforged Sword' }]);
    expect(stepsOf(g, 'SwordOverforged')[0]!.stationLevel).toBe(8);
    expect(g.items.find((i) => i.id === 'forge')!.station!.maxLevel).toBe(7);
  });

  it('counts the names it cannot resolve, and keeps them in their recipes', () => {
    expect(report.unresolved).toContainEqual({ text: 'Cloudberries', from: 'Anti-Sting Concoction#Mead base', count: 1 });
    expect(steps('MeadBaseBugRepellent')[0]!.inputs).toContainEqual(['page:cloudberries', 10]);
    expect(item('page:cloudberries')).toEqual({ id: 'page:cloudberries', en: 'Cloudberries', kind: 'virtual', maxQuality: 1 });
  });

  it('never makes a recipe of its own product: an input named like it is another thing', () => {
    // The Mysterious Rock is made from a rock of the same name, linked to its own page.
    const rock = infoboxPage(
      'Mysterious Rock',
      [
        data('Source', link('Workbench')),
        data(
          'Crafting Materials',
          `<ul><li><strong class="mw-selflink selflink">Mysterious Rock</strong> x1</li><li>${link('Coal')} x1</li></ul>`,
        ),
      ],
      ['Misc structures', 'Storage'],
    );
    const fixed = assembleGraph([...WORLD, rock], REDIRECTS, BUILT_AT);
    expect(stepsOf(fixed.graph, 'Placeable_HardRock')[0]!.inputs).toEqual([['Stonerock', 1], ['Coal', 1]]);
    expect(fixed.graph.items.find((i) => i.id === 'Stonerock')).toMatchObject({ en: 'Mysterious Rock', kind: 'virtual' });

    const plain = assembleGraph([...WORLD, rock], REDIRECTS, BUILT_AT, { ...OVERRIDES, internalIds: {} });
    expect(stepsOf(plain.graph, 'page:mysterious-rock')[0]!.inputs).toEqual([
      ['page:mysterious-rock#mysterious-rock', 1],
      ['Coal', 1],
    ]);
    expect(plain.report.unresolved).toContainEqual({ text: 'Mysterious Rock', from: 'Mysterious Rock', count: 1 });
    expect(plain.graph.recipes.filter((r) => r.inputs.some(([id]) => id === r.product))).toEqual([]);
  });

  it('keeps a material that names its own product by another name, and reports the cycle', () => {
    // Only a material named like the thing being made is another thing of that name.
    const thing = infoboxPage(
      'Thing C',
      [data('Internal ID', 'ThingC'), data('Source', link('Workbench')), data('Crafting Materials', `<ul><li>${link('Thing See')} x1</li></ul>`)],
      ['Materials'],
    );
    const redirects: Redirects = new Map([...REDIRECTS, ['Thing See', { title: 'Thing C', fragment: null }]]);
    const { graph: g, report: r } = assembleGraph([...WORLD, thing], redirects, BUILT_AT);
    expect(stepsOf(g, 'ThingC')[0]!.inputs).toEqual([['ThingC', 1]]);
    expect(r.cycles).toEqual([['ThingC']]);
  });

  it("names what a redirect puts in a section of another thing's page as a thing of that page, wherever it is used", () => {
    // "Dyrnwyn tip fragment" redirects to a section of the Dyrnwyn's page that
    // is no tab or row of it: the fragment, never the sword.
    const tip = '<a href="/wiki/Dyrnwyn_tip_fragment" class="mw-redirect">Dyrnwyn tip fragment</a>';
    const sword = infoboxPage(
      'Dyrnwyn',
      [data('Internal ID', 'SwordDyrnwyn'), data('Source', link('Forge')), data('Crafting Materials', `<ul><li>${tip} x1</li><li>${link('Iron')} x20</li></ul>`)],
      ['Weapons'],
    );
    const charm = infoboxPage(
      'Fragment Charm',
      [data('Internal ID', 'FragmentCharm'), data('Source', link('Workbench')), data('Crafting Materials', `<ul><li>${tip} x1</li></ul>`)],
      ['Trinket'],
    );
    const redirects: Redirects = new Map([...REDIRECTS, ['Dyrnwyn tip fragment', { title: 'Dyrnwyn', fragment: 'Dyrnwyn fragments' }]]);
    const { graph: g, report: r } = assembleGraph([...WORLD, sword, charm], redirects, BUILT_AT);
    const fragment = 'page:dyrnwyn#dyrnwyn-tip-fragment';
    expect(stepsOf(g, 'SwordDyrnwyn')[0]!.inputs).toEqual([[fragment, 1], ['Iron', 20]]);
    expect(stepsOf(g, 'FragmentCharm')[0]!.inputs).toEqual([[fragment, 1]]);
    expect(g.items.find((i) => i.id === fragment)).toMatchObject({
      en: 'Dyrnwyn tip fragment',
      slug: 'dyrnwyn',
      anchor: 'dyrnwyn-tip-fragment',
      kind: 'virtual',
    });
    // Described on the wiki, in a section a redirect names: not an unknown name.
    expect(r.unresolved.map((u) => u.text)).not.toContain('Dyrnwyn tip fragment');
    expect(r.cycles).toEqual([]);
  });

  it('counts a quality level whose recipe nobody could read, so the maths names the missing step', () => {
    // Quality 4's materials run into one line, as an edit could leave them:
    // the extractor keeps the cell as a note that starts with its level.
    // The sword's table of upgrades, which states the step as well, goes.
    const page = (JSON.parse(readFileSync('tests/fixtures/Iron_Sword.json', 'utf8')) as Saved).parse;
    const $ = load(page.text);
    $('aside.portable-infobox .pi-data')
      .filter((_, el) => /crafting materials/i.test($(el).find('.pi-data-label').text()))
      .last()
      .find('.pi-data-value')
      .html('Wood x3, Iron x30, Leather scraps x6');
    $('table')
      .filter((_, el) => /^quality$/i.test($(el).find('tr').first().children().first().text().trim()))
      .remove();
    const sword: AssemblyPage = { ...saved('Iron_Sword'), recipes: extractRecipes($.html(), { title: page.title }) };
    expect(sword.recipes.infoboxes[0]!.levels.map((l) => l.quality)).toEqual([1, 2, 3]);
    expect(sword.recipes.upgradeTable).toBeNull();

    const { graph: g, report: r } = assembleGraph(
      WORLD.map((p) => (p.title === 'Iron Sword' ? sword : p)),
      REDIRECTS,
      BUILT_AT,
    );
    expect(g.items.find((i) => i.id === 'SwordIron')!.maxQuality).toBe(4);
    expect(missingSteps(indexGraph(g), 'SwordIron', 0, 4)).toEqual([4]);
    expect(r.notes).toContainEqual({ text: expect.stringMatching(/^Quality 4: /), from: 'Iron Sword' });
  });

  it("doubts a yield the food table contradicts, until an override settles it", () => {
    // The Food page's table says one craft of boar jerky makes 2; this infobox says nothing.
    const jerky = made('Boar Jerky', 'BoarJerky', 'Cauldron', [['Honey', 1]], { categories: ['Food'] });
    const doubted = assembleGraph([...WORLD, jerky], REDIRECTS, BUILT_AT);
    expect(stepsOf(doubted.graph, 'BoarJerky')[0]).toMatchObject({ yield: 1, yieldKnown: false });
    expect(doubted.report.yieldSuspects).toEqual([{ product: 'BoarJerky', from: 'Boar Jerky' }]);

    const settled = assembleGraph([...WORLD, jerky], REDIRECTS, BUILT_AT, {
      ...OVERRIDES,
      yields: { BoarJerky: { yield: 2, reason: 'The food table says two.' } },
    });
    expect(stepsOf(settled.graph, 'BoarJerky')[0]).toMatchObject({ yield: 2, yieldKnown: true });
    expect(settled.report.yieldSuspects).toEqual([]);
  });

  it('counts what it built, and lists the cycles it finds', () => {
    expect(report).toMatchObject({
      items: graph.items.length,
      recipes: graph.recipes.length,
      products: new Set(graph.recipes.map((r) => r.product)).size,
      cycles: [],
    });
    // What every breakdown ends in: materials with no step the maths plans with.
    const raw = graph.items.filter(
      (i) =>
        graph.recipes.some((r) => r.inputs.some(([id]) => id === i.id)) &&
        !graph.recipes.some((r) => r.product === i.id && r.quality === 1 && !r.alt),
    );
    expect(report.raw).toBe(raw.length);

    const loop = [
      made('Thing A', 'ThingA', 'Workbench', [['Thing B', 1]]),
      made('Thing B', 'ThingB', 'Workbench', [['Thing A', 1]]),
    ];
    expect(assembleGraph([...WORLD, ...loop], REDIRECTS, BUILT_AT).report.cycles).toEqual([['ThingA', 'ThingB']]);
  });

  it('says what each extractor note is and where it came from', () => {
    expect(report.notes).toContainEqual({ text: expect.stringContaining('Small:'), from: 'Yuleklapp' });
  });
});

describe("assembleGraph: an item's table of upgrades", () => {
  /** What the saved pages below name and WORLD lacks. */
  const TABLE_WORLD: AssemblyPage[] = [
    material('Black Metal', 'BlackMetal'),
    material('Linen Thread', 'LinenThread'),
    material('Silver', 'Silver'),
    material('Yggdrasil Wood', 'YggdrasilWood'),
    material('Blood Clot', 'GiantBloodSack'),
    material('Refined Eitr', 'Eitr'),
    station('Galdr Table', 'piece_magetable', 5),
  ];
  const world = (...pages: AssemblyPage[]) => [...WORLD, ...TABLE_WORLD, ...pages];
  /** The overrides without the steps they settle, to see what the wiki states. */
  const noSteps = { ...OVERRIDES, steps: {} };
  /** Iron at each quality, the fourth as given: `[quality, materials]`. */
  const iron = (fourth: number): [number, [string, number][]][] => [
    [1, [['Iron', 20]]],
    [2, [['Iron', 10]]],
    [3, [['Iron', 20]]],
    [4, [['Iron', fourth]]],
  ];

  it("takes a quality only the table states, and holds it back where it is off the game's rule", () => {
    // The Staff of Protection's infobox stops at quality 3; its table states
    // a fourth, at Galdr table level 4, at twice the third step's cost.
    const pages = world(saved('recipes/Staff_of_Protection'));
    const plain = assembleGraph(pages, REDIRECTS, BUILT_AT, noSteps);
    expect(stepsOf(plain.graph, 'StaffShield').map((s) => [s.quality, s.from])).toEqual([
      [1, 'Staff of Protection'],
      [2, 'Staff of Protection'],
      [3, 'Staff of Protection'],
    ]);
    expect(plain.graph.items.find((i) => i.id === 'StaffShield')!.maxQuality).toBe(4);
    expect(plain.report.costSuspects.filter((s) => s.product === 'StaffShield')).toEqual([
      {
        product: 'StaffShield',
        quality: 4,
        from: 'Staff of Protection#Upgrade information',
        stated: [['YggdrasilWood', 40], ['GiantBloodSack', 8], ['Eitr', 32]],
        linear: [['YggdrasilWood', 30], ['GiantBloodSack', 6], ['Eitr', 24]],
      },
    ]);

    const { graph: g, report: r } = assembleGraph(pages, REDIRECTS, BUILT_AT);
    expect(stepsOf(g, 'StaffShield')[3]).toEqual({
      product: 'StaffShield',
      quality: 4,
      station: 'piece_magetable',
      stationLevel: 4,
      yield: 1,
      yieldKnown: true,
      inputs: [['YggdrasilWood', 30], ['GiantBloodSack', 6], ['Eitr', 24]],
      method: 'craft',
      from: 'Staff of Protection#Upgrade information',
    });
    expect(r.costSuspects).toEqual([]);
    expect(r.applied).toContainEqual({ override: 'steps: StaffShield@4', reason: OVERRIDES.steps['StaffShield@4']!.reason, count: 1 });
    // A page stating its own steps twice is no second page stating them.
    expect(r.duplicates.filter((d) => d.product === 'StaffShield')).toEqual([]);
  });

  it('lists a first step the infobox and the table cost differently, until an override settles it', () => {
    // The Wood Tower Shield's infobox asks 4 Leather scraps, its table 6; the
    // Pointy Hat's 2 Deer hide, and 3. The game's rule says nothing of a first step.
    const pages = world(saved('recipes/Pointy_Hat'), saved('recipes/Wood_Tower_Shield'));
    const plain = assembleGraph(pages, REDIRECTS, BUILT_AT, noSteps);
    expect(plain.report.costConflicts).toEqual([
      {
        product: 'HelmetPointyHat',
        quality: 1,
        statements: [
          { from: 'Pointy Hat', inputs: [['Coal', 5], ['Bronze', 1], ['DeerHide', 2]], stationLevel: 1 },
          { from: 'Pointy Hat#Upgrade information', inputs: [['DeerHide', 3], ['Coal', 5], ['Bronze', 1]], stationLevel: 1 },
        ],
      },
      {
        product: 'ShieldWoodTower',
        quality: 1,
        statements: [
          { from: 'Wood Tower Shield', inputs: [['Wood', 10], ['LeatherScraps', 4]], stationLevel: 1 },
          { from: 'Wood Tower Shield#Upgrade information', inputs: [['Wood', 10], ['LeatherScraps', 6]], stationLevel: 1 },
        ],
      },
    ]);
    // The infobox is kept meanwhile, as the item's own page is for any step stated twice.
    expect(stepsOf(plain.graph, 'ShieldWoodTower')[0]!.inputs).toEqual([['Wood', 10], ['LeatherScraps', 4]]);

    const { graph: g, report: r } = assembleGraph(pages, REDIRECTS, BUILT_AT);
    expect(r.costConflicts).toEqual([]);
    const ix = indexGraph(g);
    // "Cost to max is 25 wood and 15 leather scraps", and the hat's "33 Deer hide".
    expect(Object.fromEntries(totalCost(ix, 'ShieldWoodTower', 0, 3))).toEqual({ Wood: 25, LeatherScraps: 15 });
    expect(Object.fromEntries(totalCost(ix, 'HelmetPointyHat', 0, 4))).toEqual({ Coal: 5, Bronze: 1, DeerHide: 33 });
  });

  it("keeps the statement the game's rule bears out where the table doubles a step, and notes the other", () => {
    // The Black Metal Atgeir's infobox upgrades to quality 4 for 45 Black
    // metal, three times the second step's 15; its table says 60. No
    // override names the atgeir.
    expect(Object.keys(OVERRIDES.steps).filter((key) => key.startsWith('AtgeirBlackmetal@'))).toEqual([]);
    const { graph: g, report: r } = assembleGraph(world(saved('recipes/Black_Metal_Atgeir')), REDIRECTS, BUILT_AT);
    expect(stepsOf(g, 'AtgeirBlackmetal')[3]).toMatchObject({
      inputs: [['BlackMetal', 45], ['LinenThread', 15]],
      from: 'Black Metal Atgeir',
    });
    expect(r.costConflicts).toEqual([]);
    expect(r.costSuspects).toEqual([]);
    expect(r.overruled).toEqual([
      {
        product: 'AtgeirBlackmetal',
        quality: 4,
        from: 'Black Metal Atgeir#Upgrade information',
        stated: [['BlackMetal', 60], ['LinenThread', 20]],
        kept: { from: 'Black Metal Atgeir', inputs: [['BlackMetal', 45], ['LinenThread', 15]] },
      },
    ]);

    // The other way round, the table wins: an infobox off the rule is a slip like any other.
    const sword = levelledPage('Ruled Sword', 'SwordRuled', link('Forge'), iron(40), {
      after: upgradeTable('Forge', iron(30).map(([quality, materials]) => [quality, quality, materials])),
    });
    const ruled = assembleGraph([...WORLD, sword], REDIRECTS, BUILT_AT);
    expect(stepsOf(ruled.graph, 'SwordRuled')[3]).toMatchObject({ inputs: [['Iron', 30]], from: 'Ruled Sword#Upgrade information' });
    expect(ruled.report.costSuspects).toEqual([]);
    expect(ruled.report.costConflicts).toEqual([]);
    expect(ruled.report.overruled).toEqual([
      {
        product: 'SwordRuled',
        quality: 4,
        from: 'Ruled Sword',
        stated: [['Iron', 40]],
        kept: { from: 'Ruled Sword#Upgrade information', inputs: [['Iron', 30]] },
      },
    ]);
  });

  it('settles by the rule a step two pages cost differently, whichever page is off it', () => {
    // A cape's own page doubling its fourth step, where the set's Cape tab
    // states it by the rule: the set's is kept, though the own page comes first otherwise.
    const cape = levelledPage(
      'Troll Hide Cape',
      'CapeTrollHide',
      link('Workbench'),
      [
        [1, [['Troll hide', 10], ['Bone fragments', 10]]],
        [2, [['Troll hide', 5], ['Bone fragments', 5]]],
        [3, [['Troll hide', 10], ['Bone fragments', 10]]],
        [4, [['Troll hide', 20], ['Bone fragments', 20]]],
      ],
      { firstLevel: 2 },
    );
    const { graph: g, report: r } = assembleGraph(
      WORLD.map((page) => (page.title === 'Troll Hide Cape' ? cape : page)),
      REDIRECTS,
      BUILT_AT,
    );
    expect(stepsOf(g, 'CapeTrollHide')[3]).toMatchObject({ inputs: [['TrollHide', 15], ['BoneFragments', 15]], from: 'Troll Set#Cape' });
    expect(r.costConflicts).toEqual([]);
    expect(r.overruled).toEqual([
      {
        product: 'CapeTrollHide',
        quality: 4,
        from: 'Troll Hide Cape',
        stated: [['TrollHide', 20], ['BoneFragments', 20]],
        kept: { from: 'Troll Set#Cape', inputs: [['TrollHide', 15], ['BoneFragments', 15]] },
      },
    ]);
    // Two pages state the step, and the one kept is the one listed as kept.
    expect(r.duplicates).toContainEqual({ product: 'CapeTrollHide', quality: 4, kept: 'Troll Set#Cape', dropped: 'Troll Hide Cape' });
  });

  it('holds back a fourth step the infobox and the table both double, until an override settles it', () => {
    const pages = world(saved('recipes/Black_Metal_Sword'));
    const plain = assembleGraph(pages, REDIRECTS, BUILT_AT, noSteps);
    expect(plain.report.costSuspects.filter((s) => s.product === 'SwordBlackmetal')).toEqual([
      {
        product: 'SwordBlackmetal',
        quality: 4,
        from: 'Black Metal Sword',
        stated: [['BlackMetal', 40], ['LinenThread', 20]],
        linear: [['BlackMetal', 30], ['LinenThread', 15]],
      },
    ]);
    const { graph: g, report: r } = assembleGraph(pages, REDIRECTS, BUILT_AT);
    expect(r.costSuspects).toEqual([]);
    expect(Object.fromEntries(totalCost(indexGraph(g), 'SwordBlackmetal', 0, 4))).toEqual({ FineWood: 2, BlackMetal: 80, LinenThread: 35 });
  });

  it("lists steps whose statements disagree on the station's level, which no rule settles", () => {
    // As the Black Metal Battleaxe's infobox asks Forge levels 4 to 7, and its table 3 to 6.
    const levels = iron(30).slice(0, 2);
    const axe = levelledPage('Late Axe', 'AxeLate', link('Forge'), levels, {
      firstLevel: 4,
      after: upgradeTable('Forge', levels.map(([quality, materials]) => [quality, quality + 2, materials])),
    });
    const { graph: g, report: r } = assembleGraph([...WORLD, axe], REDIRECTS, BUILT_AT);
    expect(r.costConflicts).toEqual([
      {
        product: 'AxeLate',
        quality: 1,
        statements: [
          { from: 'Late Axe', inputs: [['Iron', 20]], stationLevel: 4 },
          { from: 'Late Axe#Upgrade information', inputs: [['Iron', 20]], stationLevel: 3 },
        ],
      },
      {
        product: 'AxeLate',
        quality: 2,
        statements: [
          { from: 'Late Axe', inputs: [['Iron', 10]], stationLevel: 5 },
          { from: 'Late Axe#Upgrade information', inputs: [['Iron', 10]], stationLevel: 4 },
        ],
      },
    ]);
    expect(stepsOf(g, 'AxeLate').map((s) => s.stationLevel)).toEqual([4, 5]);

    const settled = assembleGraph([...WORLD, axe], REDIRECTS, BUILT_AT, {
      ...OVERRIDES,
      steps: {
        ...OVERRIDES.steps,
        'AxeLate@1': { inputs: [['Iron', 20]], stationLevel: 3, reason: 'Its table.' },
        'AxeLate@2': { inputs: [['Iron', 10]], stationLevel: 4, reason: 'Its table.' },
      },
    });
    expect(settled.report.costConflicts).toEqual([]);
    expect(stepsOf(settled.graph, 'AxeLate').map((s) => s.stationLevel)).toEqual([3, 4]);

    // An entry that states the materials alone leaves the level to settle.
    const materialsOnly = assembleGraph([...WORLD, axe], REDIRECTS, BUILT_AT, {
      ...OVERRIDES,
      steps: { ...OVERRIDES.steps, 'AxeLate@2': { inputs: [['Iron', 12]], reason: 'A typo.' } },
    });
    expect(materialsOnly.report.costConflicts.map((c) => c.quality)).toEqual([1, 2]);
    expect(stepsOf(materialsOnly.graph, 'AxeLate')[1]).toMatchObject({ inputs: [['Iron', 12]], stationLevel: 5 });
  });

  it("settles the Padded Armor's cuirass and greaves, whose tabs repeat the helmet's costs", () => {
    const pages = world(saved('recipes/Padded_Armor'));
    const plain = assembleGraph(pages, REDIRECTS, BUILT_AT, noSteps);
    const costs = (g: RecipeGraph, id: ItemId) => stepsOf(g, id).map((s) => s.inputs);
    expect(costs(plain.graph, 'ArmorPaddedCuirass')).toEqual(costs(plain.graph, 'HelmetPadded'));

    const { graph: g, report: r } = assembleGraph(pages, REDIRECTS, BUILT_AT);
    for (const id of ['ArmorPaddedCuirass', 'ArmorPaddedGreaves']) {
      expect(costs(g, id)).toEqual([
        [['Iron', 10], ['LinenThread', 20]],
        [['Iron', 3], ['LinenThread', 10]],
        [['Iron', 6], ['LinenThread', 20]],
        [['Iron', 9], ['LinenThread', 30]],
      ]);
      // The Armor page's numbers: "Iron: 10/3/6/9, Linen thread: 20/10/20/30".
      expect(Object.fromEntries(totalCost(indexGraph(g), id, 0, 4))).toEqual({ Iron: 28, LinenThread: 80 });
    }
    expect(costs(g, 'HelmetPadded')[3]).toEqual([['Iron', 15], ['LinenThread', 30]]);
    expect(r.costSuspects).toEqual([]);
  });
});

describe('assembleGraph: the graph as a whole', () => {
  it('is the same graph whatever order the pages come in', () => {
    const reversed = assembleGraph([...WORLD].reverse(), REDIRECTS, BUILT_AT);
    expect(reversed.graph).toEqual(graph);
    expect(graph.version).toMatch(/^[0-9a-f]{64}$/);
    expect(graph).toMatchObject({ v: 1, builtAt: BUILT_AT });
  });

  it('changes its version with its content, and only with it', () => {
    expect(assembleGraph(WORLD, REDIRECTS, '2026-10-28T00:00:00.000Z').graph.version).toBe(graph.version);
    const cheaper = WORLD.map((page) =>
      page.title === 'Iron Sword' ? made('Iron Sword', 'SwordIron', 'Forge', [['Wood', 1]], { categories: ['Weapons'] }) : page,
    );
    expect(assembleGraph(cheaper, REDIRECTS, BUILT_AT).graph.version).not.toBe(graph.version);
  });

  it('travels through the codec unchanged', () => {
    expect(decodeGraph(JSON.parse(JSON.stringify(encodeGraph(graph))))).toEqual(graph);
  });

  it('gives the maths the numbers a player would count by hand', () => {
    const ix = indexGraph(graph);
    const karve = expandRaw(ix, new Map([['Karve', 1]]));
    expect(Object.fromEntries(karve.raw)).toEqual({ FineWood: 30, DeerHide: 10, Resin: 20, CopperOre: 8, TinOre: 4 });
    expect(karve.fuel.get('Coal')).toBe(24);
    expect(Object.fromEntries(totalCost(ix, 'SwordIron', 0, 4))).toEqual({ Wood: 8, Iron: 80, LeatherScraps: 15 });
    const cuirass = totalCost(ix, 'ArmorBronzeChest', 0, 4);
    expect(Object.fromEntries(cuirass)).toEqual({ Bronze: 23, DeerHide: 2 });
    expect(Object.fromEntries(expandRaw(ix, cuirass).raw)).toEqual({ CopperOre: 46, TinOre: 23, DeerHide: 2 });
    const mead = expandRaw(ix, new Map([['MeadPoisonResist', 6]]));
    expect(Object.fromEntries(mead.raw)).toEqual({ Honey: 10, Thistle: 5, NeckTail: 1, Coal: 10 });
  });
});

describe('redirectTitles', () => {
  it('lists every title the assembly may look up as a redirect, once each', () => {
    const titles = redirectTitles(WORLD);
    expect(titles).toEqual(
      expect.arrayContaining(['Bronze nails', 'Mead base: Poison resistance', 'Mead ketill', 'Forge cooler', "Queen's jam"]),
    );
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("asks after the creature each trophy is named for, which the assembly looks up too", () => {
    const hammer = made('Troll Hammer', 'TrollHammer', 'Workbench', [['Troll trophy', 1]], { categories: ['Weapons'] });
    expect(redirectTitles([...WORLD, hammer])).toEqual(expect.arrayContaining(['Troll trophy', 'Troll']));
  });

  it("asks after what an item's table of upgrades names, its station included", () => {
    const sword = levelledPage('Tabled Sword', 'SwordTabled', link('Forge'), [[1, [['Iron', 20]]]], {
      after: upgradeTable('Black forge', [
        [1, 1, [['Iron', 20]]],
        [2, 2, [['Black metal', 10]]],
      ]),
    });
    expect(redirectTitles([...WORLD, sword])).toEqual(expect.arrayContaining(['Black metal', 'Black forge']));
  });
});
