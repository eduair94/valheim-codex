import type { Lang } from './strings';
import { splitStationLevel } from '@/lib/wiki/browse-groups';

/**
 * Spanish names for the wiki's fixed vocabulary, for display.
 *
 * Biomes, categories, crafting stations, item types and infobox field names
 * are English values in the database — they come from the English wiki, and
 * URLs and filters match on them exactly. A Spanish page showed them as they
 * are: tiles read "Meadows", "Weapons", "Workbench" under Spanish headings,
 * and the search meta line read "Sword · Weapons · Swords".
 *
 * Deriving the labels from translated articles of the same name covers about
 * a fifth of them — none of the top five categories, two of eight biomes — so
 * the names are written down here. Where the stored translations already use
 * a name, the name here is theirs, by majority (the infobox rows of the 784
 * aligned translations were paired with their English rows and counted):
 * "Forja" for Forge, "Bosque negro" for Black Forest, "Tierras cenicientas"
 * for Ashlands. A tile that disagreed with the article body it leads to would
 * be worse than either name alone.
 *
 * Each entry is the label, then any other names readers use for the same
 * thing ("Selva negra", "Fragua"). The extra names are for search, never for
 * display.
 *
 * Values not listed come back in English, unchanged: a new category on the
 * wiki shows up in English until it gets a line here, rather than vanishing.
 */

export type TermKind = 'biome' | 'category' | 'station' | 'type' | 'facet';

type Names = string | readonly [label: string, ...aliases: string[]];

const BIOMES: Record<string, Names> = {
  Meadows: ['Praderas', 'Pradera'],
  'Black Forest': ['Bosque negro', 'Selva negra'],
  Swamp: ['Pantano', 'Ciénaga'],
  Mountain: ['Montaña', 'Montañas'],
  Mountains: ['Montañas', 'Montaña'],
  Plains: ['Llanuras', 'Llanura'],
  Mistlands: ['Tierras brumosas', 'Tierras de la niebla', 'Tierra de la niebla'],
  Ashlands: ['Tierras cenicientas', 'Tierras de ceniza', 'Tierra de cenizas'],
  'Deep North': ['Norte profundo', 'Gran norte'],
  Ocean: ['Océano', 'Mar'],
  'Howling Caverns': 'Cavernas aullantes',
  'Meadows and Plains': 'Praderas y Llanuras',
  Rivers: 'Ríos',
  'Sealed tower': 'Torre sellada',
  'Smouldering Tombs': 'Tumbas humeantes',
};

const STATIONS: Record<string, Names> = {
  Workbench: ['Banco de trabajo', 'Mesa de trabajo'],
  Forge: ['Forja', 'Fragua'],
  'Black forge': ['Forja negra', 'Fragua negra'],
  Cauldron: 'Caldero',
  Fermenter: 'Fermentador',
  'Galdr table': ['Mesa de Galdr', 'Mesa galdr'],
  'Stone oven': 'Horno de piedra',
  'Artisan table': 'Mesa de artesano',
  'Food preparation table': ['Mesa de preparación de alimentos', 'Mesa de preparación de comida'],
  Stonecutter: 'Cortapiedras',
  'Player crafting menu': 'Menú de fabricación',
  Smelter: ['Fundidora', 'Fundición'],
  'Blast furnace': 'Alto horno',
  'Eitr refinery': 'Refinería de eitr',
  'Spinning wheel': 'Rueca',
  Windmill: 'Molino de viento',
  Hammer: 'Martillo',
  Console: 'Consola',
  Crafting: 'Fabricación',
  Smelting: 'Fundición',
  'n/a': 'n/d',
};

