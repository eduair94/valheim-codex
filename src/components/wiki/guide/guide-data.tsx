import type { ReactNode } from 'react';
import { Item, type Bi, type ChecklistEntry } from './guide-ui';

/**
 * The 100%-completion guide's content, in both languages.
 *
 * Hand-written rather than DB-backed, unlike every other page under
 * `/wiki/*`: there is no Fandom source to scrape for "how do I finish the
 * game", so this was researched and cross-checked once, dated, and kept as
 * plain content next to the code instead. Facts that could not be confirmed
 * against a second source were left out rather than guessed — see the note
 * at the bottom of the page.
 *
 * Current as of 21 Aug 2026, live patch 0.221.12.
 *
 * The structure is shared and the prose is not. Ids, chapter order, which
 * item appears in which list, every number in every table: one copy, below.
 * Each sentence a reader sees is a `Bi` — the Spanish original and its
 * English version side by side — so a correction to a fact is made once and
 * a correction to wording is made where the two languages can be compared.
 * Checkbox ids are shared too, which keeps a reader's ticks when they switch
 * language.
 *
 * Item names stay in their official English form in both languages, exactly
 * as the game shows them; see `Item`.
 */

export type Biome = {
  /** Anchor id, shared by both languages so a deep link survives a language switch. */
  id: string;
  /** The game's own (English) name, in both languages. */
  name: string;
  tag: Bi<string>;
  desc: Bi;
  resources: readonly ChecklistEntry[];
  structures: readonly ChecklistEntry[];
  enemies: Bi;
  crafting: Bi;
  callout?: Bi;
  /** `warn` only when the callout is about what costs a death; a tip stays a plain note (`Callout`). */
  calloutTone?: 'note' | 'warn';
  boss: { name: ReactNode; summon: Bi; power: Bi; drops: Bi };
  extra?: { label: Bi<string>; items: readonly ChecklistEntry[] };
};

/** A top-level part of the guide: its anchor, its heading, and its shorter name in the table of contents. */
export type GuideSection = { id: string; title: Bi<string>; toc: Bi<string> };

export const SECTIONS = {
  criteria: {
    id: 'criterios',
    title: { es: 'Qué significa “100%” acá', en: 'What “100%” means here' },
    toc: { es: 'Qué es el 100%', en: 'What 100% means' },
  },
  mechanics: {
    id: 'mecanicas',
    title: { es: 'Mecánicas que vas a usar todo el juego', en: 'Mechanics you’ll use all game long' },
    toc: { es: 'Mecánicas', en: 'Mechanics' },
  },
  biomes: {
    id: 'biomas',
    title: { es: 'Los siete biomas, en orden', en: 'The seven biomes, in order' },
    toc: { es: 'Los siete biomas', en: 'The seven biomes' },
  },
  traders: {
    id: 'mercaderes',
    title: { es: 'Los tres mercaderes', en: 'The three traders' },
    toc: { es: 'Mercaderes', en: 'Traders' },
  },
  hildir: {
    id: 'hildir',
    title: { es: 'Hildir’s Request', en: 'Hildir’s Request' },
    toc: { es: 'Hildir’s Request', en: 'Hildir’s Request' },
  },
  ships: {
    id: 'barcos',
    title: { es: 'Barcos', en: 'Ships' },
    toc: { es: 'Barcos', en: 'Ships' },
  },
  taming: {
    id: 'domesticacion',
    title: { es: 'Domesticación', en: 'Taming' },
    toc: { es: 'Domesticación', en: 'Taming' },
  },
  bosses: {
    id: 'checklist-maestra',
    title: { es: 'Checklist maestra de jefes', en: 'Master boss checklist' },
    toc: { es: 'Checklist de jefes', en: 'Boss checklist' },
  },
  deepNorth: {
    id: 'deep-north',
    title: { es: 'Qué sigue: Deep North', en: 'What’s next: Deep North' },
    toc: { es: 'Qué sigue', en: 'What’s next' },
  },
} as const satisfies Record<string, GuideSection>;

// ---------------------------------------------------------------- header

export const INTRO = {
  meta: {
    es: 'Guía de finalización · Early Access, hasta Ashlands',
    en: 'Completion guide · Early Access, up to Ashlands',
  },
  lede: {
    es: (
      <>
        Checklist completa, bioma por bioma, para llegar al 100% del contenido actual del juego. Los
        nombres de objetos, criaturas y estructuras aparecen en <Item link={false}>inglés</Item>, tal
        como figuran en el juego.
      </>
    ),
    en: (
      <>
        A complete checklist, biome by biome, for reaching 100% of the game’s current content. Item,
        creature and structure names are written <Item link={false}>like this</Item>, exactly as they
        appear in the game.
      </>
    ),
  },
  beforeLabel: { es: 'Antes de arrancar', en: 'Before you start' },
  before: {
    es: (
      <>
        <strong>Parche en vivo:</strong> 0.221.12 (19 feb 2026). Valheim sigue en Acceso Anticipado.{' '}
        <strong>La versión 1.0 llega el 9 de septiembre de 2026</strong> con el bioma final{' '}
        <Item>Deep North</Item>, logros oficiales de Steam y probablemente un 8º jefe — todavía no
        salió a la fecha de esta guía. El juego hoy no tiene logros ni contador de “% completado”
        propio: el 100% de acá es una definición de la comunidad. Convendrá revisar esta guía otra vez
        después del 1.0.
      </>
    ),
    en: (
      <>
        <strong>Live patch:</strong> 0.221.12 (Feb 19, 2026). Valheim is still in Early Access.{' '}
        <strong>Version 1.0 arrives on September 9, 2026</strong> with the final biome,{' '}
        <Item>Deep North</Item>, official Steam achievements and probably an 8th boss — it was not out
        yet when this guide was written. Today the game has no achievements and no “% complete”
        counter of its own: the 100% here is a community definition. This guide will need another look
        after 1.0.
      </>
    ),
  },
} as const;

// -------------------------------------------------------------- criteria

export const CRITERIA_INTRO: Bi = {
  es: 'Doce puntos generales — cada uno se desglosa después, bioma por bioma.',
  en: 'Twelve broad goals — each one is broken down later, biome by biome.',
};

export const CRITERIA: readonly ChecklistEntry[] = [
  {
    id: 'c-bosses',
    label: {
      es: (
        <>
          Derrotar los <strong>7 jefes</strong> y activar sus 7 Poderes Ancestrales (Forsaken Powers)
          al menos una vez cada uno.
        </>
      ),
      en: (
        <>
          Defeat all <strong>7 bosses</strong> and activate each of their 7 Forsaken Powers at least
          once.
        </>
      ),
    },
  },
  {
    id: 'c-hildir',
    label: {
      es: (
        <>
          Completar <strong>Hildir’s Request</strong> entera: las 3 mazmorras, los 3 minijefes, los 3
          cofres entregados.
        </>
      ),
      en: (
        <>
          Complete <strong>Hildir’s Request</strong> in full: all 3 dungeons, all 3 minibosses, all 3
          chests handed in.
        </>
      ),
    },
  },
  {
    id: 'c-dungeons',
    label: {
      es: 'Visitar al menos una instancia de cada tipo de mazmorra/punto de interés en cada bioma.',
      en: 'Visit at least one of every kind of dungeon and point of interest in every biome.',
    },
  },
  {
    id: 'c-gear',
    label: {
      es: 'Craftear al menos una pieza de cada set de armadura y cada tipo de arma, incluidas las que dependen de un jefe o bioma específico.',
      en: 'Craft at least one piece of every armor set and every type of weapon, including the ones that depend on a specific boss or biome.',
    },
  },
  {
    id: 'c-uniques',
    label: {
      es: (
        <>
          Conseguir los objetos únicos con nombre propio: <Item>Megingjord</Item>,{' '}
          <Item>Dverger Circlet</Item>, <Item>Wishbone</Item>, <Item>Dead Raiser</Item>, las varitas
          mágicas de Mistlands, <Item>Dyrnwyn</Item>.
        </>
      ),
      en: (
        <>
          Get the named unique items: <Item>Megingjord</Item>, <Item>Dverger Circlet</Item>,{' '}
          <Item>Wishbone</Item>, <Item>Dead Raiser</Item>, the Mistlands magic staffs,{' '}
          <Item>Dyrnwyn</Item>.
        </>
      ),
    },
  },
  {
    id: 'c-portals',
    label: {
      es: 'Conectar por portal todos los biomas que descubriste y tener al menos una base en cada uno.',
      en: 'Link every biome you have discovered by portal, and keep at least one base in each.',
    },
  },
  {
    id: 'c-tame',
    label: {
      es: 'Domesticar las 5 especies domesticables y criar al menos un par de cada una.',
      en: 'Tame all 5 tameable species and breed at least one pair of each.',
    },
  },
  {
    id: 'c-ships',
    label: {
      es: (
        <>
          Construir los 4 niveles de barco: <Item>Raft</Item>, <Item>Karve</Item>,{' '}
          <Item>Longship</Item>, <Item>Drakkar</Item>.
        </>
      ),
      en: (
        <>
          Build all 4 tiers of ship: <Item>Raft</Item>, <Item>Karve</Item>, <Item>Longship</Item>,{' '}
          <Item>Drakkar</Item>.
        </>
      ),
    },
  },
  {
    id: 'c-food',
    label: {
      es: 'Cocinar y probar cada comida, cada aguamiel (mead) y los 8 Feasts de la Bog Witch.',
      en: 'Cook and eat every food, every mead and the Bog Witch’s 8 Feasts.',
    },
  },
  {
    id: 'c-fish',
    label: {
      es: 'Pescar al menos una vez cada especie de pez del juego.',
      en: 'Catch every species of fish in the game at least once.',
    },
  },
  {
    id: 'c-traders',
    label: {
      es: 'Comerciar con los 3 mercaderes (Haldor, Hildir, la Bog Witch) y vaciar su inventario completo.',
      en: 'Trade with all 3 traders (Haldor, Hildir, the Bog Witch) and buy out their full stock.',
    },
  },
  {
    id: 'c-lore',
    label: {
      es: (
        <>
          Encontrar las 3 <strong>Ubicaciones Misteriosas</strong> (fragmentos de <Item>Dyrnwyn</Item>)
          y leer cada piedra rúnica que te cruces.
        </>
      ),
      en: (
        <>
          Find the 3 <strong>Mysterious Locations</strong> (where the <Item>Dyrnwyn</Item> fragments
          are) and read every runestone you come across.
        </>
      ),
    },
  },
];

