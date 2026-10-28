import type { ItemId, Obtain, RecipeMethod } from './types';

/**
 * Corrections to what the wiki states, applied by the assembly (assemble.ts)
 * every time it builds the recipe graph.
 *
 * The wiki is the source of every recipe, and it is right almost everywhere.
 * Where it is not (a material linked to the wrong page, two pieces sharing one
 * internal ID) or where it never says (what a smelter burns, that the
 * charcoal kiln turns wood into coal), the fix lives here, in the open, rather
 * than as a special case in the code: a person can read the whole list, see
 * why each entry exists, and delete it once the wiki is fixed.
 *
 * Every entry carries a one-line reason, and the graph's report lists each
 * one that changed something with that reason and how many times
 * (`applied`). One that changed nothing is reported too, as a note: the wiki
 * moved on, and the entry should go.
 *
 * Things are named the way the assembly names them:
 *
 * - an item by its id: the game's internal ID (`Coal`, `piece_workbench`);
 * - a page by its title, as the wiki writes it (`Wood Structures`);
 * - a place on a page by the page's title, `#`, and the tab of its infobox
 *   (`Troll Set#Tunic`) or the name of its row in a table
 *   (`Storage#Yuleklapp (small)`).
 */

/** Why an entry exists, in one line. */
type Reason = { reason: string };

export type RecipeOverrides = {
  /** Pages the graph leaves out entirely: console commands and test pages, which the game never lets a player make. */
  ignore: Record<string, Reason>;
  /**
   * A material whose link names the wrong page, by the title the link names,
   * and the page it should name. Applies to recipe materials only: "Root" in
   * a recipe is the item, while a Source naming Root means the creature.
   */
  linkFixes: Record<string, Reason & { to: string }>;
  /** The game's internal ID for a thing the wiki gives none, or another thing's, by where it is described. */
  internalIds: Record<string, Reason & { id: ItemId }>;
  /**
   * Recipes no recipe cell states: other ways to make a product (scrap
   * smelted into metal, wood burned into coal). Each is an alternative
   * (`alt` 1 and up), shown and usable by an inventory but never planned
   * with; `from` is the page whose text states it.
   */
  alternatives: (Reason & {
    product: ItemId;
    station: ItemId;
    inputs: [ItemId, number][];
    method: RecipeMethod;
    from: string;
  })[];
  /** What a station burns per craft besides the recipe's materials, by the station's id. */
  fuel: Record<ItemId, Reason & { fuel: [ItemId, number] }>;
  /**
   * An extension a station's Improvements leave out, by `Station page#Name`,
   * where the wiki says the station has it: the row of that name in the
   * station's table of extensions, with its recipe, or else a thing only
   * named, whose cost no page states yet. It comes after the extensions the
   * Improvements list; the level it adds is `stationMaxLevel`'s to say.
   */
  extensions: Record<string, Reason>;
  /**
   * A station's highest level, by its id, where the wiki contradicts itself
   * and the evidence settles which side is right. A contradiction nobody can
   * settle stays out of here and in the report's level conflicts.
   */
  stationMaxLevel: Record<ItemId, Reason & { maxLevel: number }>;
  /**
   * Stations whose levels past their highest are not in the game yet, by the
   * station's id: the pages of the things that need such a level print it
   * "(not yet available)". Those steps stay in the graph as the wiki states
   * them, past the station's highest level, and the report lists them apart
   * from the level conflicts, which are contradictions still to settle.
   */
  notYetAvailable: Record<ItemId, Reason>;
  /** How many one craft makes, by the product's id, where the wiki leaves it in doubt. */
  yields: Record<ItemId, Reason & { yield: number }>;
  /**
   * What a step costs, where the wiki states it wrong and its own pages
   * settle it, by `ItemId@quality` (`HelmetTrollLeather@2`): every material
   * of the step, which replace what each statement of it says (an item's
   * infobox, its table of upgrades, another page), and its station level
   * where that is wrong too. A quality nothing states is added, made at the
   * station of the step before it, one level higher unless `stationLevel`
   * says otherwise.
   *
   * An entry settles a step two statements cost differently where the
   * game's rule cannot (the report's cost conflicts: a first step, a station
   * level), and an upgrade off the rule that nothing states otherwise (its
   * cost suspects), which the graph otherwise leaves for the maths to name
   * rather than price. A statement off the rule beside one on it needs no
   * entry: the graph keeps the one on it.
   */
  steps: Record<string, Reason & { inputs: [ItemId, number][]; stationLevel?: number }>;
  /**
   * The station a list page's building pieces need nearby, by the page's
   * title, or by `Page#Row` for a piece the page says differs. A list's rows
   * name no station; the page's text does, once for all of them.
   */
  listStations: Record<string, Reason & { station: ItemId }>;
  /**
   * Where a thing made by hand is upgraded, by its id. Its Source, the
   * Player crafting menu, makes the first level only; the steps past it are
   * made where the game repairs it, at the level each tab states. Its table
   * of upgrades names that station ("Workbench level 1 2 3 4" on the Club),
   * and the assembly takes it from there; this is for a page that names it
   * only in its text. Left without one, those steps would ask for a level
   * of no station at all.
   */
  upgradeStations: Record<ItemId, Reason & { station: ItemId }>;
  /**
   * Trophies are listed on one page, by biome, and each is dropped by the
   * creature it is named after ("Deer trophy", the Deer). `page` is that
   * page; a trophy whose creature has no page of its own is reported.
   */
  trophies: Reason & { page: string };
  /** How a raw material is had, by its id, where its Source cannot say: a trader's price. Replaces what Source says. */
  obtain: Record<ItemId, Reason & { obtain: Obtain[] }>;
  /**
   * Spanish names for things with no article of their own to translate:
   * mead bases, cooked meats, doughs, armor pieces, trophies. By item id, in
   * groups that share a reason. A thing with an article is named at serve
   * time from its translation instead.
   */
  spanishNames: (Reason & { names: Record<ItemId, string> })[];
};

