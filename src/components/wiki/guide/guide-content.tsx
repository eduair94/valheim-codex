import {
  BiomeChapter,
  GuideChecklist,
  GuideH2,
  GuideH3,
  GuideTable,
  Item,
  type BiomeData,
  type ChecklistItem,
} from './guide-ui';

/**
 * The 100%-completion guide.
 *
 * Hand-written rather than DB-backed, unlike every other page under
 * `/wiki/*`: there is no Fandom source to scrape for "how do I finish the
 * game", so this is researched and cross-checked once, dated, and kept as
 * plain content next to the code instead. Facts that could not be confirmed
 * against a second source were left out rather than guessed — see the note
 * at the bottom.
 *
 * Current as of 21 ago 2026, live patch 0.221.12. Spanish only for now: the
 * translation pipeline in `wiki-repo.ts` is for DB-backed articles, and this
 * page has no article row to translate.
 */

const CRITERIA: ChecklistItem[] = [
  {
    id: 'c-bosses',
    label: (
      <>
        Derrotar los <strong className="text-birch">7 jefes</strong> y activar sus 7 Poderes
        Ancestrales (Forsaken Powers) al menos una vez cada uno.
      </>
    ),
  },
  {
    id: 'c-hildir',
    label: (
      <>
        Completar <strong className="text-birch">Hildir&apos;s Request</strong> entera: las 3
        mazmorras, los 3 minijefes, los 3 cofres entregados.
      </>
    ),
  },
  { id: 'c-dungeons', label: 'Visitar al menos una instancia de cada tipo de mazmorra/punto de interés en cada bioma.' },
  {
    id: 'c-gear',
    label: 'Craftear al menos una pieza de cada set de armadura y cada tipo de arma, incluidas las que dependen de un jefe o bioma específico.',
  },
  {
    id: 'c-uniques',
    label: (
      <>
        Conseguir los objetos únicos con nombre propio: <Item>Megingjord</Item>,{' '}
        <Item>Dverger Circlet</Item>, <Item>Wishbone</Item>, <Item>Dead Raiser</Item>, las varitas
        mágicas de Mistlands, <Item>Dyrnwyn</Item>.
      </>
    ),
  },
  { id: 'c-portals', label: 'Conectar por portal todos los biomas que descubriste y tener al menos una base en cada uno.' },
  { id: 'c-tame', label: 'Domesticar las 5 especies domesticables y criar al menos un par de cada una.' },
  {
    id: 'c-ships',
    label: (
      <>
        Construir los 4 niveles de barco: <Item>Raft</Item>, <Item>Karve</Item>, <Item>Longship</Item>,{' '}
        <Item>Drakkar</Item>.
      </>
    ),
  },
  { id: 'c-food', label: 'Cocinar y probar cada comida, cada aguamiel (mead) y los 8 Feasts de la Bog Witch.' },
  { id: 'c-fish', label: 'Pescar al menos una vez cada especie de pez del juego.' },
  { id: 'c-traders', label: 'Comerciar con los 3 mercaderes (Haldor, Hildir, la Bog Witch) y vaciar su inventario completo.' },
  {
    id: 'c-lore',
    label: (
      <>
        Encontrar las 3 <strong className="text-birch">Ubicaciones Misteriosas</strong> (fragmentos
        de <Item>Dyrnwyn</Item>) y leer cada piedra rúnica que te cruces.
      </>
    ),
  },
];

const VEGVISIR_ROWS: [string, React.ReactNode][] = [
  ['Eikthyr', <>En las <Item>Sacrificial Stones</Item> donde empezás la partida — ya está garantizado.</>],
  ['The Elder', <>A veces en un <Item>Burial Chamber</Item>, o junto a torres en ruinas de Black Forest.</>],
  ['Bonemass', <>A veces en un <Item>Sunken Crypt</Item>, o junto a torres rúnicas del Swamp.</>],
  ['Moder', <>A veces en un <Item>Frost Cave</Item>, o junto a torres de Mountain.</>],
  ['Yagluth', 'Cerca de formaciones tipo Stonehenge en Plains.'],
  ['The Queen', <>A veces en un <Item>Infested Mine</Item>.</>],
  ['Fader', <>En la torre central de un <Item>Charred Fortress</Item> (50%), rara vez sobre <Item>Charred Ruins</Item>.</>],
];

const PORTAL_BLOCKED = [
  'Black metal', 'Black metal scrap', 'Bronze', 'Charred cogwheel', 'Copper', 'Copper ore',
  'Copper scrap', 'Dragon egg', 'Dvergr extractor', 'Flametal', 'Flametal ore', "Hildir's chests",
  'Iron', 'Iron ore', 'Mechanical spring', 'Scrap bronze', 'Scrap iron', 'Silver', 'Silver ore',
  'Tin', 'Tin ore',
];