export const MYTH: Bi = {
  es: (
    <>
      <strong>Un mito para descartar:</strong> no existe un jefe secreto estacional permanente.{' '}
      <Item>The Hare</Item> es una criatura pasiva de Mistlands (10 de vida, no domesticable) que se
      caza para cocinar, no un encuentro de combate.
    </>
  ),
  en: (
    <>
      <strong>A myth to put to rest:</strong> there is no permanent secret seasonal boss.{' '}
      <Item>The Hare</Item> is a passive Mistlands creature (10 health, can’t be tamed) that you hunt
      for cooking, not a combat encounter.
    </>
  ),
};

// ------------------------------------------------------------- mechanics

export const VEGVISIR = {
  heading: { es: 'Vegvisir y altares', en: 'Vegvisirs and altars' },
  body: {
    es: (
      <>
        Cada jefe tiene un Altar del Olvidado (Forsaken Altar). Un <Item>Vegvisir</Item> revela la
        ubicación del altar más cercano sin descubrir — pero no es obligatorio: tropezar con el altar
        alcanza igual.
      </>
    ),
    en: (
      <>
        Every boss has a Forsaken Altar. A <Item>Vegvisir</Item> reveals where the nearest
        undiscovered altar is — but you don’t need one: stumbling onto the altar works just as well.
      </>
    ),
  },
  caption: { es: 'Dónde suele aparecer cada Vegvisir', en: 'Where each Vegvisir usually turns up' },
  headers: { es: ['Jefe', 'Ubicación'], en: ['Boss', 'Location'] },
  rows: [
    {
      boss: 'Eikthyr',
      where: {
        es: <>En las <Item>Sacrificial Stones</Item> donde empezás la partida — ya está garantizado.</>,
        en: <>At the <Item>Sacrificial Stones</Item> where you start the game — always there.</>,
      },
    },
    {
      boss: 'The Elder',
      where: {
        es: <>A veces en un <Item>Burial Chamber</Item>, o junto a torres en ruinas de Black Forest.</>,
        en: <>Sometimes in a <Item>Burial Chamber</Item>, or next to ruined towers in the Black Forest.</>,
      },
    },
    {
      boss: 'Bonemass',
      where: {
        es: <>A veces en un <Item>Sunken Crypt</Item>, o junto a torres rúnicas del Swamp.</>,
        en: <>Sometimes in a <Item>Sunken Crypt</Item>, or next to the Swamp’s rune towers.</>,
      },
    },
    {
      boss: 'Moder',
      where: {
        es: <>A veces en un <Item>Frost Cave</Item>, o junto a torres de Mountain.</>,
        en: <>Sometimes in a <Item>Frost Cave</Item>, or next to towers in the Mountains.</>,
      },
    },
    {
      boss: 'Yagluth',
      where: {
        es: 'Cerca de formaciones tipo Stonehenge en Plains.',
        en: 'Near Stonehenge-like rock formations in the Plains.',
      },
    },
    {
      boss: 'The Queen',
      where: {
        es: <>A veces en un <Item>Infested Mine</Item>.</>,
        en: <>Sometimes in an <Item>Infested Mine</Item>.</>,
      },
    },
    {
      boss: 'Fader',
      where: {
        es: (
          <>
            En la torre central de un <Item>Charred Fortress</Item> (50%), rara vez sobre{' '}
            <Item>Charred Ruins</Item>.
          </>
        ),
        en: (
          <>
            In the central tower of a <Item>Charred Fortress</Item> (50%), rarely on{' '}
            <Item>Charred Ruins</Item>.
          </>
        ),
      },
    },
  ],
} as const;

export const POWERS = {
  heading: { es: 'Poderes Ancestrales (Forsaken Powers)', en: 'Forsaken Powers' },
  /** The paragraph ends in a link to the boss table; the link text is kept apart so the page can render it as one. */
  body: {
    es: (
      <>
        Al colgar el trofeo de un jefe en tu <Item>Sacrificial Stones</Item> activás su poder para el
        resto de la partida: dura <strong>5 minutos</strong> con <strong>20 de reutilización</strong>,
        compartidos entre todos los poderes — no se resetea al dormir ni al desconectarte. Tabla
        completa en la
      </>
    ),
    en: (
      <>
        Hanging a boss’s trophy on your <Item>Sacrificial Stones</Item> unlocks its power for the rest
        of the game: each use lasts <strong>5 minutes</strong>, with a <strong>20-minute
        cooldown</strong> shared by every power — and sleeping or logging out doesn’t reset it. The full
        table is in the
      </>
    ),
  },
  link: { es: 'checklist maestra', en: 'master boss checklist' },
} as const;

/** Raw ore and its smelted forms, the things a portal refuses. In-game names. */
export const PORTAL_BLOCKED = [
  'Black metal', 'Black metal scrap', 'Bronze', 'Charred cogwheel', 'Copper', 'Copper ore',
  'Copper scrap', 'Dragon egg', 'Dvergr extractor', 'Flametal', 'Flametal ore', "Hildir's chests",
  'Iron', 'Iron ore', 'Mechanical spring', 'Scrap bronze', 'Scrap iron', 'Silver', 'Silver ore',
  'Tin', 'Tin ore',
] as const;

export const PORTALS = {
  heading: { es: 'Qué NO podés teletransportar', en: 'What you can’t teleport' },
  lead: {
    es: 'Los portales bloquean el mineral crudo y sus versiones fundidas:',
    en: 'Portals block raw ore and its smelted forms:',
  },
  tail: {
    es: 'Lo ya crafteado con esos materiales sí pasa.',
    en: 'Anything already crafted from them goes through.',
  },
  exception: {
    es: (
      <>
        <strong>Excepción real:</strong> la estructura <Item>Portal Stone</Item> (Ashlands) sí permite
        teletransportar todo eso, mineral incluido.
      </>
    ),
    en: (
      <>
        <strong>The one real exception:</strong> the <Item>Portal Stone</Item> structure (Ashlands)
        lets all of it through, ore included.
      </>
    ),
  },
} as const;

