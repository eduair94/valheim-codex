import { vocabulary } from '@/lib/i18n/terms';
import { fold } from '@/lib/wiki/slug';

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
 * some quality instead of all of it. The wiki's own search uses the same map,
 * which is what lets "hierro" find Iron.
 *
 * It is deliberately small. Proper nouns (Yagluth, Surtling, Fuling) are
 * identical in both languages and need no entry; only ordinary vocabulary and
 * the few translated game terms do. A value with a space lists alternatives —
 * "horno" is a kiln or a smelter, never both at once.
 *
 * Keys are written with their accents for the reader of this file and folded
 * when the map is built, so "montana" finds what "montaña" does.
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
  cuero: 'leather',
  // A hide or a pelt: Valheim's English says Deer hide, Troll hide and Bear
  // hide but Wolf pelt and Lox pelt, and its Spanish says "piel" for all of
  // them — the recipes print "Piel de ciervo (Deer hide)" more than a hundred
  // times, though the article itself is "Cuero de ciervo".
  pieles: 'pelt hide',
  piel: 'pelt hide',
  hueso: 'bone',
  huesos: 'bone',
  resina: 'resin',
  lino: 'flax',
  cebada: 'barley',
  miel: 'honey',
  núcleo: 'core',
  núcleos: 'core',
  mineral: 'ore',
  lingote: 'ingot',
  chatarra: 'scrap',
  metal: 'metal',
  cristal: 'crystal',
  cadena: 'chain',
  clavos: 'nails',
  tela: 'linen',
  raíz: 'root',
  ojo: 'eye',
  nido: 'nest',

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
  ciervo: 'deer',
  lobo: 'wolf',
  lobos: 'wolf',
  serpiente: 'serpent',
  troll: 'troll',
  // How most of the translations spell it: "Cuero de trol", "pez trol".
  trol: 'troll',
  grisenano: 'greydwarf',
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
  montañas: 'mountain',
  llanura: 'plains',
  llanuras: 'plains',
  océano: 'ocean',
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
  doméstico: 'tame',
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
  vida: 'health',
  salud: 'health',
  resistencia: 'stamina resistance',
  veneno: 'poison',
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
  semilla: 'seed',
  semillas: 'seed',
  cerdo: 'boar pig',
  pescado: 'fish',
  pescar: 'fishing',
  carne: 'meat',
  sopa: 'stew',
};

/**
 * Names of more than one word, matched before the single words.
 *
 * "Banco de trabajo" is the Workbench; read word by word it was "workbench
 * de trabajo", which happened to work, while "mesa de artesano" became "mesa
 * de artesano" and found nothing. Each value here is one English name, all of
 * whose words belong together — which is also how a single word is written
 * whose English takes two: "pecho" is body armour, never a body or an armour.
 *
 * Kept to names the stored translations actually print, where the article's
 * own Spanish name says something else: "Retazos de cuero (Leather scraps)"
 * appears 139 times, the article is "Recortes de cuero"; the Greydwarf is an
 * "enano gris" in some translations and a "trasgo gris" in others. Their
 * words are not glossary entries on their own: "restos" alone names Restos de
 * gigante and Restos rancios, and must not read as scraps.
 *
 * The biome, category, station and type names in `@/lib/i18n/terms` are added
 * to these when the map is built, so a name shown on a tile is a name search
 * understands, and the two lists cannot drift apart.
 */
const PHRASES: Record<string, string> = {
  'núcleo de surtling': 'surtling core',
  'carne de jabalí': 'boar meat',
  'trofeo de jabalí': 'boar trophy',
  'piedra rúnica': 'runestone',
  'retazos de cuero': 'leather scraps',
  'restos de cuero': 'leather scraps',
  'enano gris': 'greydwarf',
  'enanos grises': 'greydwarf',
  'trasgo gris': 'greydwarf',
  // "Asta" is also a polearm (the vocabulary's "Arma de asta"), so the
  // antler pickaxe would otherwise read as a pickaxe of polearms.
  'pico de asta': 'antler pickaxe',
  // The armour slot. Read through the vocabulary it was the storage chest
  // (the one item of type "Chest" is Rag Armor), and as "body" the Body Pile.
  pecho: 'body armor',
};