const CATEGORIES: Record<string, Names> = {
  Materials: 'Materiales',
  Weapons: 'Armas',
  Food: ['Comida', 'Alimentos'],
  Armor: ['Armaduras', 'Armadura'],
  Creatures: 'Criaturas',
  'Points of interest': ['Puntos de interés', 'Lugares de interés'],
  'Black forge recipes': 'Recetas de la forja negra',
  'Forge recipes': 'Recetas de la forja',
  'Workbench recipes': 'Recetas del banco de trabajo',
  // "Fabricación" is the stored translations' word for crafting, but at the
  // width of a phone tile "Estructuras de fabricación" needs three lines.
  'Crafting structures': ['Estructuras de crafteo', 'Estructuras de fabricación'],
  'Misc structures': 'Estructuras varias',
  Furniture: ['Mobiliario', 'Muebles'],
  'Light sources': ['Fuentes de luz', 'Iluminación'],
  Effects: 'Efectos',
  Head: ['Cabeza', 'Cascos'],
  'Building structures': 'Estructuras de construcción',
  Gameplay: 'Jugabilidad',
  Skills: 'Habilidades',
  Mechanics: 'Mecánicas',
  'Cooking recipes': 'Recetas de cocina',
  // The armour slot the game calls the chest: "pecho (túnicas y petos)".
  Body: ['Cuerpo', 'Pecheras', 'Pecho'],
  "Can't be Teleported": ['No teletransportables', 'No se teletransporta'],
  Mead: ['Hidromiel', 'Aguamiel'],
  Tools: 'Herramientas',
  'Fermenter recipes': 'Recetas del fermentador',
  'Crafting station upgrades': 'Mejoras de estaciones',
  Farming: ['Cultivo', 'Agricultura'],
  Shields: 'Escudos',
  'Resource nodes': 'Nodos de recursos',
  Swords: 'Espadas',
  Axes: 'Hachas',
  Legs: ['Piernas', 'Pantalones'],
  Storage: 'Almacenamiento',
  Clubs: ['Mazas', 'Garrotes'],
  Crafting: ['Fabricación', 'Crafteo'],
  Fishing: 'Pesca',
  Building: 'Construcción',
  Capes: 'Capas',
  Seeds: 'Semillas',
  Trinket: ['Dijes', 'Abalorios', 'Amuletos'],
  Arrows: 'Flechas',
  Lore: ['Trasfondo', 'Historia'],
  NPCs: ['PNJ', 'NPC', 'Personajes'],
  'Stacks & Piles': 'Pilas y montones',
  Fish: 'Peces',
  Biomes: 'Biomas',
  Magic: 'Magia',
  Spears: 'Lanzas',
  Bows: 'Arcos',
  Dungeons: 'Mazmorras',
  Guides: 'Guías',
  'Ore deposits': ['Depósitos de mineral', 'Vetas'],
  Ores: 'Minerales',
  'Passive creatures': 'Criaturas pasivas',
  Trees: 'Árboles',
  Unfinished: 'Sin terminar',
  Bosses: 'Jefes',
  Feast: ['Festines', 'Banquetes'],
  Items: 'Objetos',
  'Galdr table recipes': 'Recetas de la mesa de Galdr',
  'Misc Items': 'Objetos varios',
  'Tameable creatures': 'Criaturas domesticables',
  Wood: 'Madera',
  'Work in progress': 'En desarrollo',
  'Creature spawner': 'Generadores de criaturas',
  Fires: ['Fuegos', 'Fogatas'],
  'Grants Comfort': ['Dan comodidad', 'Comodidad'],
  Knives: 'Cuchillos',
  Metals: 'Metales',
  'Seasonal Furniture': 'Mobiliario de temporada',
  Boats: ['Barcos', 'Embarcaciones'],
  Bolts: 'Virotes',
  Bombs: 'Bombas',
  Crossbows: 'Ballestas',
  'Elemental magic': 'Magia elemental',
  'Forsaken offerings': ['Ofrendas a los Abandonados', 'Ofrendas'],
  Objects: 'Objetos del mundo',
  'Artisan table recipes': 'Recetas de la mesa de artesano',
  Minions: 'Esbirros',
  Pickaxes: 'Picos',
  // "Astas" alone reads as antlers — the stored translations' own "Pico de
  // asta" is the Antler Pickaxe — while their atgeir pages say "arma de asta".
  Polearms: ['Armas de asta', 'Astas'],
  Transport: 'Transporte',
  Unarmed: ['Sin armas', 'Desarmado'],
  'User interface': 'Interfaz',
  Valuables: 'Objetos de valor',
  Accessories: 'Accesorios',
  'Blood magic': 'Magia de sangre',
  'Creatures with weak points': 'Criaturas con puntos débiles',
  Disambiguations: 'Desambiguaciones',
  Minibosses: 'Minijefes',
  Missiles: ['Misiles', 'Proyectiles'],
  Beds: 'Camas',
  'Candidates for deletion': 'Candidatos a borrar',
  Development: 'Desarrollo',
  Gems: 'Gemas',
  'Pages with broken file links': 'Páginas con archivos rotos',
  Removed: 'Eliminado del juego',
  Roofs: 'Techos',
  'Valheim Wiki': 'Wiki de Valheim',
  'Aggressive creatures': 'Criaturas agresivas',
  Fireworks: 'Fuegos artificiales',
  Locations: 'Ubicaciones',
  Weather: 'Clima',
  Bait: 'Carnada',
  Chairs: 'Sillas',
  Outdated: 'Desactualizado',
  'Spawn Points': 'Puntos de aparición',
  Stubs: 'Esbozos',
  Trophies: 'Trofeos',
};