export const STATIONS = {
  heading: { es: 'Progresión de estaciones de crafteo', en: 'Crafting station progression' },
  steps: [
    {
      es: (
        <>
          <Item>Workbench</Item> → con <Item>Hard Antler</Item> (drop de Eikthyr) craftea el{' '}
          <Item>Antler Pickaxe</Item>, necesario para minar en Black Forest.
        </>
      ),
      en: (
        <>
          <Item>Workbench</Item> → with <Item>Hard Antler</Item> (dropped by Eikthyr) it crafts the{' '}
          <Item>Antler Pickaxe</Item>, which you need to mine in the Black Forest.
        </>
      ),
    },
    {
      es: (
        <>
          <Item>Forge</Item> (pide <Item>Surtling Core</Item>) + <Item>Smelter</Item> → Bronce, luego
          Hierro (Swamp) y Plata (Mountain).
        </>
      ),
      en: (
        <>
          <Item>Forge</Item> (needs <Item>Surtling Core</Item>) + <Item>Smelter</Item> → bronze, then
          iron (Swamp) and silver (Mountain).
        </>
      ),
    },
    {
      es: (
        <>
          <Item>Artisan Table</Item> (10× <Item>Dragon Tear</Item>, drop de Moder) → habilita Blast
          Furnace, Spinning Wheel, Windmill, Stone Oven.
        </>
      ),
      en: (
        <>
          <Item>Artisan Table</Item> (10× <Item>Dragon Tear</Item>, dropped by Moder) → unlocks the
          Blast Furnace, Spinning Wheel, Windmill and Stone Oven.
        </>
      ),
    },
    {
      es: (
        <>
          <Item>Blast Furnace</Item> → única estación que funde <Item>Black Metal Scrap</Item> (Plains)
          y luego <Item>Flametal ore</Item> (Ashlands).
        </>
      ),
      en: (
        <>
          <Item>Blast Furnace</Item> → the only station that smelts <Item>Black Metal Scrap</Item>{' '}
          (Plains), and later <Item>Flametal ore</Item> (Ashlands).
        </>
      ),
    },
    {
      es: (
        <>
          <Item>Black Forge</Item> y <Item>Galdr Table</Item> (Mistlands) → gear física y mágica de
          Mistlands/Ashlands, mejorables hasta nivel 5.
        </>
      ),
      en: (
        <>
          <Item>Black Forge</Item> and <Item>Galdr Table</Item> (Mistlands) → physical and magic gear
          for the Mistlands and Ashlands; both upgrade to level 5.
        </>
      ),
    },
  ] satisfies Bi[],
} as const;

// ---------------------------------------------------------------- biomes

