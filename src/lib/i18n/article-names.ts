import { spanishName } from '@/lib/wiki/links';
import { termNames, type TermKind } from './terms';

/**
 * Spanish names for the articles that have no translation yet.
 *
 * 177 of the 1,027 articles are untranslated, and they are not a random
 * sample: they include the hub pages people search for first — Workbench,
 * Boar, Meadows, Forge, Weapons, Food. Most of those are a biome, a category
 * or a station, and take their name from `./terms`; this list covers the rest
 * of the ordinary nouns among them. Proper nouns (Eikthyr, Bonemass, Haldor)
 * are the same in both languages and need no line.
 *
 * Once an article is translated its stored title takes over, so a line here
 * only ever stands in for a translation that has not happened yet.
 */
const NAMES: Record<string, string> = {
  'Abandoned Outpost': 'Puesto abandonado',
  Abomination: 'Abominación',
  'Aggressive creature strategies': 'Estrategias contra criaturas agresivas',
  Ballista: 'Balista',
  'Battering Ram': 'Ariete',
  Bear: 'Oso',
  Birch: 'Abedul',
  Blocking: 'Bloqueo',
  'Blood magic (skill)': 'Magia de sangre (habilidad)',
  Boar: 'Jabalí',
  'Boss strategies': 'Estrategias contra jefes',
  'Building stability': 'Estabilidad de construcción',
  'Carapace Armor': 'Armadura de caparazón',
  Cart: 'Carro',
  Catapult: 'Catapulta',
  'Charred Fortress': 'Fortaleza carbonizada',
  'Charred Warrior': 'Guerrero carbonizado',
  Comfort: 'Comodidad',
  'Community rules': 'Normas de la comunidad',
  'Copper Deposit': 'Depósito de cobre',
  'Crafting menu': 'Menú de fabricación',
  'Creature AI': 'IA de las criaturas',
  'Creature Level': 'Nivel de las criaturas',
  'Creature senses': 'Sentidos de las criaturas',
  Cultivator: 'Cultivador',
  'Damage mechanics': 'Mecánicas de daño',
  'Data IDs': 'IDs de datos',
  'Dedicated servers': 'Servidores dedicados',
  'Developer console': 'Consola de desarrollador',
  'Draugr Village': 'Aldea draugr',
  'Dvergr (race)': 'Dvergr (raza)',
  'Dvergr Excavation Site': 'Excavación dvergr',
  'Dvergr Guard Tower': 'Torre de guardia dvergr',
  'Dvergr Harbor': 'Puerto dvergr',
  'Dvergr Lighthouse': 'Faro dvergr',
  'Dvergr Mage': 'Mago dvergr',
  'Dvergr Rogue': 'Pícaro dvergr',
  'Effect areas': 'Áreas de efecto',
  Environment: 'Entorno',
  Events: 'Eventos',
  Factions: 'Facciones',
  Finewood: 'Madera fina',
  'Forsaken Altars': 'Altares de los Abandonados',
  'Forsaken power': 'Poder de los Abandonados',
  'Frost Caves': 'Cuevas de escarcha',
  'Fuling Village': 'Aldea fuling',
  'Future content': 'Contenido futuro',
  'Global Keys': 'Claves globales',
  'Greydwarf Shaman': 'Chamán greydwarf',
  'How to play': 'Cómo jugar',
  'Infested Citadel': 'Ciudadela infestada',
  'Infested Mine': 'Mina infestada',
  Inventory: 'Inventario',
  'Item IDs': 'IDs de objetos',
  Leviathan: 'Leviatán',
  'Loot chest': 'Cofre de botín',
  Mushroom: 'Hongo',
  Music: 'Música',
  'Mysterious Rock': 'Roca misteriosa',
  'Padded Armor': 'Armadura acolchada',
  'Passive creature strategies': 'Estrategias con criaturas pasivas',
  'Player base': 'Base del jugador',
  'Progression guide': 'Guía de progresión',
  Resistance: 'Resistencia',
  'Root Set': 'Conjunto de raíz',
  Runestone: 'Piedra rúnica',
  'Sacrificial Stones': 'Piedras de sacrificio',
  Seeker: 'Buscador',
  'Seeker Soldier': 'Soldado buscador',
  Serpent: 'Serpiente',
  Sign: 'Cartel',
  'Silver Vein': 'Veta de plata',
  Skeleton: 'Esqueleto',
  Sleeping: 'Dormir',
  Smoke: 'Humo',
  'Sneaking (skill)': 'Sigilo (habilidad)',
  'Spawn zones': 'Zonas de aparición',
  'Staff of Protection': 'Bastón de protección',
  'Status effects': 'Efectos de estado',
  'Stone Golem': 'Gólem de piedra',
  'Sunken Crypts': 'Criptas hundidas',
  Taming: 'Domesticación',
  'The Bog Witch': 'La Bruja del Pantano',
  'The Elder': 'El Anciano',
  'The Queen': 'La Reina',
  'Troll Set': 'Conjunto de troll',
  Troubleshooting: 'Solución de problemas',
  'Version history': 'Historial de versiones',
  Wolf: 'Lobo',
  'Wolf Armor': 'Armadura de lobo',
  'World Modifiers': 'Modificadores del mundo',
  'World seed': 'Semilla del mundo',
  Zones: 'Zonas',
};

/** Hub pages are named after the vocabulary: the "Weapons" article is the Weapons category. */
const VOCABULARY_ORDER: TermKind[] = ['category', 'biome', 'station', 'type', 'facet'];

/**
 * An article's Spanish name and the other Spanish names it answers to.
 *
 * The stored translation's title wins, without its English gloss; then this
 * file's list; then the vocabulary, for an article titled after a biome, a
 * category or a station. `name` is null when the Spanish name would only
 * repeat the English one.
 *
 * A title can be a vocabulary value without being the thing the vocabulary
 * names: "Chest" is the armour slot of Rag Armor's type and also the storage
 * chest's article, so the chest answered to "Pecho" and a search for chest
 * armour listed six storage chests. The vocabulary's names are therefore
 * borrowed only by an article the translation does not contradict — one with
 * no translation, or whose translated name is one of them ("Astas" for the
 * Polearms hub). The translation of the storage chest says "Cofre".
 */
export function spanishTitle(
  english: string,
  translated: string | null | undefined,
): { name: string | null; aliases: string[] } {
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  const named = translated ? spanishName(translated, english) : null;
  const vocabulary = VOCABULARY_ORDER.map((kind) => termNames(kind, english)).find((names) => names.length > 0) ?? [];
  const borrowed =
    named === null || VOCABULARY_ORDER.some((kind) => termNames(kind, english).some((n) => same(n, named))) ? vocabulary : [];
  const name = named ?? NAMES[english] ?? borrowed[0] ?? null;

  const aliases = [...new Set(borrowed)].filter((alias) => !same(alias, english) && !(name && same(alias, name)));
  return { name: name && !same(name, english) ? name : null, aliases };
}