const BOSS_TABLE_ROWS: React.ReactNode[][] = [
  ['1', 'Eikthyr', 'Meadows', <>2× <Item>Deer Trophy</Item></>, '−60% estamina correr/saltar/nadar'],
  ['2', 'The Elder', 'Black Forest', <>3× <Item>Ancient Seed</Item></>, '+60% daño hacha/pico, +30% regen. vida'],
  ['3', 'Bonemass', 'Swamp', <>10× <Item>Withered Bone</Item></>, '−25% daño físico, bloqueo gratis'],
  ['4', 'Moder', 'Mountain', <>3× <Item>Dragon Egg</Item></>, 'Viento de cola, +300 peso, −50% frío'],
  ['5', 'Yagluth', 'Plains', <>5× <Item>Fuling Totem</Item></>, '−50% rayo, +25 Farming, +10% daño'],
  ['6', 'The Queen', 'Mistlands', <>Sealbreaker (1ª vez) / 3× <Item>Seeker Soldier Trophy</Item></>, '+100% regen. Eitr, sneak gratis, −50% veneno'],
  ['7', 'Fader', 'Ashlands', <>3× <Item>Bell</Item></>, '+100% Adrenalina, −50% stagger, −50% fuego'],
];

const HALDOR_ROWS: React.ReactNode[][] = [
  [<Item key="a">Fishing Bait</Item>, '10', '—'],
  [<Item key="b">Yule Hat</Item>, '100', '—'],
  [<Item key="c">Barrel Hoops</Item>, '100', '—'],
  [<Item key="d">Fishing Rod</Item>, '350', '—'],
  [<Item key="e">Dverger Circlet</Item>, '620', '—'],
  [<Item key="f">Megingjord</Item>, '950', '—'],
  [<Item key="g">Thunder Stone</Item>, '50', 'tras The Elder'],
  [<Item key="h">Ymir Flesh</Item>, '120', 'tras The Elder'],
  [<Item key="i">Egg</Item>, '1500', 'tras Yagluth'],
];

const HILDIR_ROWS: React.ReactNode[][] = [
  [<Item key="a">Smouldering Tomb</Item>, 'Black Forest', <Item key="a2">Brenna</Item>, <Item key="a3">Hildir&apos;s Brass Chest</Item>],
  [<Item key="b">Howling Cavern</Item>, 'Mountain', <Item key="b2">Geirrhafa</Item>, <Item key="b3">Hildir&apos;s Silver Chest</Item>],
  [<Item key="c">Sealed Tower</Item>, 'Plains', <><Item>Thungr</Item> + <Item>Zil</Item></>, <Item key="c3">Hildir&apos;s Bronze Chest</Item>],
];

const SHIP_ROWS: React.ReactNode[][] = [
  [<Item key="a">Raft</Item>, '300', '0'],
  [<Item key="b">Karve</Item>, '500', '4'],
  [<Item key="c">Longship</Item>, '1000', '18'],
  [<Item key="d">Drakkar</Item>, '3000', '32'],
];

const TAME: ChecklistItem[] = [
  { id: 't-boar', label: <><Item>Boar</Item> (Meadows) — comida vegetal.</> },
  { id: 't-wolf', label: <><Item>Wolf</Item> (Mountain) — carne cruda.</> },
  { id: 't-lox', label: <><Item>Lox</Item> (Plains) — Barley / Cloudberry.</> },
  { id: 't-chicken', label: <><Item>Chicken</Item> — nace ya domesticada de un <Item>Egg</Item> de Haldor, 30 min junto al fuego.</> },
  { id: 't-asksvin', label: <><Item>Asksvin</Item> (Ashlands) — Smoke Puff / Vineberry Cluster / Fiddlehead; ensillable, cruza lava.</> },
];