export const BIOMES: readonly Biome[] = [
  {
    id: 'meadows',
    name: 'Meadows',
    tag: { es: 'Bioma inicial', en: 'Starting biome' },
    desc: {
      es: 'Donde empieza toda partida. Bajo riesgo: acá aprendés a talar, cazar y construir tu primera base.',
      en: 'Where every game begins. Low risk: this is where you learn to chop wood, hunt and build your first base.',
    },
    resources: [
      {
        id: 'm-wood',
        label: {
          es: <><Item>Wood</Item> (cualquier árbol) y <Item>Fine Wood</Item> (Birch).</>,
          en: <><Item>Wood</Item> (any tree) and <Item>Fine Wood</Item> (Birch).</>,
        },
      },
      {
        id: 'm-food',
        label: {
          es: (
            <>
              <Item>Raw Meat</Item> + <Item>Deer Hide</Item> (Deer), <Item>Leather Scraps</Item> (Boar),{' '}
              <Item>Raspberry</Item>, <Item>Dandelion</Item>, <Item>Mushroom</Item>.
            </>
          ),
          en: (
            <>
              <Item>Raw Meat</Item> + <Item>Deer Hide</Item> (Deer), <Item>Leather Scraps</Item> (Boar),{' '}
              <Item>Raspberry</Item>, <Item>Dandelion</Item>, <Item>Mushroom</Item>.
            </>
          ),
        },
      },
      {
        id: 'm-misc',
        label: {
          es: (
            <>
              <Item>Stone</Item>, <Item>Flint</Item> (cerca del agua), <Item>Resin</Item>,{' '}
              <Item>Queen Bee</Item> (colmenas silvestres).
            </>
          ),
          en: (
            <>
              <Item>Stone</Item>, <Item>Flint</Item> (near water), <Item>Resin</Item>,{' '}
              <Item>Queen Bee</Item> (from wild beehives).
            </>
          ),
        },
      },
    ],
    structures: [
      {
        id: 'm-house',
        label: {
          es: (
            <>
              <Item>Abandoned House</Item> — cofres con el <Item>Curious Axe Head</Item> y el{' '}
              <Item>Mysterious Axe Head</Item>.
            </>
          ),
          en: (
            <>
              <Item>Abandoned House</Item> — chests holding the <Item>Curious Axe Head</Item> and the{' '}
              <Item>Mysterious Axe Head</Item>.
            </>
          ),
        },
        note: {
          es: (
            <>
              Con esas dos piezas + 4 Wood en un Workbench nivel 1 se craftean las{' '}
              <Item>Early Axes</Item>, agregadas recién en el parche 0.221.10 (feb 2026) — fácil de
              pasar por alto en guías viejas.
            </>
          ),
          en: (
            <>
              Those two pieces plus 4 Wood at a level 1 Workbench craft the <Item>Early Axes</Item>,
              added only in patch 0.221.10 (Feb 2026) — easy to miss in older guides.
            </>
          ),
        },
      },
      {
        id: 'm-mound',
        label: {
          es: 'Túmulos con forma de barco — se cavan con pico para sacar Coins.',
          en: 'Ship-shaped burial mounds — dig into them with a pickaxe for Coins.',
        },
      },
    ],
    enemies: {
      es: (
        <>
          <Item>Boar</Item>, <Item>Deer</Item> (cazables), <Item>Neck</Item>, <Item>Greyling</Item>,{' '}
          <Item>Seagull</Item>. Nada peligroso todavía.
        </>
      ),
      en: (
        <>
          <Item>Boar</Item>, <Item>Deer</Item> (for hunting), <Item>Neck</Item>, <Item>Greyling</Item>,{' '}
          <Item>Seagull</Item>. Nothing dangerous yet.
        </>
      ),
    },
    crafting: {
      es: (
        <>
          <Item>Workbench</Item>, herramientas de piedra/madera, armadura de{' '}
          <Item article="Leather Armor">Leather</Item>&nbsp;/ <Item article="Rag Armor">Rag</Item>.
        </>
      ),
      en: (
        <>
          <Item>Workbench</Item>, stone and wood tools, <Item article="Leather Armor">Leather</Item>
          &nbsp;/ <Item article="Rag Armor">Rag</Item> armor.
        </>
      ),
    },
    boss: {
      name: 'Eikthyr',
      summon: {
        es: <>2× <Item>Deer Trophy</Item> en el altar (Vegvisir garantizado en el spawn).</>,
        en: <>2× <Item>Deer Trophy</Item> on the altar (its Vegvisir is guaranteed at the spawn).</>,
      },
      power: {
        es: '−60% costo de estamina al correr, saltar y nadar.',
        en: '−60% stamina cost for running, jumping and swimming.',
      },
      drops: {
        es: <><Item>Eikthyr Trophy</Item> ×1, <Item>Hard Antler</Item> ×3.</>,
        en: <><Item>Eikthyr Trophy</Item> ×1, <Item>Hard Antler</Item> ×3.</>,
      },
    },
  },
  {
    id: 'blackforest',
    name: 'Black Forest',
    tag: { es: 'Bronce', en: 'Bronze' },
    desc: {
      es: 'Primer bioma con mazmorras de verdad, y el único lugar del juego con Cobre y Estaño.',
      en: 'The first biome with real dungeons, and the only place in the game with copper and tin.',
    },
    resources: [
      {
        id: 'bf-ore',
        label: {
          es: (
            <>
              <Item>Copper Ore</Item> (con Antler Pickaxe+) y <Item>Tin Ore</Item> (costero) — únicos
              del bioma.
            </>
          ),
          en: (
            <>
              <Item>Copper Ore</Item> (Antler Pickaxe or better) and <Item>Tin Ore</Item> (along the
              shore) — found only here.
            </>
          ),
        },
      },
      {
        id: 'bf-wood',
        label: {
          es: (
            <>
              <Item>Core Wood</Item>, <Item>Surtling Core</Item> (Burial Chambers o Surtlings) —
              imprescindible para el Forge.
            </>
          ),
          en: (
            <>
              <Item>Core Wood</Item>, <Item>Surtling Core</Item> (Burial Chambers or Surtlings) —
              essential for the Forge.
            </>
          ),
        },
      },
      {
        id: 'bf-food',
        label: {
          es: <><Item>Blueberry</Item>, <Item>Thistle</Item>, <Item>Yellow Mushroom</Item>, semillas de zanahoria.</>,
          en: <><Item>Blueberry</Item>, <Item>Thistle</Item>, <Item>Yellow Mushroom</Item>, carrot seeds.</>,
        },
      },
    ],
    structures: [
      {
        id: 'bf-burial',
        label: {
          es: <><Item>Burial Chambers</Item> — primera mazmorra instanciada, con Skeletons.</>,
          en: <><Item>Burial Chambers</Item> — the first instanced dungeon, with Skeletons.</>,
        },
      },
      {
        id: 'bf-troll',
        label: {
          es: <><Item>Troll Cave</Item> — una sala; Coins, Ruby, Amber Pearl, Amber.</>,
          en: <><Item>Troll Cave</Item> — a single chamber; Coins, Ruby, Amber Pearl, Amber.</>,
        },
      },
    ],
    enemies: {
      es: (
        <>
          <Item>Greydwarf</Item>, <Item>Greydwarf Brute</Item>, <Item>Greydwarf Shaman</Item>,{' '}
          <Item>Skeleton</Item>, y el <Item>Troll</Item> (mucha vida).
        </>
      ),
      en: (
        <>
          <Item>Greydwarf</Item>, <Item>Greydwarf Brute</Item>, <Item>Greydwarf Shaman</Item>,{' '}
          <Item>Skeleton</Item>, and the <Item>Troll</Item> (lots of health).
        </>
      ),
    },
    crafting: {
      es: (
        <>
          <Item>Forge</Item> + <Item>Smelter</Item> → gear de <strong>Bronce</strong>:{' '}
          <Item>Bronze Plate Cuirass</Item>, <Item>Bronze Helmet</Item>, <Item>Bronze Buckler</Item>,
          armas de bronce y el <Item>Bronze Pickaxe</Item>.
        </>
      ),
      en: (
        <>
          <Item>Forge</Item> + <Item>Smelter</Item> → <strong>Bronze</strong> gear:{' '}
          <Item>Bronze Plate Cuirass</Item>, <Item>Bronze Helmet</Item>, <Item>Bronze Buckler</Item>,
          bronze weapons and the <Item>Bronze Pickaxe</Item>.
        </>
      ),
    },
    boss: {
      name: 'The Elder',
      summon: {
        es: <>3× <Item>Ancient Seed</Item> (rompiendo <Item>Greydwarf Nest</Item> o cazando Brutes).</>,
        en: <>3× <Item>Ancient Seed</Item> (from breaking a <Item>Greydwarf Nest</Item> or killing Brutes).</>,
      },
      power: {
        es: '+60% daño de hacha/pico, +30% regeneración de vida.',
        en: '+60% axe and pickaxe damage, +30% health regeneration.',
      },
      drops: {
        es: <><Item>The Elder Trophy</Item>, <Item>Swamp Key</Item> (reutilizable, abre los Sunken Crypts).</>,
        en: <><Item>The Elder Trophy</Item>, <Item>Swamp Key</Item> (reusable; opens the Sunken Crypts).</>,
      },
    },
  },
  {
    id: 'swamp',
    name: 'Swamp',
    tag: { es: 'Hierro', en: 'Iron' },
    desc: {
      es: 'Lluvia constante — estamina drenada todo el tiempo. Acá vive la Bog Witch.',
      en: 'Constant rain — your stamina is drained the whole time. The Bog Witch lives here.',
    },
    resources: [
      {
        id: 'sw-iron',
        label: {
          es: (
            <>
              <Item>Scrap Iron</Item> y <Item>Withered Bone</Item> — de los{' '}
              <Item>Muddy Scrap Pile</Item> dentro de los Sunken Crypts.
            </>
          ),
          en: (
            <>
              <Item>Scrap Iron</Item> and <Item>Withered Bone</Item> — from each{' '}
              <Item>Muddy Scrap Pile</Item> inside the Sunken Crypts.
            </>
          ),
        },
      },
      {
        id: 'sw-bark',
        label: {
          es: (
            <>
              <Item>Ancient Bark</Item> (árboles antiguos), <Item>Guck</Item> (golpeando los sacos de
              los árboles).
            </>
          ),
          en: (
            <>
              <Item>Ancient Bark</Item> (from ancient trees), <Item>Guck</Item> (hit the sacs on the
              trees).
            </>
          ),
        },
      },
      {
        id: 'sw-root',
        label: {
          es: (
            <>
              <Item article="Root (item)">Root</Item> — drop raro del <Item>Abomination</Item>, para la
              armadura Root.
            </>
          ),
          en: (
            <>
              <Item article="Root (item)">Root</Item> — a rare drop from the <Item>Abomination</Item>,
              for the Root armor.
            </>
          ),
        },
      },
    ],
    structures: [
      {
        id: 'sw-crypt',
        label: {
          es: <><Item>Sunken Crypt</Item> — pide la <Item>Swamp Key</Item> de The Elder.</>,
          en: <><Item>Sunken Crypt</Item> — needs the <Item>Swamp Key</Item> from The Elder.</>,
        },
      },
      {
        id: 'sw-tower',
        label: {
          es: 'Torres en ruina que generan Draugr sin parar.',
          en: 'Ruined towers that spawn Draugr nonstop.',
        },
      },
    ],
    enemies: {
      es: (
        <>
          <Item>Draugr</Item>, <Item>Draugr Elite</Item>, <Item>Blob</Item>&nbsp;/ <Item>Oozer</Item>{' '}
          (veneno), <Item>Leech</Item>, <Item>Wraith</Item> (solo de noche), <Item>Abomination</Item>.
        </>
      ),
      en: (
        <>
          <Item>Draugr</Item>, <Item>Draugr Elite</Item>, <Item>Blob</Item>&nbsp;/ <Item>Oozer</Item>{' '}
          (poison), <Item>Leech</Item>, <Item>Wraith</Item> (only at night), <Item>Abomination</Item>.
        </>
      ),
    },
    crafting: {
      es: (
        <>
          Gear de <strong>Hierro</strong>: <Item>Iron Helmet</Item>, <Item>Iron Scale Mail</Item>,{' '}
          <Item>Battleaxe</Item>. Alternativa anti-veneno: set <Item>Root Mask</Item>&nbsp;/{' '}
          <Item>Root Harnesk</Item>&nbsp;/ <Item>Root Leggings</Item>.
        </>
      ),
      en: (
        <>
          <strong>Iron</strong> gear: <Item>Iron Helmet</Item>, <Item>Iron Scale Mail</Item>,{' '}
          <Item>Battleaxe</Item>. Poison-resistant alternative: the <Item>Root Mask</Item>&nbsp;/{' '}
          <Item>Root Harnesk</Item>&nbsp;/ <Item>Root Leggings</Item> set.
        </>
      ),
    },
    boss: {
      name: 'Bonemass',
      summon: {
        es: <>10× <Item>Withered Bone</Item>.</>,
        en: <>10× <Item>Withered Bone</Item>.</>,
      },
      power: {
        es: '−25% daño físico recibido, −100% costo de estamina al bloquear, +5 estamina por bloqueo.',
        en: '−25% physical damage taken, −100% stamina cost for blocking, +5 stamina per block.',
      },
      drops: {
        es: <><Item>Bonemass Trophy</Item>, <Item>Wishbone</Item> (detector — pita cerca de Plata y tesoros).</>,
        en: <><Item>Bonemass Trophy</Item>, <Item>Wishbone</Item> (a detector — it pings near silver and treasure).</>,
      },
    },
  },
  {
    id: 'mountain',
    name: 'Mountain',
    tag: { es: 'Plata', en: 'Silver' },
    desc: {
      es: 'Frío de verdad: sin resistencia perdés vida. Llevá Frost Resistance Mead o una capa de Wolf/Lox/Fenris.',
      en: 'Properly cold: without frost resistance you lose health. Bring a Frost Resistance Mead or a Wolf, Lox or Fenris cape.',
    },
    resources: [
      {
        id: 'mt-silver',
        label: {
          es: <><Item>Silver Ore</Item> — vetas escondidas, se ubican con el <Item>Wishbone</Item> de Bonemass.</>,
          en: <><Item>Silver Ore</Item> — hidden veins; find them with the <Item>Wishbone</Item> from Bonemass.</>,
        },
      },
      {
        id: 'mt-obs',
        label: {
          es: <><Item>Obsidian</Item> (Iron Pickaxe+), <Item>Crystal</Item> (paredes o drop de Stone Golem).</>,
          en: <><Item>Obsidian</Item> (Iron Pickaxe or better), <Item>Crystal</Item> (from walls, or dropped by Stone Golems).</>,
        },
      },
      {
        id: 'mt-egg',
        label: {
          es: <><Item>Dragon Egg</Item> — nidos de Drake. Pesa 200: no pasa por portal.</>,
          en: <><Item>Dragon Egg</Item> — from Drake nests. It weighs 200 and can’t go through a portal.</>,
        },
      },
    ],
    structures: [
      {
        id: 'mt-cave',
        label: {
          es: <><Item>Frost Cave</Item> — Cultists y su Ulv; Crystal, <Item>Fenris Hair</Item>, <Item>Fenris Claw</Item>.</>,
          en: <><Item>Frost Cave</Item> — Cultists and their Ulvs; Crystal, <Item>Fenris Hair</Item>, <Item>Fenris Claw</Item>.</>,
        },
      },
    ],
    enemies: {
      es: (
        <>
          <Item>Wolf</Item>, <Item>Fenring</Item> (jauría), <Item>Drake</Item>, <Item>Stone Golem</Item>,
          Cultist + Ulv (solo en Frost Cave).
        </>
      ),
      en: (
        <>
          <Item>Wolf</Item>, <Item>Fenring</Item> (in packs), <Item>Drake</Item>,{' '}
          <Item>Stone Golem</Item>, Cultist + Ulv (only in Frost Caves).
        </>
      ),
    },
    crafting: {
      es: (
        <>
          Set <Item>Wolf armor</Item> — mayor defensa antes de Plains. Set <Item>Fenris</Item> (loot de
          Frost Cave) — +9% velocidad. <Item>Frostner</Item> y <Item>Silver Sword</Item>. Con Moder:{' '}
          <Item>Artisan Table</Item> → Spinning Wheel, Windmill, Stone Oven, Blast Furnace.
        </>
      ),
      en: (
        <>
          <Item>Wolf armor</Item> set — the best defense before the Plains. <Item>Fenris</Item> set
          (Frost Cave loot) — +9% speed. <Item>Frostner</Item> and <Item>Silver Sword</Item>. After
          Moder: <Item>Artisan Table</Item> → Spinning Wheel, Windmill, Stone Oven, Blast Furnace.
        </>
      ),
    },
    boss: {
      name: 'Moder',
      summon: {
        es: <>3× <Item>Dragon Egg</Item>, uno por cuenco.</>,
        en: <>3× <Item>Dragon Egg</Item>, one per bowl.</>,
      },
      power: {
        es: 'Viento de cola al navegar, +300 peso de carga, +10% velocidad, −50% daño de frío.',
        en: 'A tailwind while sailing, +300 carry weight, +10% speed, −50% frost damage.',
      },
      drops: {
        es: <><Item>Moder Trophy</Item>, 10× <Item>Dragon Tear</Item> (para el Artisan Table).</>,
        en: <><Item>Moder Trophy</Item>, 10× <Item>Dragon Tear</Item> (for the Artisan Table).</>,
      },
    },
  },
  {
    id: 'plains',
    name: 'Plains',
    tag: { es: 'Metal Negro', en: 'Black metal' },
    desc: {
      es: 'Fulings por todos lados y el Deathsquito, capaz de matarte de un golpe.',
      en: 'Fulings everywhere, and the Deathsquito, which can kill you in a single hit.',
    },
    resources: [
      {
        id: 'pl-flax',
        label: {
          es: <><Item>Flax</Item> y <Item>Barley</Item> — en los campos de las aldeas Fuling.</>,
          en: <><Item>Flax</Item> and <Item>Barley</Item> — in the fields of Fuling villages.</>,
        },
      },
      {
        id: 'pl-tar',
        label: {
          es: <><Item>Tar</Item> — de los <Item>Tar Pit</Item> y del monstruo <Item>Growth</Item> (usá flechas de fuego).</>,
          en: <><Item>Tar</Item> — from each <Item>Tar Pit</Item> and from the <Item>Growth</Item> monster (use fire arrows).</>,
        },
      },
      {
        id: 'pl-scrap',
        label: {
          es: <><Item>Black Metal Scrap</Item> — drop de cualquier Fuling y cofres de aldea.</>,
          en: <><Item>Black Metal Scrap</Item> — dropped by any Fuling, and in village chests.</>,
        },
      },
    ],
    structures: [
      {
        id: 'pl-village',
        label: {
          es: <><Item>Fuling Village</Item> — campos, hoguera con 50% de chance de <Item>Fuling Totem</Item>, cofres.</>,
          en: <><Item>Fuling Village</Item> — fields, a bonfire with a 50% chance of a <Item>Fuling Totem</Item>, chests.</>,
        },
      },
    ],
    enemies: {
      es: (
        <>
          <Item>Fuling</Item>, <Item>Fuling Archer</Item>, <Item>Fuling Berserker</Item> (puede dropear
          el raro <Item>Krom</Item>), <Item>Fuling Shaman</Item>, <Item>Lox</Item>,{' '}
          <Item>Deathsquito</Item>.
        </>
      ),
      en: (
        <>
          <Item>Fuling</Item>, <Item>Fuling Archer</Item>, <Item>Fuling Berserker</Item> (can drop the
          rare <Item>Krom</Item>), <Item>Fuling Shaman</Item>, <Item>Lox</Item>,{' '}
          <Item>Deathsquito</Item>.
        </>
      ),
    },
    crafting: {
      es: (
        <>
          <Item>Blast Furnace</Item> → única estación que funde Black Metal Scrap. Set{' '}
          <Item>Padded armor</Item> — mejor set pre-Mistlands. Armas de <strong>Black Metal</strong>:
          Atgeir, Sword, la maza <Item>Porcupine</Item>, las dagas <Item>Skoll and Hati</Item>.
        </>
      ),
      en: (
        <>
          <Item>Blast Furnace</Item> → the only station that smelts Black Metal Scrap.{' '}
          <Item>Padded armor</Item> set — the best set before the Mistlands. <strong>Black Metal</strong>{' '}
          weapons: atgeir, sword, the <Item>Porcupine</Item> mace, the <Item>Skoll and Hati</Item>{' '}
          daggers.
        </>
      ),
    },
    boss: {
      name: 'Yagluth',
      summon: {
        es: <>5× <Item>Fuling Totem</Item>.</>,
        en: <>5× <Item>Fuling Totem</Item>.</>,
      },
      power: {
        es: '−50% daño de rayo, +25 en la skill Farming, +10% daño infligido.',
        en: '−50% lightning damage, +25 to the Farming skill, +10% damage dealt.',
      },
      drops: {
        es: <Item>Yagluth Trophy</Item>,
        en: <Item>Yagluth Trophy</Item>,
      },
    },
  },
  {
    id: 'mistlands',
    name: 'Mistlands',
    tag: { es: 'Eitr y magia', en: 'Eitr and magic' },
    desc: {
      es: 'Niebla permanente, casi sin visibilidad hasta que la resolvés. Acá entra la magia vía el Eitr.',
      en: 'Permanent mist, with almost no visibility until you deal with it. This is where magic comes in, through Eitr.',
    },
    resources: [
      {
        id: 'ml-marble',
        label: {
          es: (
            <>
              <Item>Black Marble</Item> y <Item>Soft Tissue</Item> — de los <Item>Giant Remains</Item>,
              con Black Metal Pickaxe.
            </>
          ),
          en: (
            <>
              <Item>Black Marble</Item> and <Item>Soft Tissue</Item> — from <Item>Giant Remains</Item>,
              with a Black Metal Pickaxe.
            </>
          ),
        },
      },
      {
        id: 'ml-ygg',
        label: {
          es: <><Item>Yggdrasil Wood</Item> y <Item>Sap</Item> (con un Sap Extractor sobre una Ancient Root).</>,
          en: <><Item>Yggdrasil Wood</Item> and <Item>Sap</Item> (with a Sap Extractor on an Ancient Root).</>,
        },
      },
      {
        id: 'ml-core',
        label: {
          es: <><Item>Black Core</Item> — en Infested Mine; hacen falta 15 por estación.</>,
          en: <><Item>Black Core</Item> — in Infested Mines; you need 15 per station.</>,
        },
      },
      {
        id: 'ml-eitr',
        label: {
          es: <><Item>Magecap</Item> — primer alimento que sube el Eitr máximo.</>,
          en: <><Item>Magecap</Item> — the first food that raises your maximum Eitr.</>,
        },
      },
    ],
    structures: [
      {
        id: 'ml-mine',
        label: {
          es: <><Item>Infested Mine</Item> — la mazmorra más común: campamento Dvergr tomado por Seekers.</>,
          en: <><Item>Infested Mine</Item> — the most common dungeon: a Dvergr camp overrun by Seekers.</>,
        },
      },
      {
        id: 'ml-citadel',
        label: {
          es: (
            <>
              <Item>Infested Citadel</Item> — la guarida de la Reina, tras una puerta que exige el{' '}
              <Item>Sealbreaker</Item>.
            </>
          ),
          en: (
            <>
              <Item>Infested Citadel</Item> — the Queen’s lair, behind a door that needs the{' '}
              <Item>Sealbreaker</Item>.
            </>
          ),
        },
      },
      {
        id: 'ml-reto',
        label: {
          es: <><Item>Tomb of Lord Reto</Item> — minijefe, dropea un fragmento de <Item>Dyrnwyn</Item>.</>,
          en: <><Item>Tomb of Lord Reto</Item> — a miniboss that drops a <Item>Dyrnwyn</Item> fragment.</>,
        },
      },
    ],
    enemies: {
      es: (
        <>
          <Item>Seeker</Item> (vuela), <Item>Seeker Soldier</Item> (punto débil en el abdomen),{' '}
          <Item>Gjall</Item> (aéreo, sus huevos eclosionan en Tick), Dvergr Rogue/Mage (neutrales hasta
          que los atacás).
        </>
      ),
      en: (
        <>
          <Item>Seeker</Item> (flies), <Item>Seeker Soldier</Item> (weak point on the abdomen),{' '}
          <Item>Gjall</Item> (airborne; its eggs hatch into Ticks), Dvergr Rogues and Mages (neutral
          until you attack them).
        </>
      ),
    },
    crafting: {
      es: (
        <>
          <Item>Black Forge</Item> → set <Item article="Carapace Armor">Carapace</Item>.{' '}
          <Item>Galdr Table</Item> → set <Item>Eitr-weave</Item> + <Item>Feather Cape</Item>, bastones{' '}
          <Item>Staff of Embers</Item>&nbsp;/ <Item>Staff of Frost</Item>&nbsp;/{' '}
          <Item>Staff of Protection</Item>, y <Item>Skoll and Hati</Item>. El <Item>Sealbreaker</Item>{' '}
          se craftea con 9× Sealbreaker Fragment.
        </>
      ),
      en: (
        <>
          <Item>Black Forge</Item> → <Item article="Carapace Armor">Carapace</Item> set.{' '}
          <Item>Galdr Table</Item> → <Item>Eitr-weave</Item> set + <Item>Feather Cape</Item>, the{' '}
          <Item>Staff of Embers</Item>&nbsp;/ <Item>Staff of Frost</Item>&nbsp;/{' '}
          <Item>Staff of Protection</Item>, and <Item>Skoll and Hati</Item>. The{' '}
          <Item>Sealbreaker</Item> is crafted from 9× Sealbreaker Fragment.
        </>
      ),
    },
    callout: {
      es: (
        <>
          Ojo: el Metal Negro sigue fundiéndose con Black Metal Scrap de <strong>Plains</strong>, no de
          Mistlands — este bioma no tiene mineral nuevo propio, aporta Black Core como su recurso
          exclusivo de alto nivel.
        </>
      ),
      en: (
        <>
          Heads-up: black metal is still smelted from the Black Metal Scrap of the{' '}
          <strong>Plains</strong>, not the Mistlands — this biome has no new ore of its own; its
          exclusive high-tier resource is Black Core.
        </>
      ),
    },
    boss: {
      name: 'The Queen',
      summon: {
        es: (
          <>
            Sin ítem la 1ª vez — abrís el Citadel con el Sealbreaker. Para volver: 3×{' '}
            <Item>Seeker Soldier Trophy</Item> sobre el trono.
          </>
        ),
        en: (
          <>
            No item the first time — you open the Citadel with the Sealbreaker. To fight her again: 3×{' '}
            <Item>Seeker Soldier Trophy</Item> on the throne.
          </>
        ),
      },
      power: {
        es: '+100% regeneración de Eitr, −100% costo de estamina agachado, −50% daño de veneno.',
        en: '+100% Eitr regeneration, −100% stamina cost while sneaking, −50% poison damage.',
      },
      drops: {
        es: <><Item>Queen&apos;s Trophy</Item>, 5× <Item>Majestic Carapace</Item> (Artisan Press → Ceramic Plate).</>,
        en: <><Item>Queen&apos;s Trophy</Item>, 5× <Item>Majestic Carapace</Item> (Artisan Press → Ceramic Plate).</>,
      },
    },
    extra: {
      label: { es: 'No te lo pierdas', en: 'Don’t miss' },
      items: [
        {
          id: 'ml-x1',
          label: {
            es: (
              <>
                Buscar las 3 <Item>Mysterious Location</Item> (Vegvisir desde Putrid Holes de Ashlands)
                para los fragmentos de Dyrnwyn.
              </>
            ),
            en: (
              <>
                Find all 3 <Item>Mysterious Location</Item> sites (Vegvisirs in the Putrid Holes of the
                Ashlands) for the Dyrnwyn fragments.
              </>
            ),
          },
        },
      ],
    },
  },
  {
    id: 'ashlands',
    name: 'Ashlands',
    tag: { es: 'Flametal · jefe final actual', en: 'Flametal · current final boss' },
    desc: {
      es: 'El bioma más hostil hoy: el mar hierve, la ceniza destruye estructuras, y hasta las criaturas se dañan entre sí.',
      en: 'The most hostile biome today: the sea boils, the ash destroys buildings, and even the creatures hurt each other.',
    },
    resources: [
      {
        id: 'as-flame',
        label: {
          es: (
            <>
              <Item>Flametal Ore</Item> — vetas (Black Metal Pickaxe+), cofres, o pescando un Magmafish.
              Se funde en Blast Furnace.
            </>
          ),
          en: (
            <>
              <Item>Flametal Ore</Item> — veins (Black Metal Pickaxe or better), chests, or fishing up a
              Magmafish. Smelted in the Blast Furnace.
            </>
          ),
        },
      },
      {
        id: 'as-soft',
        label: {
          es: <><Item>Soft Tissue</Item> (drop de Morgen) → <Item>Refined Eitr</Item> en el Eitr Refinery.</>,
          en: <><Item>Soft Tissue</Item> (dropped by Morgen) → <Item>Refined Eitr</Item> at the Eitr Refinery.</>,
        },
      },
      {
        id: 'as-wood',
        label: {
          es: (
            <>
              <Item>Ashwood</Item>, <Item>Grausten</Item> (con Stonecutter), <Item>Molten Core</Item>,{' '}
              <Item>Bell Fragment</Item>.
            </>
          ),
          en: (
            <>
              <Item>Ashwood</Item>, <Item>Grausten</Item> (with a Stonecutter), <Item>Molten Core</Item>,{' '}
              <Item>Bell Fragment</Item>.
            </>
          ),
        },
      },
    ],
    structures: [
      {
        id: 'as-fortress',
        label: {
          es: (
            <>
              <Item>Charred Fortress</Item> (hasta 20 por mundo) — su torre central tiene Bell Fragments
              y hasta 10× Molten Core.
            </>
          ),
          en: (
            <>
              <Item>Charred Fortress</Item> (up to 20 per world) — its central tower holds Bell
              Fragments and up to 10× Molten Core.
            </>
          ),
        },
      },
      {
        id: 'as-hole',
        label: {
          es: <><Item>Putrid Hole</Item> — mazmorra que además sirve de refugio.</>,
          en: <><Item>Putrid Hole</Item> — a dungeon that doubles as a shelter.</>,
        },
      },
    ],
    enemies: {
      es: (
        <>
          <Item>Charred Warrior</Item>, <Item>Charred Marksman</Item>, <Item>Charred Warlock</Item>,{' '}
          <Item>Morgen</Item>, <Item>Bonemaw</Item>, <Item>Asksvin</Item>, <Item>Volture</Item>,{' '}
          <Item>Lava Blob</Item>, <Item>Fallen Valkyrie</Item> (hostil) y el minijefe{' '}
          <Item>Lord Reto</Item>.
        </>
      ),
      en: (
        <>
          <Item>Charred Warrior</Item>, <Item>Charred Marksman</Item>, <Item>Charred Warlock</Item>,{' '}
          <Item>Morgen</Item>, <Item>Bonemaw</Item>, <Item>Asksvin</Item>, <Item>Volture</Item>,{' '}
          <Item>Lava Blob</Item>, <Item>Fallen Valkyrie</Item> (hostile) and the miniboss{' '}
          <Item>Lord Reto</Item>.
        </>
      ),
    },
    crafting: {
      es: (
        <>
          Black Forge mejorado (hasta nivel 5) → gear de <strong>Flametal</strong>: set{' '}
          <Item>Flametal Helmet</Item>&nbsp;/ <Item>Flametal Breastplate</Item>&nbsp;/{' '}
          <Item>Flametal Greaves</Item> o <Item>Robes of Embla</Item>. Familias de armas con variantes
          elementales: <Item>Nidhögg</Item>, <Item>Ripper</Item>, <Item>Berserkir</Item>,{' '}
          <Item>Slayer</Item>. La espada legendaria <Item>Dyrnwyn</Item> se arma con sus 3 fragmentos.
        </>
      ),
      en: (
        <>
          An upgraded Black Forge (up to level 5) → <strong>Flametal</strong> gear: the{' '}
          <Item>Flametal Helmet</Item>&nbsp;/ <Item>Flametal Breastplate</Item>&nbsp;/{' '}
          <Item>Flametal Greaves</Item> set or the <Item>Robes of Embla</Item>. Weapon families with
          elemental variants: <Item>Nidhögg</Item>, <Item>Ripper</Item>, <Item>Berserkir</Item>,{' '}
          <Item>Slayer</Item>. The legendary sword <Item>Dyrnwyn</Item> is assembled from its 3
          fragments.
        </>
      ),
    },
    callout: {
      es: (
        <>
          El mar hierve: solo el <Item>Drakkar</Item> lo cruza sin daño; nadar ahí acumula calor y puede
          matarte a 50 de daño puro/seg. La lluvia de cenizas destruye madera — construí con
          Ashwood/Grausten/piedra y un <Item>Shield Generator</Item>.
        </>
      ),
      en: (
        <>
          The sea boils: only the <Item>Drakkar</Item> crosses it unharmed; swimming there builds up
          heat and can kill you at 50 true damage per second. The ash rain destroys wood — build with
          Ashwood, Grausten or stone, and a <Item>Shield Generator</Item>.
        </>
      ),
    },
    calloutTone: 'warn',
    boss: {
      name: <>Fader (&ldquo;the Emerald Flame&rdquo;)</>,
      summon: {
        es: (
          <>
            3× <Item>Bell</Item> (cada uno con 3× Bell Fragment, 9 en total) alrededor del coliseo.
          </>
        ),
        en: (
          <>
            3× <Item>Bell</Item> (each made from 3× Bell Fragment, 9 in total) around the arena.
          </>
        ),
      },
      power: {
        es: '+100% ganancia de Adrenalina, −50% acumulación de stagger, −50% daño de fuego.',
        en: '+100% Adrenaline gain, −50% stagger buildup, −50% fire damage.',
      },
      drops: {
        es: <><Item>Fader Trophy</Item>, 5× <Item>Fader Relic</Item>.</>,
        en: <><Item>Fader Trophy</Item>, 5× <Item>Fader Relic</Item>.</>,
      },
    },
  },
];