const TYPES: Record<string, Names> = {
  Material: 'Material',
  Food: ['Comida', 'Alimento'],
  Crafting: 'Fabricación',
  Misc: 'Varios',
  Furniture: ['Mobiliario', 'Mueble'],
  Head: 'Cabeza',
  Body: ['Cuerpo', 'Pecho'],
  Structure: 'Estructura',
  Mead: ['Hidromiel', 'Aguamiel'],
  'Point of interest': 'Punto de interés',
  Shield: 'Escudo',
  Sword: 'Espada',
  Axe: 'Hacha',
  Club: ['Maza', 'Garrote'],
  Trinkets: ['Dijes', 'Abalorios'],
  Arrow: 'Flecha',
  Fish: 'Pez',
  Tool: 'Herramienta',
  Dungeon: 'Mazmorra',
  Passive: 'Pasivo',
  Seed: 'Semilla',
  Spear: 'Lanza',
  Boss: 'Jefe',
  Bow: 'Arco',
  Cape: 'Capa',
  Ore: ['Mineral', 'Mena'],
  'Ore deposits': 'Depósitos de mineral',
  Building: 'Construcción',
  Feast: ['Festín', 'Banquete'],
  Knife: 'Cuchillo',
  Metal: 'Metal',
  'Resource nodes': 'Nodos de recursos',
  Object: 'Objeto',
  Crossbow: 'Ballesta',
  'Elemental magic': 'Magia elemental',
  Valuable: ['Valioso', 'Objeto de valor'],
  Wood: 'Madera',
  Bolt: 'Virote',
  Bolts: 'Virotes',
  Bomb: 'Bomba',
  Fists: 'Puños',
  Pickaxe: 'Pico',
  Polearm: ['Arma de asta', 'Asta'],
  Accessory: 'Accesorio',
  'Blood magic': 'Magia de sangre',
  Miniboss: 'Minijefe',
  Missile: 'Proyectil',
  'Catapult Ammo': 'Munición de catapulta',
  Minion: 'Esbirro',
  'Boss arena': 'Arena de jefe',
  // The armour slot, not the container: the one article of this type is Rag Armor.
  Chest: 'Pecho',
  Ocean: 'Océano',
  'One-handed': 'Una mano',
  Plant: 'Planta',
  World: 'Mundo',
};

/**
 * Infobox field names: the label of a stat row ("Weight", "Durability"),
 * which is what a compare column is headed with and what the facets are
 * lifted from. Plus the three facet keys themselves.
 *
 * Pinned by hand where the translations disagree with themselves: "Stamina"
 * is rendered "Resistencia" in 312 rows and "Estamina" in 224, but
 * "Resistencia" reads as damage resistance next to the "Resistente a (x0.5)"
 * rows, so the whole stamina family is "Estamina", as "Estamina máxima"
 * already is in most translations.
 */
