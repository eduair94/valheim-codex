/**
 * Spanish → English term map for the Valheim domain.
 *
 * Why this exists: the index is English and a Spanish question shares almost no
 * lexical surface with it, so the full-text retriever contributes nothing and
 * the vector retriever alone has to carry the query. Measured on this corpus,
 * it does not: with 5,856 chunks, a handful of generic list pages ("Crafting",
 * "Materials", "Roadmap") sit close to almost any short Spanish question, and
 * the article that answers it lands at rank 10, 43 or 222.
 *
 * The LLM rewrite solves this well — when it runs. It is one network call per
 * question, subject to quota and outages, and when it fails the whole system
 * degrades to that same unusable state. This map is the floor underneath it:
 * deterministic, instant, free, and good enough that a failed rewrite costs
 * some quality instead of all of it.
 *
 * It is deliberately small. Proper nouns (Yagluth, Surtling, Fuling) are
 * identical in both languages and need no entry; only ordinary vocabulary and
 * the few translated game terms do.
 */
const GLOSSARY: Record<string, string> = {
  // Materials and resources
  hierro: 'iron',
  acero: 'steel',
  bronce: 'bronze',
  cobre: 'copper',
  estaño: 'tin',
  plata: 'silver',
  oro: 'gold',
  madera: 'wood',
  piedra: 'stone',
  carbón: 'coal',
  carbon: 'coal',
  cuero: 'leather',
  pieles: 'pelt',
  piel: 'pelt',
  hueso: 'bone',
  huesos: 'bone',
  resina: 'resin',
  lino: 'flax',
  cebada: 'barley',
  miel: 'honey',
  núcleo: 'core',
  nucleo: 'core',
  núcleos: 'core',
  nucleos: 'core',
  mineral: 'ore',
  lingote: 'ingot',
  chatarra: 'scrap',
  metal: 'metal',
  cristal: 'crystal',
  cadena: 'chain',
  clavos: 'nails',
  tela: 'linen',
  raíz: 'root',
  raiz: 'root',

  // Equipment
  espada: 'sword',
  espadas: 'sword',
  hacha: 'axe',
  martillo: 'hammer',
  lanza: 'spear',
  arco: 'bow',
  flecha: 'arrow',
  flechas: 'arrow',
  escudo: 'shield',
  armadura: 'armor',
  casco: 'helmet',
  capa: 'cape',
  maza: 'mace',
  pico: 'pickaxe',
  daga: 'knife',
  cuchillo: 'knife',
  antorcha: 'torch',
  cazador: 'huntsman hunter',
  arma: 'weapon',
  armas: 'weapon',
  herramienta: 'tool',

  // Creatures
  jabalí: 'boar',
  jabali: 'boar',
  ciervo: 'deer',
  lobo: 'wolf',
  lobos: 'wolf',
  serpiente: 'serpent',
  troll: 'troll',
  esqueleto: 'skeleton',
  fantasma: 'ghost',
  murciélago: 'bat',
  abeja: 'bee',
  abejas: 'bee',
  gallina: 'chicken',
  jefe: 'boss',
  jefes: 'boss',
  enemigo: 'enemy',
  criatura: 'creature',
  trofeo: 'trophy',

  // Places and world
  bioma: 'biome',
  pradera: 'meadows',
  praderas: 'meadows',
  bosque: 'forest',
  pantano: 'swamp',
  montaña: 'mountain',
  montaña_s: 'mountain',
  llanura: 'plains',
  llanuras: 'plains',
  océano: 'ocean',
  oceano: 'ocean',
  cueva: 'cave',
  cripta: 'crypt',
  aldea: 'village',
  altar: 'altar',
  portal: 'portal',
  barco: 'ship',
  balsa: 'raft',

  // Stations and building
  banco: 'workbench',
  fragua: 'forge',
  forja: 'forge',
  horno: 'kiln smelter',
  fundición: 'smelter',
  fundicion: 'smelter',
  hoguera: 'campfire',
  fuego: 'fire',
  casa: 'house',
  techo: 'roof',
  pared: 'wall',
  suelo: 'floor',
  puerta: 'door',
  cofre: 'chest',
  cama: 'bed',
  colmena: 'beehive',

  // Actions and concepts
  fabricar: 'craft',
  forjar: 'forge craft',
  craftear: 'craft',
  crafteo: 'crafting',
  construir: 'build',
  mejorar: 'upgrade',
  reparar: 'repair',
  cocinar: 'cook',
  domesticar: 'tame',
  domestico: 'tame',
  domar: 'tame',
  invocar: 'summon',
  matar: 'kill',
  derrotar: 'defeat',
  conseguir: 'get obtain',
  consigo: 'get obtain',
  obtener: 'obtain',
  encontrar: 'find',
  cultivar: 'farm grow',
  minar: 'mine',
  talar: 'chop',
  navegar: 'sail',

  // Stats and food
  daño: 'damage',
  dano: 'damage',
  vida: 'health',
  salud: 'health',
  resistencia: 'stamina resistance',
  veneno: 'poison',
  fuego_dmg: 'fire',
  hielo: 'frost',
  rayo: 'lightning',
  comida: 'food',
  comer: 'eat',
  receta: 'recipe',
  recetas: 'recipe',
  materiales: 'materials',
  material: 'material',
  ingredientes: 'ingredients',
  nivel: 'level',
  peso: 'weight',
  durabilidad: 'durability',
  hidromiel: 'mead',
  poción: 'potion',
  pocion: 'potion',
  semilla: 'seed',
  semillas: 'seed',
  cerdo: 'boar pig',
  pescado: 'fish',
  pescar: 'fishing',
  carne: 'meat',
  sopa: 'stew',
};

/**
 * Rewrites a query by replacing known Spanish terms with their English
 * equivalents. Unknown words pass through unchanged, so an English query is
 * returned untouched and a mixed query is partially translated.
 *
 * Returns `null` when nothing was translated, so the caller can avoid running
 * a duplicate of a query it already has.
 */
export function translateQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!words) return null;

  let translated = false;
  const out: string[] = [];

  for (const word of words) {
    const english = GLOSSARY[word];
    if (english) {
      translated = true;
      out.push(english);
    } else {
      out.push(word);
    }
  }

  return translated ? out.join(' ') : null;
}

/** Number of entries, for tests and for the ingest banner. */
export const GLOSSARY_SIZE = Object.keys(GLOSSARY).length;