// --------------------------------------------------------------- traders

export const TRADERS = {
  intro: {
    es: 'Ninguno es obligatorio para avanzar, pero completarlos a los tres es parte del 100%.',
    en: 'None of them is required to progress, but finishing all three is part of 100%.',
  },
  haldor: {
    heading: { es: 'Haldor — Black Forest', en: 'Haldor — Black Forest' },
    body: {
      es: 'Aparece una sola vez por mundo, siempre en Black Forest, a menos de ~1500m del centro.',
      en: 'He appears only once per world, always in the Black Forest, within ~1,500 m of the world center.',
    },
    caption: { es: 'Inventario de Haldor', en: 'Haldor’s stock' },
    headers: { es: ['Ítem', 'Precio', 'Condición'], en: ['Item', 'Price', 'Requires'] },
    rows: [
      { item: 'Fishing Bait', price: '10' },
      { item: 'Yule Hat', price: '100' },
      { item: 'Barrel Hoops', price: '100' },
      { item: 'Fishing Rod', price: '350' },
      { item: 'Dverger Circlet', price: '620' },
      { item: 'Megingjord', price: '950' },
      { item: 'Thunder Stone', price: '50', after: 'The Elder' },
      { item: 'Ymir Flesh', price: '120', after: 'The Elder' },
      { item: 'Egg', price: '1500', after: 'Yagluth' },
    ],
    /** How the "unlocked after" column reads: `tras The Elder` / `after The Elder`. */
    after: { es: 'tras', en: 'after' },
    buys: {
      es: (
        <>
          Te compra <Item>Amber</Item>, <Item>Amber Pearl</Item>, <Item>Ruby</Item> y{' '}
          <Item>Silver Necklace</Item>.
        </>
      ),
      en: (
        <>
          He buys <Item>Amber</Item>, <Item>Amber Pearl</Item>, <Item>Ruby</Item> and{' '}
          <Item>Silver Necklace</Item>.
        </>
      ),
    },
  },
  bogWitch: {
    heading: { es: 'La Bog Witch — Swamp', en: 'The Bog Witch — Swamp' },
    body: {
      es: 'No pide ningún jefe para encontrarla: cabaña costera entre 3000–8000m del centro, marcada con un ícono de caldero. Trae tres novedades:',
      en: 'No boss stands between you and her: a coastal hut 3,000–8,000 m from the world center, marked with a cauldron icon. She brings three new things:',
    },
    points: [
      {
        es: (
          <>
            <strong>Feasts:</strong> comidas grandes para compartir en grupo. Necesitás la{' '}
            <Item>Food Preparation Table</Item> y la <Item>Serving Tray</Item> que ella vende (140
            Coins). Cada Feast se come varias veces y el buff dura 50 minutos — 8 recetas, una por bioma
            más una náutica.
          </>
        ),
        en: (
          <>
            <strong>Feasts:</strong> big meals to share with your group. You need the{' '}
            <Item>Food Preparation Table</Item> and the <Item>Serving Tray</Item> she sells (140 Coins).
            Each Feast can be eaten several times and the buff lasts 50 minutes — 8 recipes, one per
            biome plus a seafaring one.
          </>
        ),
      },
      {
        es: (
          <>
            <strong>3 skills nuevas:</strong> <Item>Cooking</Item>, <Item>Farming</Item> y{' '}
            <Item article="Crafting (skill)">Crafting</Item> — suben con el uso.
          </>
        ),
        en: (
          <>
            <strong>3 new skills:</strong> <Item>Cooking</Item>, <Item>Farming</Item> and{' '}
            <Item article="Crafting (skill)">Crafting</Item> — they level up as you use them.
          </>
        ),
      },
      {
        es: (
          <>
            <strong>8 pociones:</strong> <Item>Berserkir Mead</Item>, <Item>Tonic of Ratatosk</Item>,{' '}
            <Item>Lightfoot Mead</Item>, <Item>Draught of Vananidir</Item>,{' '}
            <Item>Mead of Troll Endurance</Item>, <Item>Brew of Animal Whispers</Item>,{' '}
            <Item>Anti-Sting Concoction</Item>, <Item>Love Potion</Item>.
          </>
        ),
        en: (
          <>
            <strong>8 potions:</strong> <Item>Berserkir Mead</Item>, <Item>Tonic of Ratatosk</Item>,{' '}
            <Item>Lightfoot Mead</Item>, <Item>Draught of Vananidir</Item>,{' '}
            <Item>Mead of Troll Endurance</Item>, <Item>Brew of Animal Whispers</Item>,{' '}
            <Item>Anti-Sting Concoction</Item>, <Item>Love Potion</Item>.
          </>
        ),
      },
    ] satisfies Bi[],
    stock: {
      es: 'Su inventario base se amplía después de cada jefe que derrotás — el precio exacto de cada desbloqueo varía según la fuente, confirmalo en el juego antes de planear una compra grande.',
      en: 'Her base stock grows after each boss you defeat — the exact price of each unlock varies between sources, so check it in the game before planning a big purchase.',
    },
  },
} as const;