const FACETS: Record<string, Names> = {
  biome: 'Bioma',
  station: 'Estación',
  type: 'Tipo',
  'Internal ID': 'ID interno',
  Weight: 'Peso',
  Type: 'Tipo',
  'Crafting Materials': 'Materiales de fabricación',
  Source: 'Origen',
  Stagger: 'Aturdimiento',
  Adrenaline: 'Adrenalina',
  Knockback: 'Empuje',
  Backstab: 'Puñalada trasera',
  Durability: 'Durabilidad',
  Stamina: ['Estamina', 'Resistencia', 'Aguante', 'Vigor'],
  'Attack speed': 'Velocidad de ataque',
  Usage: 'Uso',
  Description: 'Descripción',
  Hitbox: 'Zona de impacto',
  'Crafting Level': 'Nivel de fabricación',
  Wielding: 'Empuñadura',
  'Block Adrenaline': 'Adrenalina de bloqueo',
  'Block armor': 'Armadura de bloqueo',
  'Repair Level': 'Nivel de reparación',
  'Parry bonus': 'Bonificación de parada',
  'Parry Adrenaline': 'Adrenalina de parada',
  'Parry block armor': 'Armadura de bloqueo de parada',
  'Block force': 'Fuerza de bloqueo',
  Slash: 'Cortante',
  Stack: 'Pila',
  'Teleportable (Can go through wood portal?)': 'Teletransportable',
  Pierce: 'Perforante',
  'Immune to (x0)': 'Inmune a (x0)',
  'Neutral to (x1)': 'Neutral a (x1)',
  Drops: 'Botín',
  'Main biome': 'Bioma principal',
  Faction: 'Facción',
  Abilities: 'Habilidades',
  'Chain last hit': 'Último golpe de la cadena',
  'Resistant to (x0.5)': 'Resistente a (x0.5)',
  'Damaged by Rain?': '¿La daña la lluvia?',
  'Weak to (x1.5)': 'Débil a (x1.5)',
  Chop: 'Tala',
  Size: 'Tamaño',
  'Movement speed': 'Velocidad de movimiento',
  'Movement Speed': 'Velocidad de movimiento',
  Blunt: 'Contundente',
  Duration: 'Duración',
  'Provides Light?': '¿Proporciona luz?',
  Tameable: 'Domesticable',
  Location: 'Ubicación',
  Poison: 'Veneno',
  Buy: 'Comprar',
  'Max Health': 'Salud máxima',
  Trophy: 'Trofeo',
  Spirit: 'Espíritu',
  'Max Stamina': 'Estamina máxima',
  Healing: 'Curación',
  Lightning: 'Rayo',
  'Stagger limit': 'Límite de aturdimiento',
  Inhabitants: 'Habitantes',
  Support: 'Soporte',
  Loss: 'Pérdida',
  Resources: 'Recursos',
  'Base Item Stamina Usage': 'Uso de estamina base del objeto',
  Effects: 'Efectos',
  Eitr: 'Eitr',
  'Other Effect(s)': 'Otro(s) efecto(s)',
  'Recoil force': 'Fuerza de retroceso',
  Fire: 'Fuego',
  Pickaxe: 'Pico',
  Frost: 'Escarcha',
  Cooldown: 'Tiempo de reutilización',
  'Neutral to': 'Neutral a',
  'Immune to': 'Inmune a',
  'Grow Time (s)': 'Tiempo de crecimiento (s)',
  'Comfort Group': 'Grupo de comodidad',
  'Needs Cultivated Ground?': '¿Necesita tierra cultivada?',
  'Space Needed (m)': 'Espacio necesario (m)',
  Produces: 'Produce',
  'Comfort Level': 'Nivel de comodidad',
  'Hospitable Biomes': 'Biomas habitables',
  Effect: 'Efecto',
  Gender: 'Género',
  'Tool Tier': 'Nivel de herramienta',
  Species: 'Especie',
  Affiliation: 'Afiliación',
  'Adrenaline Cost': 'Costo de adrenalina',
  'Set Pieces': 'Piezas del conjunto',
  'Eye color': 'Color de ojos',
  'Very resistant to (x0.25)': 'Muy resistente a (x0.25)',
  'Storage Height': 'Alto de almacenamiento',
  'Build Height': 'Altura de construcción',
  'Storage Slots': 'Espacios de almacenamiento',
  'Max Eitr': 'Eitr máximo',
  'Storage Width': 'Ancho de almacenamiento',
  Health: 'Salud',
  Season: 'Temporada',
  'Set Effect': 'Efecto de conjunto',
  'Very weak to (x2)': 'Muy débil a (x2)',
  Passive: 'Pasivo',
  Misc: 'Varios',
  Uses: 'Usos',
  Hostile: 'Hostiles',
  Skill: 'Habilidad',
  Biome: 'Bioma',
  Biomes: 'Biomas',
  Yield: 'Rendimiento',
  'Tool Needed': 'Herramienta necesaria',
  'Wood Type': 'Tipo de madera',
  'Max Level': 'Nivel máximo',
  Structures: 'Estructuras',
  'Boss(es)': 'Jefe(s)',
  'Damage Modifier': 'Modificador de daño',
  'Additional Loot': 'Botín adicional',
  Improvements: 'Mejoras',
  Unique: 'Únicos',
  Dungeons: 'Mazmorras',
  Pure: 'Puro',
  Food: 'Comida',
  Sell: 'Venta',
  'Health Regen': 'Regeneración de salud',
  'Stamina Regen': 'Regeneración de estamina',
  'Eitr Regen': 'Regeneración de eitr',
  'Eitr regen': 'Regeneración de eitr',
  Regular: 'Comunes',
  'Date of death': 'Fecha de muerte',
  NPCs: 'PNJ',
  'Place of birth': 'Lugar de nacimiento',
  'Place of death': 'Lugar de muerte',
  'Weak to': 'Débil a',
  'Resistant to': 'Resistente a',
  Relatives: 'Parientes',
  Resistances: 'Resistencias',
  Special: 'Especial',
  Aliases: 'Alias',
  'Number per world': 'Cantidad por mundo',
  'Crafting station': 'Estación de fabricación',
  Station: 'Estación',
  Damage: 'Daño',
};

