import { describe, expect, it } from 'vitest';
import { hasTermLabel, termLabel, termNames, vocabulary } from '@/lib/i18n/terms';

/**
 * The vocabulary as it actually occurs in the corpus (1,027 articles, read
 * when this was written). A value missing a Spanish name shows up in English
 * on a Spanish tile, so every one of them is checked, not a sample.
 */
const CATEGORIES = [
  'Materials', 'Weapons', 'Food', 'Armor', 'Creatures', 'Points of interest', 'Black forge recipes', 'Forge recipes',
  'Workbench recipes', 'Crafting structures', 'Misc structures', 'Furniture', 'Light sources', 'Effects', 'Head',
  'Building structures', 'Gameplay', 'Skills', 'Mechanics', 'Cooking recipes', 'Body', "Can't be Teleported", 'Mead',
  'Tools', 'Fermenter recipes', 'Crafting station upgrades', 'Farming', 'Shields', 'Resource nodes', 'Swords', 'Axes',
  'Legs', 'Storage', 'Clubs', 'Crafting', 'Fishing', 'Building', 'Capes', 'Seeds', 'Trinket', 'Arrows', 'Lore', 'NPCs',
  'Stacks & Piles', 'Fish', 'Biomes', 'Magic', 'Spears', 'Bows', 'Dungeons', 'Guides', 'Ore deposits', 'Ores',
  'Passive creatures', 'Trees', 'Unfinished', 'Bosses', 'Feast', 'Items', 'Galdr table recipes', 'Misc Items',
  'Tameable creatures', 'Wood', 'Work in progress', 'Creature spawner', 'Fires', 'Grants Comfort', 'Knives', 'Metals',
  'Seasonal Furniture', 'Boats', 'Bolts', 'Bombs', 'Crossbows', 'Elemental magic', 'Forsaken offerings', 'Objects',
  'Artisan table recipes', 'Minions', 'Pickaxes', 'Polearms', 'Transport', 'Unarmed', 'User interface', 'Valuables',
  'Accessories', 'Blood magic', 'Creatures with weak points', 'Disambiguations', 'Minibosses', 'Missiles', 'Beds',
  'Candidates for deletion', 'Development', 'Gems', 'Pages with broken file links', 'Removed', 'Roofs', 'Valheim Wiki',
  'Aggressive creatures', 'Fireworks', 'Locations', 'Weather', 'Bait', 'Chairs', 'Outdated', 'Spawn Points', 'Stubs',
  'Trophies',
];
/** Names that are the same in Spanish. */
const SAME_IN_SPANISH = ['Valheim', 'DLC', 'Hildir'];

const BIOMES = [
  'Ashlands', 'Black Forest', 'Mistlands', 'Swamp', 'Meadows', 'Mountain', 'Plains', 'Ocean', 'Howling Caverns',
  'Meadows and Plains', 'Rivers', 'Sealed tower', 'Smouldering Tombs',
];
const STATIONS = [
  'Workbench', 'Forge', 'Black forge', 'Cauldron', 'Fermenter', 'Galdr table', 'Stone oven', 'Artisan table',
  'Food preparation table', 'Stonecutter', 'Player crafting menu', 'Smelter', 'Blast furnace', 'Console', 'Crafting',
  'Eitr refinery', 'Hammer', 'Smelting', 'Spinning wheel', 'Windmill', 'n/a',
];
const TYPES = [
  'Material', 'Food', 'Crafting', 'Misc', 'Furniture', 'Head', 'Body', 'Structure', 'Mead', 'Point of interest',
  'Shield', 'Sword', 'Axe', 'Club', 'Trinkets', 'Arrow', 'Fish', 'Tool', 'Dungeon', 'Passive', 'Seed', 'Spear', 'Boss',
  'Bow', 'Cape', 'Ore', 'Ore deposits', 'Building', 'Feast', 'Knife', 'Metal', 'Resource nodes', 'Object', 'Crossbow',
  'Elemental magic', 'Valuable', 'Wood', 'Bolt', 'Bomb', 'Fists', 'Pickaxe', 'Polearm', 'Accessory', 'Blood magic',
  'Miniboss', 'Missile', 'Catapult Ammo', 'Minion', 'Bolts', 'Boss arena', 'Chest', 'Ocean', 'One-handed', 'Plant',
  'World',
];
/** Infobox labels seen at least four times: every one can head a compare column. */
const LABELS = [
  'Internal ID', 'Type', 'Weight', 'Crafting Materials', 'Source', 'Stagger', 'Adrenaline', 'Knockback', 'Backstab',
  'Durability', 'Stamina', 'Attack speed', 'Usage', 'Description', 'Hitbox', 'Crafting Level', 'Wielding',
  'Block Adrenaline', 'Block armor', 'Repair Level', 'Parry bonus', 'Parry Adrenaline', 'Parry block armor',
  'Block force', 'Slash', 'Stack', 'Teleportable (Can go through wood portal?)', 'Pierce', 'Immune to (x0)',
  'Neutral to (x1)', 'Drops', 'Main biome', 'Faction', 'Abilities', 'Chain last hit', 'Resistant to (x0.5)',
  'Damaged by Rain?', 'Weak to (x1.5)', 'Chop', 'Size', 'Movement speed', 'Blunt', 'Duration', 'Provides Light?',
  'Tameable', 'Location', 'Poison', 'Buy', 'Max Health', 'Trophy', 'Spirit', 'Max Stamina', 'Healing', 'Lightning',
  'Stagger limit', 'Inhabitants', 'Support', 'Loss', 'Resources', 'Base Item Stamina Usage', 'Effects', 'Eitr',
  'Other Effect(s)', 'Recoil force', 'Fire', 'Pickaxe', 'Frost', 'Cooldown', 'Neutral to', 'Immune to',
  'Grow Time (s)', 'Comfort Group', 'Needs Cultivated Ground?', 'Space Needed (m)', 'Produces', 'Comfort Level',
  'Hospitable Biomes', 'Effect', 'Gender', 'Tool Tier', 'Species', 'Affiliation', 'Adrenaline Cost', 'Set Pieces',
  'Eye color', 'Very resistant to (x0.25)', 'Storage Height', 'Build Height', 'Storage Slots', 'Max Eitr',
  'Storage Width', 'Health', 'Season', 'Set Effect', 'Very weak to (x2)', 'Passive', 'Misc', 'Uses', 'Hostile', 'Skill',
  'Biome', 'Yield', 'Tool Needed', 'Wood Type', 'Max Level', 'Structures', 'Boss(es)', 'Damage Modifier',
  'Additional Loot', 'Improvements', 'Unique', 'Dungeons', 'Pure', 'Food', 'Sell', 'Health Regen', 'Stamina Regen',
  'Regular', 'Date of death', 'NPCs',
];