// ---------------------------------------------------------------- hildir

export const HILDIR = {
  body: {
    es: (
      <>
        Tres mazmorras cortas repartidas en tres biomas, cada una con su minijefe. Empieza en el
        campamento de <Item>Hildir</Item> en Meadows (3000–5100m del centro): interactuá con la
        mesa-mapa frente a su carpa y se marcan las tres en tu mapa.
      </>
    ),
    en: (
      <>
        Three short dungeons spread across three biomes, each with its own miniboss. It starts with{' '}
        <Item>Hildir</Item>, at her camp in the Meadows (3,000–5,100 m from the world center): interact
        with the map table in front of her tent and all three are marked on your map.
      </>
    ),
  },
  caption: { es: 'Las tres mazmorras', en: 'The three dungeons' },
  headers: {
    es: ['Mazmorra', 'Bioma', 'Minijefe(s)', 'Recompensa'],
    en: ['Dungeon', 'Biome', 'Miniboss(es)', 'Reward'],
  },
  rows: [
    {
      dungeon: 'Smouldering Tomb',
      biome: 'Black Forest',
      bosses: <Item>Brenna</Item>,
      reward: "Hildir's Brass Chest",
    },
    {
      dungeon: 'Howling Cavern',
      biome: 'Mountain',
      bosses: <Item>Geirrhafa</Item>,
      reward: "Hildir's Silver Chest",
    },
    {
      dungeon: 'Sealed Tower',
      biome: 'Plains',
      bosses: <><Item>Thungr</Item> + <Item>Zil</Item></>,
      reward: "Hildir's Bronze Chest",
    },
  ],
  chests: {
    es: (
      <>
        Cada cofre pesa 200 y <strong>no pasa por portal</strong>. Entregarlo desbloquea ropa cosmética
        y activa una <strong>invasión recurrente</strong> de ese minijefe sobre tu base.
      </>
    ),
    en: (
      <>
        Each chest weighs 200 and <strong>can’t go through a portal</strong>. Handing it in unlocks
        cosmetic clothing and sets off a <strong>recurring raid</strong> on your base by that miniboss.
      </>
    ),
  },
  barber: [
    {
      id: 'h-barber',
      label: {
        es: (
          <>
            Comprar el <Item>Barber Kit</Item> (600 Coins) y construir la <Item>Barber Station</Item> —
            8 peinados y 5 barbas nuevas.
          </>
        ),
        en: (
          <>
            Buy the <Item>Barber Kit</Item> (600 Coins) and build the <Item>Barber Station</Item> — 8
            new hairstyles and 5 new beards.
          </>
        ),
      },
    },
  ] satisfies ChecklistEntry[],
} as const;

