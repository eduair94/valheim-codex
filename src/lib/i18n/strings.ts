import { BROWSE_COPY } from './browse-copy';
import { ARTICLE_COPY } from './copy/article';
import { AUTH_COPY } from './copy/auth';
import { CHAT_COPY } from './copy/chat';
import { CRAFT_COPY } from './copy/craft';
import { GUIDE_COPY } from './copy/guide';
import { SEARCH_COPY } from './copy/search';
import { SHELL_COPY } from './copy/shell';
import { WIKI_COPY } from './copy/wiki';

export type Lang = 'es' | 'en';

/*
 * Formatting helpers once defined here, for the Server Components that still
 * import them from this module. Code that runs in the browser imports them
 * from `./format`.
 */
export { relativeTime, rune } from './format';

/**
 * UI copy, written from the reader's side of the screen.
 *
 * Actions are named for what they do and keep the same word through the whole
 * flow, so the control that says "Actualizar índice" produces a message about
 * the index being updated. Errors say what happened and what to do next; they
 * do not apologise.
 *
 * This is the shared base table. Each area of the app keeps its own copy in
 * `./copy/*`, merged over this one below, so an area can add or reword its
 * strings without everyone editing one file.
 *
 * Server Components read it with `strings(lang)`. Nothing that runs in the
 * browser may import a value from this module or from `./copy/*` (types are
 * fine): the table is about 38 KB in both languages, and every client chunk
 * that imported it carried a copy. Client Components read the language's
 * table from `LangProvider` with `useStrings` (`components/shell/lang-context`),
 * which the root layout fills once per page. `tests/unit/client-copy-guard.test.ts`
 * enforces this.
 */
const BASE = {
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
    // The name only labels a history; anyone with the password can type it, so say so here.
    loginProfileHint:
      'Separa tu historial del de tus compañeros de partida. No es secreto: quien tenga la contraseña y escriba este nombre ve ese historial y puede borrarlo.',
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
    wikiHowToGet: 'ver de dónde se saca',
    wikiRecipe: 'Receta',
    wikiSourceLink: 'Ver en la wiki original',
    // The browsing axes' names and the guide card's are in `./browse-copy`.
    wikiOrBrowse: 'O empezá por acá',
    wikiCompare: 'Comparar',
    wikiList: 'Lista',
    wikiAskAbout: 'Preguntar sobre esto',
    wikiBack: 'Volver',
    wikiOffline: 'Sin conexión. Estás viendo una copia guardada; el chat no está disponible.',
    wikiNotFound: 'Ese artículo no está en el índice.',
    wikiNothingHere: 'No hay artículos con ese filtro.',

    installBanner: 'Instalá Codex de Valheim en tu pantalla de inicio: abre más rápido y funciona sin conexión.',
    installIosBanner: 'Instalá esta app: tocá Compartir y elegí «Agregar a inicio».',
    installAction: 'Instalar',
    installDismiss: 'Cerrar',
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
    loginProfileHint:
      'Keeps your history separate from your crew’s. It isn’t a secret: anyone with the password who types this name sees that history and can delete it.',
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
    wikiHowToGet: 'see where to get it',
    wikiRecipe: 'Recipe',
    wikiSourceLink: 'View on the original wiki',
    wikiOrBrowse: 'Or start here',
    wikiCompare: 'Compare',
    wikiList: 'List',
    wikiAskAbout: 'Ask about this',
    wikiBack: 'Back',
    wikiOffline: 'Offline. You are seeing a saved copy; the chat is unavailable.',
    wikiNotFound: 'That article is not in the index.',
    wikiNothingHere: 'No articles match this filter.',

    installBanner: 'Install Valheim Codex on your home screen: it opens faster and works offline.',
    installIosBanner: 'Install this app: tap Share and choose “Add to Home Screen”.',
    installAction: 'Install',
    installDismiss: 'Dismiss',
  },
} as const;

export const STRINGS = {
  es: {
    ...BASE.es,
    ...SHELL_COPY.es,
    ...SEARCH_COPY.es,
    ...WIKI_COPY.es,
    ...BROWSE_COPY.es,
    ...ARTICLE_COPY.es,
    ...GUIDE_COPY.es,
    ...CRAFT_COPY.es,
    ...CHAT_COPY.es,
    ...AUTH_COPY.es,
  },
  en: {
    ...BASE.en,
    ...SHELL_COPY.en,
    ...SEARCH_COPY.en,
    ...WIKI_COPY.en,
    ...BROWSE_COPY.en,
    ...ARTICLE_COPY.en,
    ...GUIDE_COPY.en,
    ...CRAFT_COPY.en,
    ...CHAT_COPY.en,
    ...AUTH_COPY.en,
  },
} as const;

/**
 * One language's table. Plain strings and lists of strings only: the root
 * layout hands it to `LangProvider`, so it travels to the browser in the
 * page's RSC payload, and anything that does not serialize would break that
 * (`tests/unit/strings.test.ts` checks).
 */
export type Strings = (typeof STRINGS)[Lang];

export function strings(lang: Lang): Strings {
  return STRINGS[lang];
}