const TABLES: Record<TermKind, Record<string, Names>> = {
  biome: BIOMES,
  category: CATEGORIES,
  station: STATIONS,
  type: TYPES,
  facet: FACETS,
};

/** Case and spacing never decide whether two values are the same term. */
function key(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Lookups by folded key, built once. The wiki is not consistent about case —
 * the station facet says "Black forge" where the article is "Black Forge" —
 * and neither spelling should fall back to English.
 */
const LOOKUP: Record<TermKind, Map<string, readonly string[]>> = {
  biome: index(BIOMES),
  category: index(CATEGORIES),
  station: index(STATIONS),
  type: index(TYPES),
  facet: index(FACETS),
};

function index(table: Record<string, Names>): Map<string, readonly string[]> {
  return new Map(
    Object.entries(table).map(([english, names]) => [key(english), typeof names === 'string' ? [names] : names]),
  );
}

function names(kind: TermKind, value: string): readonly string[] | undefined {
  return LOOKUP[kind].get(key(value));
}

/**
 * The name to show for a fixed-vocabulary value.
 *
 * English is the source language, so `lang: 'en'` returns the value as it is.
 * A station's level suffix is translated around the bench's name:
 * "Cauldron (level 3)" is "Caldero (nivel 3)".
 */
export function termLabel(kind: TermKind, value: string, lang: Lang): string {
  if (lang === 'en' || !value) return value;

  const found = names(kind, value)?.[0];
  if (found) return found;

  if (kind === 'station') {
    const { base, level } = splitStationLevel(value);
    const bench = level !== null ? names('station', base)?.[0] : undefined;
    if (bench) return `${bench} (nivel ${level})`;
  }
  return value;
}

/**
 * Every Spanish name for a value, label first: what search should accept.
 * Empty when the value has no Spanish name.
 */
export function termNames(kind: TermKind, value: string): readonly string[] {
  return names(kind, value) ?? [];
}

/**
 * Whether a value has a Spanish name of its own. Lets a caller mark the
 * English fallbacks it renders inside a Spanish page as English (`lang="en"`).
 */
export function hasTermLabel(kind: TermKind, value: string): boolean {
  return termLabel(kind, value, 'es') !== value || names(kind, value) !== undefined;
}

/**
 * The whole vocabulary as English → Spanish names, for the glossary (which
 * reads it backwards to translate queries) and for the title index.
 */
export function vocabulary(): { kind: TermKind; english: string; spanish: readonly string[] }[] {
  const out: { kind: TermKind; english: string; spanish: readonly string[] }[] = [];
  for (const [kind, table] of Object.entries(TABLES) as [TermKind, Record<string, Names>][]) {
    for (const [english, spanish] of Object.entries(table)) {
      out.push({ kind, english, spanish: typeof spanish === 'string' ? [spanish] : spanish });
    }
  }
  return out;
}