const BIOMES: BiomeData[] = [
  {
    id: 'meadows',
    name: 'Meadows',
    tag: 'Bioma inicial',
    desc: 'Donde empieza toda partida. Bajo riesgo: acá aprendés a talar, cazar y construir tu primera base.',
    resources: [
      { id: 'm-wood', label: <><Item>Wood</Item> (cualquier árbol) y <Item>Fine Wood</Item> (Birch).</> },
      { id: 'm-food', label: <><Item>Raw Meat</Item> + <Item>Deer Hide</Item> (Deer), <Item>Leather Scraps</Item> (Boar), <Item>Raspberry</Item>, <Item>Dandelion</Item>, <Item>Mushroom</Item>.</> },
      { id: 'm-misc', label: <><Item>Stone</Item>, <Item>Flint</Item> (cerca del agua), <Item>Resin</Item>, <Item>Queen Bee</Item> (colmenas silvestres).</> },
    ],
    structures: [
      {
        id: 'm-house',
        label: <><Item>Abandoned House</Item> — cofres con el <Item>Curious Axe Head</Item> y el <Item>Mysterious Axe Head</Item>.</>,
        note: <>Con esas dos piezas + 4 Wood en un Workbench nivel 1 se craftean las <Item>Early Axes</Item>, agregadas recién en el parche 0.221.10 (feb 2026) — fácil de pasar por alto en guías viejas.</>,
      },
      { id: 'm-mound', label: 'Túmulos con forma de barco — se cavan con pico para sacar Coins.' },
    ],
    enemies: <><Item>Boar</Item>, <Item>Deer</Item> (cazables), <Item>Neck</Item>, <Item>Greyling</Item>, <Item>Seagull</Item>. Nada peligroso todavía.</>,
    crafting: <><Item>Workbench</Item>, herramientas de piedra/madera, armadura de <Item>Leather</Item>/<Item>Rag</Item>.</>,
    boss: {
      name: 'Eikthyr',
      rows: [
        { label: 'Invocación', value: <>2× <Item>Deer Trophy</Item> en el altar (Vegvisir garantizado en el spawn).</> },
        { label: 'Poder', value: '−60% costo de estamina al correr, saltar y nadar.' },
        { label: 'Drops', value: <><Item>Eikthyr Trophy</Item> ×1, <Item>Hard Antler</Item> ×3.</> },
      ],
    },
  },
  {
    id: 'blackforest',
    name: 'Black Forest',
    tag: 'Bronce',
    desc: 'Primer bioma con mazmorras de verdad, y el único lugar del juego con Cobre y Estaño.',
    resources: [
      { id: 'bf-ore', label: <><Item>Copper Ore</Item> (con Antler Pickaxe+) y <Item>Tin Ore</Item> (costero) — únicos del bioma.</> },
      { id: 'bf-wood', label: <><Item>Core Wood</Item>, <Item>Surtling Core</Item> (Burial Chambers o Surtlings) — imprescindible para el Forge.</> },
      { id: 'bf-food', label: <><Item>Blueberry</Item>, <Item>Thistle</Item>, <Item>Yellow Mushroom</Item>, semillas de zanahoria.</> },
    ],
    structures: [
      { id: 'bf-burial', label: <><Item>Burial Chambers</Item> — primera mazmorra instanciada, con Skeletons.</> },
      { id: 'bf-troll', label: <><Item>Troll Cave</Item> — una sala; Coins, Ruby, Amber Pearl, Amber.</> },
    ],
    enemies: <><Item>Greydwarf</Item>, <Item>Greydwarf Brute</Item>, <Item>Greydwarf Shaman</Item>, <Item>Skeleton</Item>, y el <Item>Troll</Item> (mucha vida).</>,
    crafting: <><Item>Forge</Item> + <Item>Smelter</Item> → gear de <strong className="text-birch">Bronce</strong>: <Item>Bronze Plate Cuirass</Item>, <Item>Bronze Helmet</Item>, <Item>Bronze Buckler</Item>, armas de bronce y el <Item>Bronze Pickaxe</Item>.</>,
    boss: {
      name: 'The Elder',
      rows: [
        { label: 'Invocación', value: <>3× <Item>Ancient Seed</Item> (rompiendo <Item>Greydwarf Nest</Item> o cazando Brutes).</> },
        { label: 'Poder', value: '+60% daño de hacha/pico, +30% regeneración de vida.' },
        { label: 'Drops', value: <><Item>The Elder Trophy</Item>, <Item>Swamp Key</Item> (reutilizable, abre los Sunken Crypts).</> },
      ],
    },
  },
  {
    id: 'swamp',
    name: 'Swamp',
    tag: 'Hierro',
    desc: 'Lluvia constante — estamina drenada todo el tiempo. Acá vive la Bog Witch.',
    resources: [
      { id: 'sw-iron', label: <><Item>Scrap Iron</Item> y <Item>Withered Bone</Item> — de los <Item>Muddy Scrap Pile</Item> dentro de los Sunken Crypts.</> },
      { id: 'sw-bark', label: <><Item>Ancient Bark</Item> (árboles antiguos), <Item>Guck</Item> (golpeando los sacos de los árboles).</> },
      { id: 'sw-root', label: <><Item>Root</Item> — drop raro del <Item>Abomination</Item>, para la armadura Root.</> },
    ],
    structures: [
      { id: 'sw-crypt', label: <><Item>Sunken Crypt</Item> — pide la <Item>Swamp Key</Item> de The Elder.</> },
      { id: 'sw-tower', label: 'Torres en ruina que generan Draugr sin parar.' },
    ],
    enemies: <><Item>Draugr</Item>, <Item>Draugr Elite</Item>, <Item>Blob</Item>/<Item>Oozer</Item> (veneno), <Item>Leech</Item>, <Item>Wraith</Item> (solo de noche), <Item>Abomination</Item>.</>,
    crafting: <>Gear de <strong className="text-birch">Hierro</strong>: <Item>Iron Helmet</Item>, <Item>Iron Scale Mail</Item>, <Item>Battleaxe</Item>. Alternativa anti-veneno: set <Item>Root Mask</Item>/<Item>Root Harnesk</Item>/<Item>Root Leggings</Item>.</>,
    boss: {
      name: 'Bonemass',
      rows: [
        { label: 'Invocación', value: <>10× <Item>Withered Bone</Item>.</> },
        { label: 'Poder', value: '−25% daño físico recibido, −100% costo de estamina al bloquear, +5 estamina por bloqueo.' },
        { label: 'Drops', value: <><Item>Bonemass Trophy</Item>, <Item>Wishbone</Item> (detector — pita cerca de Plata y tesoros).</> },
      ],
    },
  },
  {
    id: 'mountain',
    name: 'Mountain',
    tag: 'Plata',
    desc: 'Frío de verdad: sin resistencia perdés vida. Llevá Frost Resistance Mead o una capa de Wolf/Lox/Fenris.',
    resources: [
      { id: 'mt-silver', label: <><Item>Silver Ore</Item> — vetas escondidas, se ubican con el <Item>Wishbone</Item> de Bonemass.</> },
      { id: 'mt-obs', label: <><Item>Obsidian</Item> (Iron Pickaxe+), <Item>Crystal</Item> (paredes o drop de Stone Golem).</> },
      { id: 'mt-egg', label: <><Item>Dragon Egg</Item> — nidos de Drake. Pesa 200: no pasa por portal.</> },
    ],
    structures: [
      { id: 'mt-cave', label: <><Item>Frost Cave</Item> — Cultists y su Ulv; Crystal, <Item>Fenris Hair</Item>, <Item>Fenris Claw</Item>.</> },
    ],
    enemies: <><Item>Wolf</Item>, <Item>Fenring</Item> (jauría), <Item>Drake</Item>, <Item>Stone Golem</Item>, Cultist + Ulv (solo en Frost Cave).</>,
    crafting: <>Set <Item>Wolf armor</Item> — mayor defensa antes de Plains. Set <Item>Fenris</Item> (loot de Frost Cave) — +9% velocidad. <Item>Frostner</Item> y <Item>Silver Sword</Item>. Con Moder: <Item>Artisan Table</Item> → Spinning Wheel, Windmill, Stone Oven, Blast Furnace.</>,
    boss: {
      name: 'Moder',
      rows: [
        { label: 'Invocación', value: <>3× <Item>Dragon Egg</Item>, uno por cuenco.</> },
        { label: 'Poder', value: 'Viento de cola al navegar, +300 peso de carga, +10% velocidad, −50% daño de frío.' },
        { label: 'Drops', value: <><Item>Moder Trophy</Item>, 10× <Item>Dragon Tear</Item> (para el Artisan Table).</> },
      ],
    },
  },
  {
    id: 'plains',
    name: 'Plains',
    tag: 'Metal Negro',
    desc: 'Fulings por todos lados y el Deathsquito, capaz de matarte de un golpe.',
    resources: [
      { id: 'pl-flax', label: <><Item>Flax</Item> y <Item>Barley</Item> — en los campos de las aldeas Fuling.</> },
      { id: 'pl-tar', label: <><Item>Tar</Item> — de los <Item>Tar Pit</Item> y del monstruo <Item>Growth</Item> (usá flechas de fuego).</> },
      { id: 'pl-scrap', label: <><Item>Black Metal Scrap</Item> — drop de cualquier Fuling y cofres de aldea.</> },
    ],
    structures: [
      { id: 'pl-village', label: <><Item>Fuling Village</Item> — campos, hoguera con 50% de chance de <Item>Fuling Totem</Item>, cofres.</> },
    ],
    enemies: <><Item>Fuling</Item>, <Item>Fuling Archer</Item>, <Item>Fuling Berserker</Item> (puede dropear el raro <Item>Krom</Item>), <Item>Fuling Shaman</Item>, <Item>Lox</Item>, <Item>Deathsquito</Item>.</>,
    crafting: <><Item>Blast Furnace</Item> → única estación que funde Black Metal Scrap. Set <Item>Padded armor</Item> — mejor set pre-Mistlands. Armas de <strong className="text-birch">Black Metal</strong>: Atgeir, Sword, la maza <Item>Porcupine</Item>, las dagas <Item>Skoll and Hati</Item>.</>,
    boss: {
      name: 'Yagluth',
      rows: [
        { label: 'Invocación', value: <>5× <Item>Fuling Totem</Item>.</> },
        { label: 'Poder', value: '−50% daño de rayo, +25 en la skill Farming, +10% daño infligido.' },
        { label: 'Drops', value: <Item>Yagluth Trophy</Item> },
      ],
    },
  },
  {
    id: 'mistlands',
    name: 'Mistlands',
    tag: 'Eitr y magia',
    desc: 'Niebla permanente, casi sin visibilidad hasta que la resolvés. Acá entra la magia vía el Eitr.',
    resources: [
      { id: 'ml-marble', label: <><Item>Black Marble</Item> y <Item>Soft Tissue</Item> — de los <Item>Giant Remains</Item>, con Black Metal Pickaxe.</> },
      { id: 'ml-ygg', label: <><Item>Yggdrasil Wood</Item> y <Item>Sap</Item> (con un Sap Extractor sobre una Ancient Root).</> },
      { id: 'ml-core', label: <><Item>Black Core</Item> — en Infested Mine; hacen falta 15 por estación.</> },
      { id: 'ml-eitr', label: <><Item>Magecap</Item> — primer alimento que sube el Eitr máximo.</> },
    ],
    structures: [
      { id: 'ml-mine', label: <><Item>Infested Mine</Item> — la mazmorra más común: campamento Dvergr tomado por Seekers.</> },
      { id: 'ml-citadel', label: <><Item>Infested Citadel</Item> — la guarida de la Reina, tras una puerta que exige el <Item>Sealbreaker</Item>.</> },
      { id: 'ml-reto', label: <><Item>Tomb of Lord Reto</Item> — minijefe, dropea un fragmento de <Item>Dyrnwyn</Item>.</> },
    ],
    enemies: <><Item>Seeker</Item> (vuela), <Item>Seeker Soldier</Item> (punto débil en el abdomen), <Item>Gjall</Item> (aéreo, sus huevos eclosionan en Tick), Dvergr Rogue/Mage (neutrales hasta que los atacás).</>,
    crafting: <><Item>Black Forge</Item> → set <Item>Carapace</Item>. <Item>Galdr Table</Item> → set <Item>Eitr-weave</Item> + <Item>Feather Cape</Item>, bastones <Item>Staff of Embers</Item>/<Item>Staff of Frost</Item>/<Item>Staff of Protection</Item>, y <Item>Skoll and Hati</Item>. El <Item>Sealbreaker</Item> se craftea con 9× Sealbreaker Fragment.</>,
    callout: <>Ojo: el Metal Negro sigue fundiéndose con Black Metal Scrap de <strong>Plains</strong>, no de Mistlands — este bioma no tiene mineral nuevo propio, aporta Black Core como su recurso exclusivo de alto nivel.</>,
    boss: {
      name: 'The Queen',
      rows: [
        { label: 'Invocación', value: <>Sin ítem la 1ª vez — abrís el Citadel con el Sealbreaker. Para volver: 3× <Item>Seeker Soldier Trophy</Item> sobre el trono.</> },
        { label: 'Poder', value: '+100% regeneración de Eitr, −100% costo de estamina agachado, −50% daño de veneno.' },
        { label: 'Drops', value: <><Item>Queen&apos;s Trophy</Item>, 5× <Item>Majestic Carapace</Item> (Artisan Press → Ceramic Plate).</> },
      ],
    },
    extra: {
      label: 'No te lo pierdas',
      items: [
        { id: 'ml-x1', label: <>Buscar las 3 <Item>Mysterious Location</Item> (Vegvisir desde Putrid Holes de Ashlands) para los fragmentos de Dyrnwyn.</> },
      ],
    },
  },
  {
    id: 'ashlands',
    name: 'Ashlands',
    tag: 'Flametal · jefe final actual',
    desc: 'El bioma más hostil hoy: el mar hierve, la ceniza destruye estructuras, y hasta las criaturas se dañan entre sí.',
    resources: [
      { id: 'as-flame', label: <><Item>Flametal Ore</Item> — vetas (Black Metal Pickaxe+), cofres, o pescando un Magmafish. Se funde en Blast Furnace.</> },
      { id: 'as-soft', label: <><Item>Soft Tissue</Item> (drop de Morgen) → <Item>Refined Eitr</Item> en el Eitr Refinery.</> },
      { id: 'as-wood', label: <><Item>Ashwood</Item>, <Item>Grausten</Item> (con Stonecutter), <Item>Molten Core</Item>, <Item>Bell Fragment</Item>.</> },
    ],
    structures: [
      { id: 'as-fortress', label: <><Item>Charred Fortress</Item> (hasta 20 por mundo) — su torre central tiene Bell Fragments y hasta 10× Molten Core.</> },
      { id: 'as-hole', label: <><Item>Putrid Hole</Item> — mazmorra que además sirve de refugio.</> },
    ],
    enemies: <><Item>Charred Warrior</Item>, <Item>Charred Marksman</Item>, <Item>Charred Warlock</Item>, <Item>Morgen</Item>, <Item>Bonemaw</Item>, <Item>Asksvin</Item>, <Item>Volture</Item>, <Item>Lava Blob</Item>, <Item>Fallen Valkyrie</Item> (hostil) y el minijefe <Item>Lord Reto</Item>.</>,
    crafting: <>Black Forge mejorado (hasta nivel 5) → gear de <strong className="text-birch">Flametal</strong>: set <Item>Flametal Helmet/Breastplate/Greaves</Item> o <Item>Robes of Embla</Item>. Familias de armas con variantes elementales: <Item>Nidhögg</Item>, <Item>Ripper</Item>, <Item>Berserkir</Item>, <Item>Slayer</Item>. La espada legendaria <Item>Dyrnwyn</Item> se arma con sus 3 fragmentos.</>,
    callout: (
      <>
        El mar hierve: solo el <Item>Drakkar</Item> lo cruza sin daño; nadar ahí acumula calor y puede
        matarte a 50 de daño puro/seg. La lluvia de cenizas destruye madera — construí con
        Ashwood/Grausten/piedra y un <Item>Shield Generator</Item>.
      </>
    ),
    boss: {
      name: <>Fader (&ldquo;the Emerald Flame&rdquo;)</>,
      rows: [
        { label: 'Invocación', value: <>3× <Item>Bell</Item> (cada uno con 3× Bell Fragment, 9 en total) alrededor del coliseo.</> },
        { label: 'Poder', value: '+100% ganancia de Adrenalina, −50% acumulación de stagger, −50% daño de fuego.' },
        { label: 'Drops', value: <><Item>Fader Trophy</Item>, 5× <Item>Fader Relic</Item>.</> },
      ],
    },
  },
];