// ------------------------------------------------------- ships and taming

export const SHIPS = {
  caption: { es: '4 niveles (Workbench)', en: '4 tiers (Workbench)' },
  headers: { es: ['Barco', 'HP', 'Cargo'], en: ['Ship', 'HP', 'Cargo'] },
  rows: [
    { ship: 'Raft', hp: '300', cargo: '0' },
    { ship: 'Karve', hp: '500', cargo: '4' },
    { ship: 'Longship', hp: '1000', cargo: '18' },
    { ship: 'Drakkar', hp: '3000', cargo: '32' },
  ],
  note: {
    es: <>El <Item>Drakkar</Item> es el único que cruza el mar hirviente de Ashlands sin daño.</>,
    en: <>The <Item>Drakkar</Item> is the only ship that crosses the boiling sea of the Ashlands unharmed.</>,
  },
} as const;

export const TAMING = {
  intro: { es: '5 especies domesticables.', en: '5 tameable species.' },
  items: [
    {
      id: 't-boar',
      label: {
        es: <><Item>Boar</Item> (Meadows) — comida vegetal.</>,
        en: <><Item>Boar</Item> (Meadows) — plant-based food.</>,
      },
    },
    {
      id: 't-wolf',
      label: {
        es: <><Item>Wolf</Item> (Mountain) — carne cruda.</>,
        en: <><Item>Wolf</Item> (Mountain) — raw meat.</>,
      },
    },
    {
      id: 't-lox',
      label: {
        es: <><Item>Lox</Item> (Plains) — Barley&nbsp;/ Cloudberry.</>,
        en: <><Item>Lox</Item> (Plains) — Barley&nbsp;/ Cloudberry.</>,
      },
    },
    {
      id: 't-chicken',
      label: {
        es: <><Item>Chicken</Item> — nace ya domesticada de un <Item>Egg</Item> de Haldor, 30 min junto al fuego.</>,
        en: <><Item>Chicken</Item> — hatches already tame from an <Item>Egg</Item> bought from Haldor, after 30 min by a fire.</>,
      },
    },
    {
      id: 't-asksvin',
      label: {
        es: (
          <>
            <Item>Asksvin</Item> (Ashlands) — Smoke Puff&nbsp;/ Vineberry Cluster&nbsp;/ Fiddlehead;
            ensillable, cruza lava.
          </>
        ),
        en: (
          <>
            <Item>Asksvin</Item> (Ashlands) — Smoke Puff&nbsp;/ Vineberry Cluster&nbsp;/ Fiddlehead; it
            can be saddled and crosses lava.
          </>
        ),
      },
    },
  ] satisfies ChecklistEntry[],
} as const;

