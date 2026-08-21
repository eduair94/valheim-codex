export type Lang = 'es' | 'en';

/**
 * UI copy, written from the reader's side of the screen.
 *
 * Actions are named for what they do and keep the same word through the whole
 * flow, so the control that says "Actualizar índice" produces a message about
 * the index being updated. Errors say what happened and what to do next; they
 * do not apologise.
 */
export const STRINGS = {
  es: {
    appName: 'Valheim Codex',
    tagline: 'Respuestas de la wiki, con la fuente a la vista',

    newChat: 'Nueva consulta',
    conversations: 'Consultas',
    noConversations: 'Todavía no hay consultas.',
    deleteChat: 'Borrar consulta',
    deleteConfirm: '¿Borrar esta consulta? No se puede deshacer.',

    composerPlaceholder: 'Preguntá sobre Valheim…',
    send: 'Preguntar',
    stop: 'Detener',

    emptyTitle: 'Preguntá lo que necesites saber de Valheim.',
    emptyBody: 'Cada respuesta sale de la wiki y trae el enlace al artículo del que salió.',
    examples: [
      '¿Qué necesito para forjar una espada de hierro?',
      '¿Cómo invoco a Bonemass?',
      '¿Dónde encuentro núcleos de surtling?',
    ],

    sources: 'Fuentes',
    openArticle: 'Abrir artículo',

    thinking: 'Interpretando la pregunta',
    searching: 'Buscando en la wiki',
    answering: 'Redactando',

    language: 'Idioma',
    index: 'Índice',
    pages: 'páginas',
    chunks: 'fragmentos',
    lastIndexed: 'Actualizado',
    never: 'nunca',
    reindex: 'Actualizar índice',
    reindexing: 'Actualizando…',
    reindexQueued: 'Actualización lanzada. Tarda unos minutos.',
    reindexUnavailable:
      'La actualización desde la app no está configurada. Corré `pnpm ingest` en tu máquina.',
    logout: 'Salir',
    profile: 'Perfil',

    errorGeneric: 'Algo falló. Probá de nuevo.',
    errorRateLimited:
      'Los modelos están al límite ahora mismo. Esperá unos minutos y volvé a preguntar — la wiki se puede consultar igual.',
    errorNetwork: 'No hay conexión con el servidor. Revisá tu red y volvé a intentar.',
    retry: 'Reintentar',

    loginTitle: 'Valheim Codex',
    loginSubtitle: 'Esta consulta es privada. Entrá con la contraseña.',
    loginPassword: 'Contraseña',
    loginProfile: 'Tu nombre',
    loginProfileHint: 'Separa tu historial del de tus compañeros de partida.',
    loginSubmit: 'Entrar',
    loginPending: 'Entrando…',
    loginBadCredentials: 'Contraseña incorrecta.',
    loginBadProfile: 'Usá letras, números, espacios, guiones o puntos.',
    loginRateLimited: 'Demasiados intentos. Esperá unos minutos.',
    loginMisconfigured: 'Falta configurar APP_PASSWORD_HASH y SESSION_SECRET en el servidor.',

    // Wiki
    wiki: 'Wiki',
    wikiSearch: 'Buscar',
    wikiBrowse: 'Explorar',
    wikiChat: 'Chat',
    wikiChatLocked: 'Requiere contraseña',
    wikiSearchPlaceholder: 'Buscá un objeto, criatura o bioma…',
    wikiSearchEmpty: 'Escribí para buscar entre {n} artículos.',
    wikiNoResults: 'Sin resultados. Probá con el nombre en inglés.',
    wikiInContent: 'Encontrado dentro del texto',
    wikiLevel: 'Nivel',
    wikiLevels: 'Niveles de mejora',
    wikiLevelsHint: 'Cada nivel es la misma pieza mejorada en su estación de crafteo: cambian sus stats y lo que cuesta subirla.',
    wikiTranslating: 'Traduciendo este artículo…',
    wikiTranslationUnavailable: 'Todavía no hay traducción de este artículo.',
    wikiTranslated: 'Traducción automática',
    wikiTranslationStale: 'el artículo cambió desde que se tradujo',
    wikiShowOriginal: 'Ver en inglés',
    wikiStation: 'Estación',
    wikiGallery: 'Imágenes',
    wikiOpenImage: 'Ver imagen completa',
    wikiSourceLink: 'Ver en la wiki original',
    wikiCategories: 'Categorías',
    wikiBiomes: 'Biomas',
    wikiBiomesHint: 'En el orden en que el juego te los va abriendo.',
    wikiStations: 'Estaciones de crafteo',
    wikiSeeAll: 'Ver todo',
    wikiOrBrowse: 'O empezá por acá',
    wikiArticles: 'artículos',
    wikiCompare: 'Comparar',
    wikiItem: 'Objeto',
    wikiList: 'Lista',
    wikiAskAbout: 'Preguntar sobre esto',
    wikiBack: 'Volver',
    wikiOffline: 'Sin conexión. Estás viendo una copia guardada; el chat no está disponible.',
    wikiNotFound: 'Ese artículo no está en el índice.',
    wikiNothingHere: 'No hay artículos con ese filtro.',
  },
  en: {
    appName: 'Valheim Codex',
    tagline: 'Wiki answers, with the source in view',

    newChat: 'New question',
    conversations: 'Questions',
    noConversations: 'No questions yet.',
    deleteChat: 'Delete question',
    deleteConfirm: 'Delete this thread? This cannot be undone.',

    composerPlaceholder: 'Ask about Valheim…',
    send: 'Ask',
    stop: 'Stop',

    emptyTitle: 'Ask anything about Valheim.',
    emptyBody: 'Every answer comes from the wiki and links back to the article it came from.',
    examples: [
      'What do I need to forge an iron sword?',
      'How do I summon Bonemass?',
      'Where do I find surtling cores?',
    ],

    sources: 'Sources',
    openArticle: 'Open article',

    thinking: 'Reading the question',
    searching: 'Searching the wiki',
    answering: 'Writing',

    language: 'Language',
    index: 'Index',
    pages: 'pages',
    chunks: 'chunks',
    lastIndexed: 'Updated',
    never: 'never',
    reindex: 'Update index',
    reindexing: 'Updating…',
    reindexQueued: 'Update started. It takes a few minutes.',
    reindexUnavailable: 'Updating from the app is not configured. Run `pnpm ingest` locally.',
    logout: 'Sign out',
    profile: 'Profile',

    errorGeneric: 'Something broke. Try again.',
    errorRateLimited:
      'Every model is at its limit right now. Wait a few minutes and ask again — the wiki still works.',
    errorNetwork: 'No connection to the server. Check your network and retry.',
    retry: 'Retry',

    loginTitle: 'Valheim Codex',
    loginSubtitle: 'This codex is private. Enter the password.',
    loginPassword: 'Password',
    loginProfile: 'Your name',
    loginProfileHint: 'Keeps your history separate from your crew’s.',
    loginSubmit: 'Enter',
    loginPending: 'Entering…',
    loginBadCredentials: 'Wrong password.',
    loginBadProfile: 'Use letters, numbers, spaces, hyphens or dots.',
    loginRateLimited: 'Too many attempts. Wait a few minutes.',
    loginMisconfigured: 'The server is missing APP_PASSWORD_HASH and SESSION_SECRET.',

    // Wiki
    wiki: 'Wiki',
    wikiSearch: 'Search',
    wikiBrowse: 'Browse',
    wikiChat: 'Chat',
    wikiChatLocked: 'Requires a password',
    wikiSearchPlaceholder: 'Find an item, creature or biome…',
    wikiSearchEmpty: 'Type to search {n} articles.',
    wikiNoResults: 'No results.',
    wikiInContent: 'Found in the text',
    wikiLevel: 'Level',
    wikiLevels: 'Upgrade levels',
    wikiLevelsHint: 'Each level is the same piece upgraded at its crafting station: its stats and the cost of the next step change.',
    wikiTranslating: 'Translating this article…',
    wikiTranslationUnavailable: 'No translation of this article yet.',
    wikiTranslated: 'Machine translation',
    wikiTranslationStale: 'the article changed since it was translated',
    wikiShowOriginal: 'View in English',
    wikiStation: 'Station',
    wikiGallery: 'Images',
    wikiOpenImage: 'View full image',
    wikiSourceLink: 'View on the original wiki',
    wikiCategories: 'Categories',
    wikiBiomes: 'Biomes',
    wikiBiomesHint: 'In the order the game opens them up to you.',
    wikiStations: 'Crafting stations',
    wikiSeeAll: 'See all',
    wikiOrBrowse: 'Or start here',
    wikiArticles: 'articles',
    wikiCompare: 'Compare',
    wikiItem: 'Item',
    wikiList: 'List',
    wikiAskAbout: 'Ask about this',
    wikiBack: 'Back',
    wikiOffline: 'Offline. You are seeing a saved copy; the chat is unavailable.',
    wikiNotFound: 'That article is not in the index.',
    wikiNothingHere: 'No articles match this filter.',
  },
} as const;

export type Strings = (typeof STRINGS)[Lang];

export function strings(lang: Lang): Strings {
  return STRINGS[lang];
}

/**
 * Elder Futhark ordinals for the source list.
 *
 * Valheim delivers its lore on runestones, and the sources are this app's
 * lore. The rune is decoration with a job: it marks source order at a glance
 * while the numeral stays present for anyone matching a marker in the text.
 */
const FUTHARK = ['ᚠ', 'ᚢ', 'ᚦ', 'ᚨ', 'ᚱ', 'ᚲ', 'ᚷ', 'ᚹ', 'ᚺ', 'ᚾ', 'ᛁ', 'ᛃ'] as const;

export function rune(n: number): string {
  return FUTHARK[(n - 1) % FUTHARK.length] ?? 'ᚠ';
}

/** "hace 3 h" / "3 h ago" — short, and never a bare timestamp. */
export function relativeTime(iso: string | null, lang: Lang): string {
  if (!iso) return STRINGS[lang].never;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return STRINGS[lang].never;

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  let value = seconds;
  for (const [unit, step] of units) {
    if (value < step) {
      return new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' }).format(
        -Math.round(value),
        unit,
      );
    }
    value /= step;
  }
  return STRINGS[lang].never;
}