describe('termLabel', () => {
  it.each([
    ['category', CATEGORIES],
    ['biome', BIOMES],
    ['station', STATIONS],
    ['type', TYPES],
    ['facet', LABELS],
  ] as const)('names every %s value in the corpus in Spanish', (kind, values) => {
    const missing = values.filter((v) => !SAME_IN_SPANISH.includes(v) && !hasTermLabel(kind, v));
    expect(missing).toEqual([]);
  });

  it('uses the names the stored translations already use, so a tile agrees with the article it opens', () => {
    expect(termLabel('station', 'Forge', 'es')).toBe('Forja');
    expect(termLabel('station', 'Workbench', 'es')).toBe('Banco de trabajo');
    expect(termLabel('biome', 'Black Forest', 'es')).toBe('Bosque negro');
    expect(termLabel('biome', 'Ashlands', 'es')).toBe('Tierras cenicientas');
    expect(termLabel('biome', 'Mistlands', 'es')).toBe('Tierras brumosas');
    expect(termLabel('category', 'Weapons', 'es')).toBe('Armas');
    expect(termLabel('type', 'Sword', 'es')).toBe('Espada');
  });

  it('names polearms as polearms, not as antlers, and keeps the shorter name for search', () => {
    expect(termLabel('category', 'Polearms', 'es')).toBe('Armas de asta');
    expect(termLabel('type', 'Polearm', 'es')).toBe('Arma de asta');
    expect(termNames('category', 'Polearms')).toContain('Astas');
    expect(termNames('type', 'Polearm')).toContain('Asta');
  });

  it('lets body armour answer to "pecho", the slot the game calls the chest', () => {
    expect(termLabel('category', 'Body', 'es')).toBe('Cuerpo');
    expect(termNames('category', 'Body')).toContain('Pecho');
    expect(termNames('type', 'Body')).toContain('Pecho');
  });

  it('pins the stamina family to one word, which the translations do not', () => {
    expect(termLabel('facet', 'Stamina', 'es')).toBe('Estamina');
    expect(termLabel('facet', 'Max Stamina', 'es')).toBe('Estamina máxima');
    expect(termLabel('facet', 'Stamina Regen', 'es')).toBe('Regeneración de estamina');
  });

  it('is English in English', () => {
    expect(termLabel('category', 'Weapons', 'en')).toBe('Weapons');
    expect(termLabel('station', 'Cauldron (level 3)', 'en')).toBe('Cauldron (level 3)');
  });

  it('ignores case and spacing, which the wiki is not consistent about', () => {
    expect(termLabel('station', 'Black forge', 'es')).toBe('Forja negra');
    expect(termLabel('station', 'Black  Forge', 'es')).toBe('Forja negra');
    expect(termLabel('station', 'galdr table', 'es')).toBe('Mesa de Galdr');
  });

  it('translates a station level around the bench', () => {
    expect(termLabel('station', 'Cauldron (level 3)', 'es')).toBe('Caldero (nivel 3)');
    expect(termLabel('station', 'Artisan table level 2', 'es')).toBe('Mesa de artesano (nivel 2)');
  });

  it('falls back to the English value, unchanged, for anything it does not know', () => {
    expect(termLabel('category', 'A category added next week', 'es')).toBe('A category added next week');
    expect(termLabel('station', 'Mystery bench (level 2)', 'es')).toBe('Mystery bench (level 2)');
    expect(termLabel('biome', '', 'es')).toBe('');
    expect(hasTermLabel('category', 'A category added next week')).toBe(false);
  });
});

describe('termNames', () => {
  it('lists the label first, then the other names readers use', () => {
    expect(termNames('biome', 'Black Forest')).toEqual(['Bosque negro', 'Selva negra']);
    expect(termNames('station', 'Forge')[0]).toBe('Forja');
    expect(termNames('station', 'Forge')).toContain('Fragua');
  });

  it('is empty for an unknown value', () => {
    expect(termNames('type', 'Nonsense')).toEqual([]);
  });
});

describe('vocabulary', () => {
  it('covers every kind, with a Spanish name for each entry', () => {
    const entries = vocabulary();
    expect(new Set(entries.map((e) => e.kind))).toEqual(new Set(['biome', 'category', 'station', 'type', 'facet']));
    expect(entries.every((e) => e.spanish.length > 0 && e.spanish.every((s) => s.trim().length > 0))).toBe(true);
  });
});