// ------------------------------------------------------------ boss table

export const BOSS_TABLE = {
  caption: { es: 'Los 7 jefes actuales, en orden', en: 'The 7 current bosses, in order' },
  headers: {
    es: ['Jefe', 'Bioma', 'Invocación', 'Poder Ancestral'],
    en: ['Boss', 'Biome', 'Summon', 'Forsaken Power'],
  },
  rows: [
    {
      boss: 'Eikthyr',
      biome: 'Meadows',
      summon: { es: <>2× <Item>Deer Trophy</Item></>, en: <>2× <Item>Deer Trophy</Item></> },
      power: { es: '−60% estamina correr/saltar/nadar', en: '−60% stamina to run, jump and swim' },
    },
    {
      boss: 'The Elder',
      biome: 'Black Forest',
      summon: { es: <>3× <Item>Ancient Seed</Item></>, en: <>3× <Item>Ancient Seed</Item></> },
      power: { es: '+60% daño hacha/pico, +30% regen. vida', en: '+60% axe/pickaxe damage, +30% health regen' },
    },
    {
      boss: 'Bonemass',
      biome: 'Swamp',
      summon: { es: <>10× <Item>Withered Bone</Item></>, en: <>10× <Item>Withered Bone</Item></> },
      power: { es: '−25% daño físico, bloqueo gratis', en: '−25% physical damage, free blocking' },
    },
    {
      boss: 'Moder',
      biome: 'Mountain',
      summon: { es: <>3× <Item>Dragon Egg</Item></>, en: <>3× <Item>Dragon Egg</Item></> },
      power: { es: 'Viento de cola, +300 peso, −50% frío', en: 'Tailwind, +300 carry weight, −50% frost' },
    },
    {
      boss: 'Yagluth',
      biome: 'Plains',
      summon: { es: <>5× <Item>Fuling Totem</Item></>, en: <>5× <Item>Fuling Totem</Item></> },
      power: { es: '−50% rayo, +25 Farming, +10% daño', en: '−50% lightning, +25 Farming, +10% damage' },
    },
    {
      boss: 'The Queen',
      biome: 'Mistlands',
      summon: {
        es: <>Sealbreaker (1ª vez)&nbsp;/ 3× <Item>Seeker Soldier Trophy</Item></>,
        en: <>Sealbreaker (first time)&nbsp;/ 3× <Item>Seeker Soldier Trophy</Item></>,
      },
      power: { es: '+100% regen. Eitr, sneak gratis, −50% veneno', en: '+100% Eitr regen, free sneaking, −50% poison' },
    },
    {
      boss: 'Fader',
      biome: 'Ashlands',
      summon: { es: <>3× <Item>Bell</Item></>, en: <>3× <Item>Bell</Item></> },
      power: { es: '+100% Adrenalina, −50% stagger, −50% fuego', en: '+100% Adrenaline, −50% stagger, −50% fire' },
    },
  ],
  note: {
    es: 'Todos los poderes duran 5 minutos con 20 de reutilización compartidos.',
    en: 'Every power lasts 5 minutes, with a 20-minute cooldown they all share.',
  },
} as const;

// ------------------------------------------------------------ deep north

export const DEEP_NORTH = {
  kicker: { es: 'Todavía no disponible', en: 'Not out yet' },
  body: {
    es: (
      <>
        El 8º y último bioma confirmado, con el jefe final del juego, criaturas nuevas (
        <Item>Gammeltroll</Item>, <Item>Elakingar</Item>) y zonas subterráneas. Llega con la{' '}
        <strong>versión 1.0</strong>, fijada para el <strong>9 de septiembre de 2026</strong>, cuando el
        juego también sale de Acceso Anticipado y estrena logros oficiales de Steam. No está en la
        checklist de arriba porque, a la fecha de esta guía, todavía no es jugable.
      </>
    ),
    en: (
      <>
        The 8th and final confirmed biome, with the game’s final boss, new creatures (
        <Item>Gammeltroll</Item>, <Item>Elakingar</Item>) and underground areas. It arrives with{' '}
        <strong>version 1.0</strong>, set for <strong>September 9, 2026</strong>, when the game also
        leaves Early Access and gains official Steam achievements. It isn’t in the checklist above
        because, as of this guide, it isn’t playable yet.
      </>
    ),
  },
} as const;

// ---------------------------------------------------------------- footer

export const SOURCES: Bi = {
  es: 'Investigación cruzada entre la wiki de Valheim, notas de parche oficiales de Iron Gate y guías secundarias verificadas, con fecha del 21 de agosto de 2026. Donde un dato no pudo confirmarse contra una segunda fuente, se dejó afuera en vez de arriesgar un error — si algo de acá no coincide con lo que ves en el juego, confiá en el juego.',
  en: 'Cross-checked against the Valheim wiki, Iron Gate’s official patch notes and verified secondary guides, as of August 21, 2026, and translated from the Spanish original. Where a fact could not be confirmed against a second source it was left out rather than risk an error — if something here doesn’t match what you see in the game, trust the game.',
};