export function GuideContent() {
  return (
    <div className="flex flex-col gap-8 pb-10">
      <header>
        <p className="label mb-2">Guía de finalización · Early Access, hasta Ashlands</p>
        <h1 className="display text-2xl text-birch sm:text-3xl">Codex de Valheim</h1>
        <p className="answer mt-2 text-[0.95rem] text-ash">
          Checklist completa, bioma por bioma, para llegar al 100% del contenido actual del juego.
          Los nombres de objetos, criaturas y estructuras aparecen en <Item>inglés</Item>, tal como
          figuran en el juego.
        </p>

        <div className="mt-4 rounded-md border border-moss bg-peat px-4 py-3.5">
          <p className="label mb-1.5 text-forge">Antes de arrancar</p>
          <p className="answer text-[0.88rem]">
            <strong className="text-birch">Parche en vivo:</strong> 0.221.12 (19 feb 2026). Valheim
            sigue en Acceso Anticipado. <strong className="text-birch">La versión 1.0 llega el 9 de
            septiembre de 2026</strong> con el bioma final <Item>Deep North</Item>, logros oficiales
            de Steam y probablemente un 8º jefe — todavía no salió a la fecha de esta guía. El juego
            hoy no tiene logros ni contador de &quot;% completado&quot; propio: el 100% de acá es una
            definición de la comunidad. Convendrá revisar esta guía otra vez después del 1.0.
          </p>
        </div>
      </header>

      <section>
        <GuideH2 id="criterios">Qué significa &quot;100%&quot; acá</GuideH2>
        <p className="answer mt-1 mb-2 text-[0.92rem] text-ash">
          Doce puntos generales — cada uno se desglosa después, bioma por bioma.
        </p>
        <GuideChecklist items={CRITERIA} />
        <p className="rounded-md border border-moss bg-peat px-3 py-2.5 text-[0.85rem] leading-snug text-ash">
          <strong className="text-birch">Un mito para descartar:</strong> no existe un jefe secreto
          estacional permanente. <Item>The Hare</Item> es una criatura pasiva de Mistlands (10 de
          vida, no domesticable) que se caza para cocinar, no un encuentro de combate.
        </p>
      </section>

      <section>
        <GuideH2 id="mecanicas">Mecánicas que vas a usar todo el juego</GuideH2>

        <GuideH3>Vegvisir y altares</GuideH3>
        <p className="answer text-[0.92rem]">
          Cada jefe tiene un Altar del Olvidado (Forsaken Altar). Un <Item>Vegvisir</Item> revela la
          ubicación del altar más cercano sin descubrir — pero no es obligatorio: tropezar con el
          altar alcanza igual.
        </p>
        <GuideTable
          caption="Dónde suele aparecer cada Vegvisir"
          headers={['Jefe', 'Ubicación']}
          rows={VEGVISIR_ROWS}
        />

        <GuideH3>Poderes Ancestrales (Forsaken Powers)</GuideH3>
        <p className="answer text-[0.92rem]">
          Al colgar el trofeo de un jefe en tu <Item>Sacrificial Stones</Item> activás su poder para
          el resto de la partida: dura <strong className="text-birch">5 minutos</strong> con{' '}
          <strong className="text-birch">20 de reutilización</strong>, compartidos entre todos los
          poderes — no se resetea al dormir ni al desconectarte. Tabla completa en la{' '}
          <a href="#checklist-maestra" className="text-forge hover:underline">
            checklist maestra
          </a>
          .
        </p>

        <GuideH3>Qué NO podés teletransportar</GuideH3>
        <p className="answer text-[0.92rem]">
          Los portales bloquean el mineral crudo y sus versiones fundidas: {PORTAL_BLOCKED.map((n, i) => (
            <span key={n}>
              <Item>{n}</Item>
              {i < PORTAL_BLOCKED.length - 1 ? ', ' : '.'}
            </span>
          ))}{' '}
          Lo ya crafteado con esos materiales sí pasa.
        </p>
        <p className="mt-2 rounded-md border border-moss bg-peat px-3 py-2.5 text-[0.85rem] leading-snug text-ash">
          <strong className="text-birch">Excepción real:</strong> la estructura{' '}
          <Item>Portal Stone</Item> (Ashlands) sí permite teletransportar todo eso, mineral incluido.
        </p>

        <GuideH3>Progresión de estaciones de crafteo</GuideH3>
        <div className="answer text-[0.92rem]">
          <ul>
            <li>
              <Item>Workbench</Item> → con <Item>Hard Antler</Item> (drop de Eikthyr) craftea el{' '}
              <Item>Antler Pickaxe</Item>, necesario para minar en Black Forest.
            </li>
            <li>
              <Item>Forge</Item> (pide <Item>Surtling Core</Item>) + <Item>Smelter</Item> → Bronce,
              luego Hierro (Swamp) y Plata (Mountain).
            </li>
            <li>
              <Item>Artisan Table</Item> (10× <Item>Dragon Tear</Item>, drop de Moder) → habilita
              Blast Furnace, Spinning Wheel, Windmill, Stone Oven.
            </li>
            <li>
              <Item>Blast Furnace</Item> → única estación que funde <Item>Black Metal Scrap</Item>{' '}
              (Plains) y luego <Item>Flametal ore</Item> (Ashlands).
            </li>
            <li>
              <Item>Black Forge</Item> y <Item>Galdr Table</Item> (Mistlands) → gear física y mágica
              de Mistlands/Ashlands, mejorables hasta nivel 5.
            </li>
          </ul>
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <GuideH2 id="biomas">Los siete biomas, en orden</GuideH2>
        {BIOMES.map((biome, i) => (
          <BiomeChapter key={biome.id} index={i + 1} biome={biome} />
        ))}
      </section>

      <section>
        <GuideH2 id="mercaderes">Los tres mercaderes</GuideH2>
        <p className="answer mt-1 mb-2 text-[0.92rem] text-ash">
          Ninguno es obligatorio para avanzar, pero completarlos a los tres es parte del 100%.
        </p>

        <GuideH3>Haldor — Black Forest</GuideH3>
        <p className="answer text-[0.92rem]">
          Aparece una sola vez por mundo, siempre en Black Forest, a menos de ~1500m del centro.
        </p>
        <GuideTable caption="Inventario de Haldor" headers={['Ítem', 'Precio', 'Condición']} rows={HALDOR_ROWS} />
        <p className="text-[0.85rem] text-ash">
          Te compra <Item>Amber</Item>, <Item>Amber Pearl</Item>, <Item>Ruby</Item> y{' '}
          <Item>Silver Necklace</Item>.
        </p>

        <GuideH3>La Bog Witch — Swamp</GuideH3>
        <div className="answer text-[0.92rem]">
          <p>
            No pide ningún jefe para encontrarla: cabaña costera entre 3000–8000m del centro,
            marcada con un ícono de caldero. Trae tres novedades:
          </p>
          <ul>
            <li>
              <strong className="text-birch">Feasts:</strong> comidas grandes para compartir en
              grupo. Necesitás la <Item>Food Preparation Table</Item> y la{' '}
              <Item>Serving Tray</Item> que ella vende (140 Coins). Cada Feast se come varias veces
              y el buff dura 50 minutos — 8 recetas, una por bioma más una náutica.
            </li>
            <li>
              <strong className="text-birch">3 skills nuevas:</strong> <Item>Cooking</Item>,{' '}
              <Item>Farming</Item> y <Item>Crafting</Item> — suben con el uso.
            </li>
            <li>
              <strong className="text-birch">8 pociones:</strong> <Item>Berserkir Mead</Item>,{' '}
              <Item>Tonic of Ratatosk</Item>, <Item>Lightfoot Mead</Item>,{' '}
              <Item>Draught of Vananidir</Item>, <Item>Mead of Troll Endurance</Item>,{' '}
              <Item>Brew of Animal Whispers</Item>, <Item>Anti-Sting Concoction</Item>,{' '}
              <Item>Love Potion</Item>.
            </li>
          </ul>
        </div>
        <p className="text-[0.85rem] text-ash">
          Su inventario base se amplía después de cada jefe que derrotás — el precio exacto de cada
          desbloqueo varía según la fuente, confirmalo en el juego antes de planear una compra
          grande.
        </p>
      </section>

      <section>
        <GuideH2 id="hildir">Hildir&apos;s Request</GuideH2>
        <p className="answer mt-1 text-[0.92rem]">
          Tres mazmorras cortas repartidas en tres biomas, cada una con su minijefe. Empieza en el
          campamento de <Item>Hildir</Item> en Meadows (3000–5100m del centro): interactuá con la
          mesa-mapa frente a su carpa y se marcan las tres en tu mapa.
        </p>
        <GuideTable
          caption="Las tres mazmorras"
          headers={['Mazmorra', 'Bioma', 'Minijefe(s)', 'Recompensa']}
          rows={HILDIR_ROWS}
        />
        <p className="rounded-md border border-moss bg-peat px-3 py-2.5 text-[0.85rem] leading-snug text-ash">
          Cada cofre pesa 200 y <strong className="text-birch">no pasa por portal</strong>. Entregarlo
          desbloquea ropa cosmética y activa una <strong className="text-birch">invasión
          recurrente</strong> de ese minijefe sobre tu base.
        </p>
        <GuideChecklist
          items={[
            {
              id: 'h-barber',
              label: (
                <>
                  Comprar el <Item>Barber Kit</Item> (600 Coins) y construir la{' '}
                  <Item>Barber Station</Item> — 8 peinados y 5 barbas nuevas.
                </>
              ),
            },
          ]}
        />
      </section>

      <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <GuideH2>Barcos</GuideH2>
          <GuideTable caption="4 niveles (Workbench)" headers={['Barco', 'HP', 'Cargo']} rows={SHIP_ROWS} />
          <p className="text-[0.85rem] text-ash">
            El <Item>Drakkar</Item> es el único que cruza el mar hirviente de Ashlands sin daño.
          </p>
        </div>
        <div>
          <GuideH2>Domesticación</GuideH2>
          <p className="answer mb-1 text-[0.85rem] text-ash">5 especies domesticables.</p>
          <GuideChecklist items={TAME} />
        </div>
      </section>

      <section id="checklist-maestra">
        <GuideH2>Checklist maestra de jefes</GuideH2>
        <GuideTable
          caption="Los 7 jefes actuales, en orden"
          headers={['#', 'Jefe', 'Bioma', 'Invocación', 'Poder Ancestral']}
          rows={BOSS_TABLE_ROWS}
        />
        <p className="text-[0.85rem] text-ash">Todos los poderes duran 5 minutos con 20 de reutilización compartidos.</p>
      </section>

      <section id="deep-north" className="rounded-md border border-dashed border-lichen bg-peat/60 px-4 py-4">
        <p className="font-mono text-[0.68rem] tracking-wider text-ash uppercase">
          Todavía no disponible
        </p>
        <h2 className="display mt-1 text-base text-birch">Qué sigue: Deep North</h2>
        <p className="answer mt-1.5 text-[0.9rem] text-ash">
          El 8º y último bioma confirmado, con el jefe final del juego, criaturas nuevas (
          <Item>Gammeltroll</Item>, <Item>Elakingar</Item>) y zonas subterráneas. Llega con la{' '}
          <strong className="text-birch">versión 1.0</strong>, fijada para el{' '}
          <strong className="text-birch">9 de septiembre de 2026</strong>, cuando el juego también
          sale de Acceso Anticipado y estrena logros oficiales de Steam. No está en la checklist de
          arriba porque, a la fecha de esta guía, todavía no es jugable.
        </p>
      </section>

      <footer className="border-t border-moss pt-4 text-[0.8rem] text-ash">
        Investigación cruzada entre la wiki de Valheim, notas de parche oficiales de Iron Gate y
        guías secundarias verificadas, con fecha del 21 de agosto de 2026. Donde un dato no pudo
        confirmarse contra una segunda fuente, se dejó afuera en vez de arriesgar un error — si algo
        de acá no coincide con lo que ves en el juego, confiá en el juego.
      </footer>
    </div>
  );
}