/** One way to say a source word or phrase in English: every word in it is required. */
export type Alternative = readonly string[];

/**
 * The longest phrase the n-gram pass looks for, in words: "mesa de
 * preparación de alimentos" is five, and the recipe categories run to six.
 */
const MAX_PHRASE_WORDS = 6;

/** A key made of words: folded, single-spaced, letters and digits only. */
function phraseKey(text: string): string {
  return tokenize(fold(text)).join(' ');
}

/**
 * Words the way every caller splits them: letters and digits, NFC first.
 *
 * NFC matters for input that arrives decomposed: "montaña" typed as `n` plus a
 * combining tilde would otherwise split at the mark and translate as nothing.
 */
export function tokenize(text: string): string[] {
  return text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** English alternatives keyed by folded Spanish word or phrase. A Map, so "constructor" is just a word. */
const ENTRIES: Map<string, Alternative[]> = (() => {
  const map = new Map<string, Alternative[]>();
  const add = (spanish: string, alternatives: Alternative[]): void => {
    const k = phraseKey(spanish);
    if (!k || map.has(k)) return;
    map.set(k, alternatives);
  };

  for (const [spanish, english] of Object.entries(GLOSSARY)) {
    add(spanish, english.split(' ').map((word) => [word]));
  }
  for (const [spanish, english] of Object.entries(PHRASES)) add(spanish, [tokenize(english)]);

  // The display vocabulary, read backwards. Explicit entries above win, so
  // a word the glossary already translates keeps its meaning.
  for (const term of vocabulary()) {
    if (term.kind === 'facet') continue; // Field names, not things anyone searches for.
    const english = tokenize(term.english);
    if (english.length === 0) continue;
    for (const spanish of term.spanish) {
      if (phraseKey(spanish) === english.join(' ')) continue; // "Metal" is "Metal".
      add(spanish, [english]);
    }
  }
  return map;
})();

const LONGEST_PHRASE = Math.min(
  MAX_PHRASE_WORDS,
  Math.max(1, ...[...ENTRIES.keys()].map((k) => k.split(' ').length)),
);

/** A run of the query the glossary recognised, or a single word it did not. */
export type GlossaryMatch = {
  /** The words as typed: lowercased, accents kept. */
  words: string[];
  /** English alternatives, or null when the glossary does not know the word. */
  english: Alternative[] | null;
};

/**
 * Splits a query into glossary matches, longest phrase first.
 *
 * Folded on lookup, so accents never decide a match, but the words come back
 * as typed: the chat's full-text index keeps accents, and a proper noun like
 * "Jörmundling" has to reach it intact.
 */
export function matchGlossary(text: string): GlossaryMatch[] {
  const words = tokenize(text);
  const folded = words.map(fold);
  const out: GlossaryMatch[] = [];

  for (let i = 0; i < words.length; ) {
    let matched = false;
    for (let n = Math.min(LONGEST_PHRASE, words.length - i); n >= 1; n -= 1) {
      const english = ENTRIES.get(folded.slice(i, i + n).join(' '));
      if (english) {
        out.push({ words: words.slice(i, i + n), english });
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push({ words: [words[i]!], english: null });
      i += 1;
    }
  }
  return out;
}

/**
 * Rewrites a query by replacing known Spanish terms with their English
 * equivalents. Unknown words pass through unchanged, so an English query is
 * returned untouched and a mixed query is partially translated.
 *
 * Returns `null` when nothing was translated, so the caller can avoid running
 * a duplicate of a query it already has.
 */
export function translateQuery(text: string): string | null {
  const matches = matchGlossary(text);
  if (!matches.some((m) => m.english)) return null;
  return matches
    .map((m) => (m.english ? m.english.map((alternative) => alternative.join(' ')).join(' ') : m.words.join(' ')))
    .join(' ');
}

/** Number of entries, for tests and for the ingest banner. */
export const GLOSSARY_SIZE = ENTRIES.size;