/**
 * The game's IDs a list page's table states in its "Internal id" column, as
 * `internalIds` entries by `Page#Row`. The extractor reads a row's name and
 * materials but not that column yet, and without these a piece would be
 * known by its row (`page:banners#black-banner`), an id a renamed row or a
 * piece moved to another list would change under every saved list.
 */
function tableIds(page: string, ids: Record<string, ItemId>): RecipeOverrides['internalIds'] {
  return Object.fromEntries(
    Object.entries(ids).map(([row, id]) => [`${page}#${row}`, { id, reason: `The ${page} table's Internal id column: ${id}.` }]),
  );
}

/** `steps` entries that share one reason: the steps of one page, or one slip the wiki repeats. */
function stepsOf(reason: string, steps: Record<string, [ItemId, number][]>): RecipeOverrides['steps'] {
  return Object.fromEntries(Object.entries(steps).map(([key, inputs]) => [key, { inputs, reason }]));
}

export const OVERRIDES: RecipeOverrides = {
  // The console-only pages (Cheat Sword, Cheat Sledge, CAPE TEST,
  // Trailership) state no recipe, so the graph leaves them out already.
  ignore: {},

  linkFixes: {
    Root: {
      to: 'Root (item)',
      reason: 'Root Set links its Root to the disambiguation page; the material is Root (item), as the Arbalest links it.',
    },
  },

  internalIds: {
    'Troll Set#Tunic': {
      id: 'ArmorTrollLeatherChest',
      reason: "The wiki copies the hood's ID (HelmetTrollLeather) onto the tunic.",
    },
    'Root Set#Legs': {
      id: 'ArmorRootLegs',
      reason: "The wiki copies the harnesk's ID (ArmorRootChest) onto the leggings.",
    },
    'Lox Fur Set#Cape': {
      id: 'CapeLox',
      reason: 'The set\'s Cape tab writes the ID with a space, "Cape Lox"; the Lox Cape page states CapeLox.',
    },
    'Mysterious Rock': {
      id: 'Placeable_HardRock',
      reason:
        'The Internal ID cell names two things, the placed rock (Placeable_HardRock) and the item; the recipe makes the placed one.',
    },
    'Mysterious Rock#Mysterious Rock': {
      id: 'Stonerock',
      reason: 'The rock the recipe consumes is the item of the same name, Stonerock, not the placed rock it makes.',
    },
    'Storage#Yuleklapp (small)': {
      id: 'piece_gift1',
      reason: "The Yuleklapp's Internal ID cell gives each size its own ID: piece_gift1 (small).",
    },
    'Storage#Yuleklapp (medium)': {
      id: 'piece_gift2',
      reason: "The Yuleklapp's Internal ID cell gives each size its own ID: piece_gift2 (medium).",
    },
    'Storage#Yuleklapp (large)': {
      id: 'piece_gift3',
      reason: "The Yuleklapp's Internal ID cell gives each size its own ID: piece_gift3 (large).",
    },
    'Storage#Small green pot': {
      id: 'piece_pot3',
      reason: "The Pots' Internal ID cell gives each size its own ID: piece_pot3 (small).",
    },
    'Storage#Medium green pot': {
      id: 'piece_pot1',
      reason: "The Pots' Internal ID cell gives each size its own ID: piece_pot1 (medium).",
    },
    'Storage#Large green pot': {
      id: 'piece_pot2',
      reason: "The Pots' Internal ID cell gives each size its own ID: piece_pot2 (large).",
    },
    ...tableIds('Banners', {
      'Black banner': 'piece_banner01',
      'Blue banner': 'piece_banner02',
      'White and red striped banner': 'piece_banner03',
      'Red banner': 'piece_banner04',
      'Green banner': 'piece_banner05',
      'Blue, red and white banner': 'piece_banner06',
      'White and blue striped banner': 'piece_banner07',
      'Yellow banner': 'piece_banner08',
      'Purple banner': 'piece_banner09',
      'Orange banner': 'piece_banner10',
      'White banner': 'piece_banner11',
    }),
    ...tableIds('Chairs', {
      Bench: 'piece_bench01',
      'Sitting log': 'piece_logbench01',
      Stool: 'piece_chair',
      'Black marble bench': 'piece_blackmarble_bench',
      'Ashwood bench': 'piece_blackwood_bench01',
      Chair: 'piece_chair02',
      'Darkwood chair': 'piece_chair03',
      'Raven throne': 'piece_throne01',
      'Stone throne': 'piece_throne02',
      'Black marble throne': 'piece_blackmarble_throne',
      'Bone throne': 'piece_bone_throne',
    }),
    ...tableIds('Rugs', {
      'Deer rug': 'rug_deer',
      'Bearskin rug': 'rug_Bjorn',
      'Wolf rug': 'rug_wolf',
      'Lox rug': 'rug_fur',
      Straw: 'rug_straw',
      'Hare rug': 'rug_hare',
      'Asksvin rug': 'rug_asksvin',
      'Blue jute carpet': 'jute_carpet_blue',
      'Red jute carpet': 'jute_carpet',
    }),
    ...tableIds('Tables', {
      Table: 'piece_table',
      'Round table': 'piece_table_round',
      'Long heavy table': 'piece_table_oak',
      'Black marble table': 'piece_blackmarble_table',
    }),
  },

  alternatives: [
    {
      product: 'Coal',
      station: 'charcoal_kiln',
      inputs: [['Wood', 1]],
      method: 'kiln',
      from: 'Charcoal Kiln',
      reason: 'The Charcoal Kiln page: it converts single units of Wood, Finewood or Corewood into coal.',
    },
    {
      product: 'Coal',
      station: 'charcoal_kiln',
      inputs: [['FineWood', 1]],
      method: 'kiln',
      from: 'Charcoal Kiln',
      reason: 'The Charcoal Kiln page: it converts single units of Wood, Finewood or Corewood into coal.',
    },
    {
      product: 'Coal',
      station: 'charcoal_kiln',
      inputs: [['RoundLog', 1]],
      method: 'kiln',
      from: 'Charcoal Kiln',
      reason: 'The Charcoal Kiln page: it converts single units of Wood, Finewood or Corewood into coal.',
    },
    {
      product: 'Copper',
      station: 'smelter',
      inputs: [['CopperScrap', 1]],
      method: 'smelt',
      from: 'Copper Scrap',
      reason: 'The Copper Scrap page: copper scrap can be refined into Copper in a Smelter.',
    },
    {
      product: 'Iron',
      station: 'smelter',
      inputs: [['IronOre', 1]],
      method: 'smelt',
      from: 'Iron Ore',
      reason: 'The Iron Ore page: iron ore can be turned into Iron at a Smelter.',
    },
    {
      product: 'Bronze',
      station: 'smelter',
      inputs: [['BronzeScrap', 1]],
      method: 'smelt',
      from: 'Scrap Bronze',
      reason: 'The Scrap Bronze page: scrap bronze can be turned into Bronze in a Smelter.',
    },
  ],

  fuel: {
    smelter: {
      fuel: ['Coal', 2],
      reason: 'The Smelter page: about one Coal every 15 seconds, and 30 seconds per bar.',
    },
    blastfurnace: {
      fuel: ['Coal', 2],
      reason: 'The Blast Furnace page: about one Coal every 15 seconds, and 30 seconds per bar.',
    },
  },

  // Version 1.0 (9 September 2026) gave three stations one extension each:
  // "Black Forge Extension: Smith's Aprons", "Cauldron Extension: Smoker",
  // "Galdr Table Extension: Standing Loom" (the Version history page, under
  // 1.0.00). The stations' infoboxes predate them, Max Level and
  // Improvements both, so each is added here, and its level below. Every
  // station page counts one level per extension ("up to level 5 by building
  // the following structures", four of them, on the Black Forge). Smith's
  // Aprons needs no entry: its own page says it upgrades the Black forge.
  extensions: {
    'Cauldron#Smoker': {
      reason:
        'Version history, 1.0.00: "Cauldron Extension: Smoker". The Cauldron\'s table states its recipe; its Improvements still list five.',
    },
    'Galdr Table#Standing Loom': {
      reason:
        'Version history, 1.0.00: "Galdr Table Extension: Standing Loom". The Galdr Table page, last edited before 1.0, neither lists it nor states its cost.',
    },
  },

  // The pages of the things made at the levels these extensions add (36
  // steps at Black forge level 6, 8 at Galdr table level 5) print those
  // levels "(not yet available)" or "(currently unobtainable)". 29 of the 38
  // pages are as they were on 20 August 2026, before 1.0; the 9 edited since
  // kept the mark, though for the Black forge its own page now says otherwise.
  stationMaxLevel: {
    blackforge: {
      maxLevel: 6,
      reason: 'The Black Forge page: Smith\'s Aprons, "as of 1.0, ... enable Black Forge level 6"; its infobox still says 5.',
    },
    piece_cauldron: {
      maxLevel: 7,
      reason: 'Version history, 1.0.00: the Smoker is a sixth Cauldron extension; the Cauldron page still says "up to level 6", for five.',
    },
    piece_magetable: {
      maxLevel: 5,
      reason: 'Version history, 1.0.00: the Standing Loom is a fourth Galdr table extension; the Galdr Table page, older, says 4.',
    },
  },

  notYetAvailable: {
    blackforge: {
      reason:
        'The 22 things that need Black forge level 7 print it "(not yet available)", and 1.0 gave the Black forge one extension, for level 6.',
    },
  },

  yields: {},

  // The game charges every upgrade the same materials again at each quality:
  // the step to quality q is (q - 1) times the step to quality 2, as 145 of
  // the 170 things whose pages state a third quality follow throughout. The
  // assembly keeps a statement on that line over one off it (19 tables of
  // upgrades and set tabs double a fourth step their item's infobox states
  // by the rule, and Dundr's table writes 5 Ashwood for its 15), and holds
  // back a step no statement states by it. Those are the other 25, each a
  // fourth step twice the third: in the infobox and the table alike, in a
  // set's tab, or, for the Staff of Protection, in the table alone.
  //
  // How well the rule's numbers are borne out differs, and each reason says
  // by what. The Armor page's rows state them for the Root, Padded, Vilebone
  // and Eitr-weave pieces, and the Fishing Hat's own text for the hat. For
  // the Lox Fur Set, the eight weapons and the Staff of Protection, no page
  // states the fourth step but doubled, except the Writhan Roots page's
  // table for the Lox fur hood's roots: those steps rest on the rule alone,
  // until someone checks them in the game.
  steps: {
    ...stepsOf(
      'The Troll Set\'s Helmet tab upgrades in Troll hide alone; the page\'s own quality tables ("2 (7) Troll hide / ' +
        '1 (4) Bone fragments") and the Armor page ("Bone fragments: 3/1/2/3") add the bones.',
      {
        'HelmetTrollLeather@2': [['TrollHide', 2], ['BoneFragments', 1]],
        'HelmetTrollLeather@3': [['TrollHide', 4], ['BoneFragments', 2]],
        'HelmetTrollLeather@4': [['TrollHide', 6], ['BoneFragments', 3]],
      },
    ),
    ...stepsOf(
      "The Padded Armor page's Chest and Legs tabs copy the helmet's costs; the page's own quality tables and the " +
        'Armor page agree on "Iron: 10/3/6/9, Linen thread: 20/10/20/30", but for the tables doubling the fourth step.',
      {
        'ArmorPaddedCuirass@1': [['Iron', 10], ['LinenThread', 20]],
        'ArmorPaddedCuirass@2': [['Iron', 3], ['LinenThread', 10]],
        'ArmorPaddedCuirass@3': [['Iron', 6], ['LinenThread', 20]],
        'ArmorPaddedCuirass@4': [['Iron', 9], ['LinenThread', 30]],
        'ArmorPaddedGreaves@1': [['Iron', 10], ['LinenThread', 20]],
        'ArmorPaddedGreaves@2': [['Iron', 3], ['LinenThread', 10]],
        'ArmorPaddedGreaves@3': [['Iron', 6], ['LinenThread', 20]],
        'ArmorPaddedGreaves@4': [['Iron', 9], ['LinenThread', 30]],
      },
    ),
    ...stepsOf(
      "The set's tab doubles the fourth step; the Armor page's row for the piece states three times the second, as the " +
        'game charges ("Root: 10/2/4/6, Ancient bark: 10/5/10/15" for the Root Set).',
      {
        'HelmetRoot@4': [['Root', 6], ['ElderBark', 15]],
        'ArmorRootChest@4': [['Root', 6], ['ElderBark', 15]],
        'ArmorRootLegs@4': [['Root', 6], ['ElderBark', 15]],
        'HelmetPadded@4': [['Iron', 15], ['LinenThread', 30]],
        'HelmetBerserkerUndead@4': [['BjornHide', 6]],
        'ArmorBerserkerUndeadChest@4': [['BjornHide', 6], ['UndeadBjornRibcage', 3], ['LinenThread', 3]],
        'ArmorBerserkerUndeadLegs@4': [['BjornHide', 15], ['UndeadBjornRibcage', 3], ['LinenThread', 3]],
        'HelmetMage@4': [['LinenThread', 24], ['Eitr', 15]],
        'ArmorMageChest@4': [['LinenThread', 30], ['Eitr', 15]],
        'ArmorMageLegs@4': [['LinenThread', 30], ['Eitr', 15]],
      },
    ),
    ...stepsOf(
      'The Lox Fur Set doubles the fourth step in its tabs and tables alike; the game charges three times the second, ' +
        "as the Writhan Roots page's table says of the hood's roots (2/1/2/3), and the Lox Cape's own infobox and the " +
        "Armor page of the set's cape, which the set doubles the same way. No page states the rest of these steps.",
      {
        'HelmetLox@4': [['LoxPelt', 6], ['BoneFragments', 6], ['WrithanRoots', 3]],
        'ArmorLoxChest@4': [['LoxPelt', 18], ['BoneFragments', 12], ['Root', 3]],
        'ArmorLoxLegs@4': [['LoxPelt', 9], ['BoneFragments', 12], ['Root', 3]],
      },
    ),
    ...stepsOf(
      'The page doubles the fourth step in its infobox and its Upgrade information table alike; the game charges three ' +
        'times the second, as the page\'s own second and third steps follow, and as 95 weapons\' pages state.',
      {
        'BattleaxeBlackmetal@4': [['LinenThread', 15], ['BlackMetal', 45]],
        'SwordBlackmetal@4': [['BlackMetal', 30], ['LinenThread', 15]],
        'BowDraugrFang@4': [['ElderBark', 15], ['Silver', 30], ['DeerHide', 6], ['Guck', 6]],
        'AxeEarly@4': [['Wood', 6], ['LeatherScraps', 6]],
        'BowFineWood@4': [['FineWood', 15], ['RoundLog', 15], ['DeerHide', 6]],
        'FistFenrirClaw@4': [['WolfHairBundle', 3], ['WolfClaw', 3], ['Silver', 3]],
        'MaceSilver@4': [['Silver', 45]],
        'BattleaxeSkullSplittur@4': [['YggdrasilWood', 15], ['Iron', 45]],
      },
    ),
    'HelmetFishingHat@4': {
      inputs: ['fish1', 'fish2', 'fish3', 'fish4_cave', 'fish5', 'fish6', 'fish7', 'fish8', 'fish9', 'fish10', 'fish11', 'fish12'].map(
        (fish): [ItemId, number] => [fish, 3],
      ),
      reason:
        'The Fishing Hat page: quality 4 "requires a total of seven of each kind of fish" (1 + 1 + 2 + 3); its infobox ' +
        'and table say 4 of each at quality 4, a total of eight.',
    },
    'ShieldWoodTower@1': {
      inputs: [['Wood', 10], ['LeatherScraps', 6]],
      reason:
        'Its infobox says 4 Leather scraps; its Upgrade information table says 6, and its text "Cost to max is 25 wood ' +
        'and 15 leather scraps", which only 6 adds up to.',
    },
    'THSwordSlayerNature@1': {
      inputs: [['THSwordSlayer', 1], ['FlametalNew', 15], ['GemstoneGreen', 1]],
      reason:
        'Its table of upgrades says 12 Flametal; its infobox says 15, as the Brutal and Scourging Slayers, made from a ' +
        'Slayer the same way, say in their infoboxes and tables alike.',
    },
    'HelmetPointyHat@1': {
      inputs: [['Coal', 5], ['Bronze', 1], ['DeerHide', 3]],
      reason: 'Its infobox says 2 Deer hide; its Upgrade information table says 3, and its total, 33 Deer hide, only adds up with 3.',
    },
    'StaffShield@4': {
      inputs: [['YggdrasilWood', 30], ['GiantBloodSack', 6], ['Eitr', 24]],
      reason:
        'Its infobox stops at quality 3; its Upgrade information table states a fourth, at twice the third step ' +
        '(40/8/32), where the game charges three times the second, as the Staffs of Embers and Frost state.',
    },
  },

  listStations: {
    'Wood Structures': {
      station: 'piece_workbench',
      reason: 'Wood Structures: "requiring wood and the proximity of a workbench to be built".',
    },
    'Thatch Roofs': { station: 'piece_workbench', reason: 'Thatch Roofs: "They require the proximity of a workbench".' },
    'Shingle Roofs': { station: 'piece_workbench', reason: 'Shingle Roofs: "They require the proximity of a workbench".' },
    'Log Structures': {
      station: 'piece_workbench',
      reason: 'Log Structures: "require Corewood and the proximity of a Workbench".',
    },
    'Darkwood Structures': {
      station: 'piece_workbench',
      reason: 'Darkwood Structures: "require Wood and Tar and the proximity of a Workbench".',
    },
    'Darkwood Structures#Darkwood gate': {
      station: 'forge',
      reason: 'Darkwood Structures: "The Darkwood gate ... requires proximity to a Forge".',
    },
    Adornments: { station: 'piece_workbench', reason: 'Adornments: "require Finewood and the proximity of a Workbench".' },
    'Ashwood Structures': {
      station: 'piece_workbench',
      reason: 'Ashwood Structures: "require Ashwood and the proximity of a workbench".',
    },
    'Stone Structures': {
      station: 'piece_stonecutter',
      reason: 'Stone Structures: "require stone and the proximity of a stonecutter".',
    },
    'Black Marble Structures': {
      station: 'piece_stonecutter',
      reason: 'Black Marble Structures: "require black marble and the proximity of a stonecutter".',
    },
    'Grausten Structures': {
      station: 'piece_stonecutter',
      reason: 'Grausten Structures: "require Grausten and the proximity of a stonecutter".',
    },
    'Grausten Roofs': { station: 'piece_stonecutter', reason: 'Grausten Roofs: "They require the proximity of a stonecutter".' },
    'Wood Iron Structures': {
      station: 'forge',
      reason: 'Wood Iron Structures: "require wood and iron and the proximity of a forge".',
    },
    'Cage Structures': { station: 'forge', reason: 'Cage Structures: "require Iron and the proximity of a Forge".' },
    'Dvergr Wood Structures': {
      station: 'blackforge',
      reason: 'Dvergr Wood Structures: "require Yggdrasil Wood and the proximity of a Black Forge".',
    },
    'Flametal Structures': {
      station: 'blackforge',
      reason: 'Flametal Structures: "require Flametal and the proximity of a Black forge".',
    },
    // The Storage page names no station; the three sizes' own page does.
    'Storage#Yuleklapp (small)': { station: 'piece_workbench', reason: 'The Yuleklapp page: Source "Workbench".' },
    'Storage#Yuleklapp (medium)': { station: 'piece_workbench', reason: 'The Yuleklapp page: Source "Workbench".' },
    'Storage#Yuleklapp (large)': { station: 'piece_workbench', reason: 'The Yuleklapp page: Source "Workbench".' },
  },

  // The Club, the Stone Axe and the Hammer, the things made by hand that
  // upgrade, each name the Workbench in their table of upgrades.
  upgradeStations: {},

  trophies: {
    page: 'Trophies',
    reason: "A trophy is dropped by the creature it is named after: the Deer trophy by the Deer.",
  },

  // Bought singly at the price in the trader's table. Things sold in bundles
  // (the Bog Witch's ingredients by five, her candle wicks by fifty, Haldor's
  // barrel hoops by three) are left out: a price for one would be a number
  // nobody can pay, and `buy` has no room yet for how many the price buys.
  obtain: {
    YmirRemains: {
      obtain: [{ how: 'buy', from: 'Haldor', coins: 120 }],
      reason: "Haldor's trading table: Ymir flesh, 120 coins.",
    },
    Thunderstone: {
      obtain: [{ how: 'buy', from: 'Haldor', coins: 50 }],
      reason: "Haldor's trading table: Thunder stone, 50 coins.",
    },
    ChickenEgg: {
      obtain: [
        { how: 'drop', from: ['Hen'] },
        { how: 'buy', from: 'Haldor', coins: 1500 },
      ],
      reason: "Egg's Source names Haldor and Hen; Haldor's trading table: Egg, 1,500 coins.",
    },
    Ironpit: {
      obtain: [{ how: 'buy', from: 'Hildir', coins: 75 }],
      reason: "Hildir's trading table: Iron pit, 75 coins.",
    },
    Barberkit: {
      obtain: [{ how: 'buy', from: 'Hildir', coins: 600 }],
      reason: "Hildir's trading table: Barber kit, 600 coins.",
    },
    ScytheHandle: {
      obtain: [{ how: 'buy', from: 'The Bog Witch', coins: 200 }],
      reason: "The Bog Witch's trading table: Scythe handle, 200 coins.",
    },
    MushroomBzerker: {
      obtain: [{ how: 'buy', from: 'The Bog Witch', coins: 85 }],
      reason: "The Bog Witch's trading table: Toadstool, 85 coins.",
    },
    Feathers: {
      obtain: [
        { how: 'drop', from: ['Birds'] },
        { how: 'loot', from: ['Chests'] },
        { how: 'chop', from: ['Felled trees'] },
      ],
      reason: 'Feathers\' Source, "Birds, Chests, Felled trees", links no page to tell how.',
    },
    Flint: {
      obtain: [{ how: 'gather', from: ['Shorelines of rivers and oceans'] }],
      reason: 'Flint\'s Source, "Shorelines of rivers and oceans", links no page to tell how.',
    },
    CopperScrap: {
      obtain: [{ how: 'loot', from: ['Dvergr structures', 'Ancient swords and armor'] }],
      reason: 'Copper scrap\'s Source, "Dropped by breaking some Dvergr structures; Ancient swords/armor", links no page.',
    },
    BlackCore: {
      obtain: [{ how: 'loot', from: ['Dungeons', 'Chests'] }],
      reason: 'Black core\'s Source, "Dungeons, random chests", links no page to tell how.',
    },
    // Source links only the creatures; the ways nearly every stone is had are plain text.
    Stone: {
      obtain: [
        { how: 'gather', from: ['Stones on the ground'] },
        { how: 'mine', from: ['Rocks', 'Copper deposits', 'Silver veins'] },
        { how: 'drop', from: ['Greydwarf', 'Greydwarf Brute', 'Stone Golem'] },
      ],
      reason:
        'Stone\'s Availability: "Scavenging stones scattered on the ground", "Mining larger chunks of stone, Copper deposits and Silver veins with a pickaxe", and the three creatures.',
    },
    Grausten: {
      obtain: [{ how: 'mine', from: ['Ashlands ruins', 'Rock formations in the Ashlands'] }],
      reason: 'Grausten\'s Availability: "Destroying Ashlands ruins or rock formations in Ashlands"; Source links only the biome.',
    },
  },

  spanishNames: [
    {
      reason:
        'Mead bases: "Base de hidromiel: <efecto>", the effect as each translated mead page names it, ' +
        'with "Estamina" for stamina as terms.ts pins it.',
      names: {
        MeadBaseTasty: 'Base de hidromiel: Sabrosa',
        MeadBaseHealthMinor: 'Base de hidromiel: Curación menor',
        MeadBaseHealthMedium: 'Base de hidromiel: Curación media',
        MeadBaseHealthMajor: 'Base de hidromiel: Curación mayor',
        MeadBaseHealthLingering: 'Base de hidromiel: Salud persistente',
        MeadBaseStaminaMinor: 'Base de hidromiel: Estamina menor',
        MeadBaseStaminaMedium: 'Base de hidromiel: Estamina media',
        MeadBaseStaminaLingering: 'Base de hidromiel: Estamina persistente',
        MeadBaseEitrMinor: 'Base de hidromiel: Eitr menor',
        MeadBaseEitrLingering: 'Base de hidromiel: Eitr persistente',
        MeadBaseFrostResist: 'Base de hidromiel: Resistencia al frío',
        MeadBasePoisonResist: 'Base de hidromiel: Resistencia al veneno',
        MeadBaseBzerker: 'Base de hidromiel: Berserkir',
        MeadBaseBugRepellent: 'Base de hidromiel: Anti-picaduras',
        MeadBaseLightFoot: 'Base de hidromiel: Pies ligeros',
        MeadBaseHasty: 'Base de hidromiel: Ratatosk',
        MeadBaseSwimmer: 'Base de hidromiel: Vananidir',
        MeadBaseStrength: 'Base de hidromiel: Resistencia troll',
        MeadBaseTamer: 'Base de hidromiel: Susurros animales',
        BarleyWineBase: 'Base de vino de cebada: Resistencia al fuego',
      },
    },
    {
      reason: 'Cooked meats, doughs and uncooked dishes, as the translated pages and recipes that use them already name them.',
      names: {
        CookedMeat: 'Carne de jabalí cocida',
        CookedDeerMeat: 'Carne de ciervo cocida',
        CookedWolfMeat: 'Carne de lobo cocida',
        CookedBjornMeat: 'Carne de oso cocida',
        CookedBugMeat: 'Carne de buscador cocida',
        CookedLoxMeat: 'Carne de lox cocida',
        CookedHareMeat: 'Carne de liebre cocida',
        CookedChickenMeat: 'Carne de pollo cocida',
        CookedVoltureMeat: 'Carne de Volture cocida',
        CookedBoneMawSerpentMeat: 'Carne de bonemaw cocida',
        CookedAsksvinMeat: 'Cola de asksvin cocida',
        SerpentMeatCooked: 'Carne de serpiente cocida',
        FishCooked: 'Pescado cocido',
        CookedEgg: 'Huevo cocido',
        NeckTailGrilled: 'Cola de neck asada',
        BreadDough: 'Masa de pan',
        VikingCupcakeUncooked: 'Pan dulce sin hornear',
        LoxPieUncooked: 'Pastel de lox sin hornear',
        MeatPlatterUncooked: 'Fuente de carnes cruda',
        MisthareSupremeUncooked: 'Liebre bruma suprema cruda',
        HoneyGlazedChickenUncooked: 'Pollo glaseado con miel crudo',
        MagicallyStuffedShroomUncooked: 'Hongo relleno crudo',
        PiquantPieUncooked: 'Pastel picante crudo',
        RoastedCrustPieUncooked: 'Torta de corteza asada cruda',
        FishAndBreadUncooked: 'Pescado con pan crudo',
      },
    },
    {
      reason:
        'Armor pieces: as the translated set pages name the ones they mention (Casco de bronce, Tocado del oso, ' +
        "Abrigo de Fenris), the rest after their set's or material's Spanish name (Cuero de trol, Caparazón).",
      names: {
        ArmorRagsChest: 'Túnica de trapo',
        ArmorRagsLegs: 'Pantalones de trapo',
        HelmetLeather: 'Casco de cuero',
        ArmorLeatherChest: 'Túnica de cuero',
        ArmorLeatherLegs: 'Pantalones de cuero',
        CapeDeerHide: 'Capa de piel de ciervo',
        HelmetBronze: 'Casco de bronce',
        ArmorBronzeChest: 'Coraza de placas de bronce',
        ArmorBronzeLegs: 'Grebas de placas de bronce',
        HelmetTrollLeather: 'Capucha de cuero de trol',
        ArmorTrollLeatherChest: 'Túnica de cuero de trol',
        ArmorTrollLeatherLegs: 'Pantalones de cuero de trol',
        HelmetIron: 'Casco de hierro',
        ArmorIronChest: 'Cota de malla de hierro',
        ArmorIronLegs: 'Grebas de hierro',
        HelmetRoot: 'Máscara de raíz',
        ArmorRootChest: 'Arnés de raíz',
        ArmorRootLegs: 'Polainas de raíz',
        HelmetDrake: 'Casco de drake',
        ArmorWolfChest: 'Pechera de piel de lobo',
        ArmorWolfLegs: 'Pantalones de piel de lobo',
        HelmetFenring: 'Capucha de Fenris',
        ArmorFenringChest: 'Abrigo de Fenris',
        ArmorFenringLegs: 'Pantalones de Fenris',
        HelmetPadded: 'Casco acolchado',
        ArmorPaddedCuirass: 'Coraza acolchada',
        ArmorPaddedGreaves: 'Grebas acolchadas',
        HelmetCarapace: 'Casco de caparazón',
        ArmorCarapaceChest: 'Peto de caparazón',
        ArmorCarapaceLegs: 'Grebas de caparazón',
        HelmetMage: 'Capucha de tejido de eitr',
        ArmorMageChest: 'Túnica de tejido de eitr',
        ArmorMageLegs: 'Pantalones de tejido de eitr',
        HelmetBerserkerHood: 'Tocado del oso',
        ArmorBerserkerChest: 'Patrones del oso',
        ArmorBerserkerLegs: 'Taparrabos del oso',
        HelmetBerserkerUndead: 'Rostro de hueso vil',
        ArmorBerserkerUndeadChest: 'Jaula de hueso vil',
        ArmorBerserkerUndeadLegs: 'Faldones de hueso vil',
        HelmetFlametal: 'Casco de flametal',
        ArmorFlametalChest: 'Peto de flametal',
        ArmorFlametalLegs: 'Grebas de flametal',
        HelmetAshlandsMediumHood: 'Capucha de Ask',
        ArmorAshlandsMediumChest: 'Peto de Ask',
        ArmorAshlandsMediumlegs: 'Pantalones de Ask',
        // As the wiki titles them: its Chest tab's infobox says "Trousers of
        // Embla" and its Legs tab's "Robes of Embla". The names follow the
        // English the graph shows beside them.
        HelmetMage_Ashlands: 'Capucha de Embla',
        ArmorMageChest_Ashlands: 'Pantalones de Embla',
        ArmorMageLegs_Ashlands: 'Túnica de Embla',
      },
    },
    {
      reason:
        'Trophies: "Trofeo de <criatura>", the creature as the site names it in Spanish (its translated page or ' +
        'article-names.ts), as the translated recipes do.',
      names: {
        'page:trophies#deer-trophy': 'Trofeo de ciervo',
        'page:trophies#skeleton-trophy': 'Trofeo de esqueleto',
        'page:trophies#troll-trophy': 'Trofeo de trol',
        'page:trophies#bear-trophy': 'Trofeo de oso',
        'page:trophies#wolf-trophy': 'Trofeo de lobo',
        'page:trophies#drake-trophy': 'Trofeo de drake',
        'page:trophies#cultist-trophy': 'Trofeo de cultista',
        'page:trophies#fenring-trophy': 'Trofeo de Fenring',
        'page:trophies#stone-golem-trophy': 'Trofeo de gólem de piedra',
        'page:trophies#greydwarf-shaman-trophy': 'Trofeo de chamán greydwarf',
        'page:trophies#leech-trophy': 'Trofeo de sanguijuela',
        'page:trophies#surtling-trophy': 'Trofeo de Surtling',
        'page:trophies#draugr-elite-trophy': 'Trofeo de draugr élite',
        'page:trophies#serpent-trophy': 'Trofeo de serpiente',
        'page:trophies#lox-trophy': 'Trofeo de lox',
        'page:trophies#fuling-berserker-trophy': 'Trofeo de fuling berserker',
        'page:trophies#vile-trophy': 'Trofeo de Vile',
        'page:trophies#seeker-trophy': 'Trofeo de buscador',
        'page:trophies#gjall-trophy': 'Trofeo de Gjall',
        'page:trophies#asksvin-trophy': 'Trofeo de Asksvin',
        'page:trophies#morgen-trophy': 'Trofeo de Morgen',
        'page:trophies#fallen-valkyrie-trophy': 'Trofeo de valquiria caída',
      },
    },
    {
      reason:
        "Other things described inside another page, named after that page's Spanish title (Hachas iniciales, Mesa de artesano, Vasijas).",
      names: {
        AxeHead1: 'Cabeza de hacha curiosa',
        AxeHead2: 'Cabeza de hacha misteriosa',
        'page:artisan-table#artisan-press': 'Prensa de artesano',
        'page:item-stand#horizontal': 'Soporte de objetos (horizontal)',
        Stonerock: 'Roca misteriosa',
        'page:dyrnwyn#dyrnwyn-hilt-fragment': 'Fragmento de empuñadura de Dyrnwyn',
        'page:dyrnwyn#dyrnwyn-blade-fragment': 'Fragmento de hoja de Dyrnwyn',
        'page:dyrnwyn#dyrnwyn-tip-fragment': 'Fragmento de punta de Dyrnwyn',
        piece_gift1: 'Yuleklapp (pequeño)',
        piece_gift2: 'Yuleklapp (mediano)',
        piece_gift3: 'Yuleklapp (grande)',
        piece_pot3: 'Vasija verde pequeña',
        piece_pot1: 'Vasija verde mediana',
        piece_pot2: 'Vasija verde grande',
      },
    },
  ],
};
