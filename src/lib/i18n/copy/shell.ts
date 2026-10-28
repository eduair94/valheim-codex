/**
 * Copy for the wiki shell: nav, tab bar, language toggle, banners, 404 pages.
 *
 * Merged into `STRINGS` by `../strings.ts`. Keys added here override a base
 * key of the same name, so an area can reword its own existing copy without
 * touching the base table. Both languages must carry the same keys; the unit
 * test in `tests/unit/strings.test.ts` fails the build otherwise.
 */
export const SHELL_COPY = {
  es: {
    // The brand is "Valheim Codex" everywhere else, including the installed
    // app's own name; the banner had it backwards.
    installBanner: 'Instalá Valheim Codex en tu pantalla de inicio: abre más rápido y funciona sin conexión.',

    shellMetaDescription: 'Preguntas sobre Valheim respondidas desde la wiki, con la fuente a la vista.',
    // The installed app's manifest, which the browser fetches without cookies:
    // only the Spanish ones are ever shown.
    shellAppDescription: 'Wiki de Valheim y asistente, para consultar a mitad de partida.',
    shellShortcutSearch: 'Buscar un objeto, criatura o bioma',
    shellShortcutCraft: 'Tu lista de fabricación y lo que te falta juntar',
    shellShortcutGuide: 'Checklist de finalización, bioma por bioma',
    shellShortcutBrowse: 'Biomas, categorías y estaciones',
    shellSkipToContent: 'Saltar al contenido',
    shellHome: 'Valheim Codex, inicio de la wiki',
    // The planner's tab. Short on purpose: five tabs share a 360px phone.
    shellCraft: 'Taller',
    // Read after the tab's name by a screen reader, in place of the count it
    // shows: "Taller, 3 en tu taller".
    shellCraftCount: '{n} en tu taller',
    shellGuide: 'Guía',
    shellChatNeedsSignIn: 'hay que iniciar sesión',
    shellSearchLabel: 'Buscar en la wiki',
    shellSearchPlaceholder: 'Buscar en la wiki…',
    // Endonyms: each language is named in itself, so someone who cannot read
    // the current one still finds theirs.
    shellLanguageEs: 'Español',
    shellLanguageEn: 'English',

    shellDegraded: 'El servidor no está respondiendo. Lo que ya abriste se puede leer; el chat no está disponible por ahora.',
    shellOfflineMissed: 'Esa página no está guardada en este dispositivo. Sin conexión solo se pueden leer las que ya abriste.',
    shellOnlineAgain: 'Volvió la conexión.',
    shellOpenMissed: 'Abrir la página',

    shellNotFoundLabel: 'Error 404',
    shellNotFoundTitle: 'Esta página no existe',
    shellNotFoundBody: 'Puede que el artículo haya cambiado de nombre o que la dirección tenga un error. Buscalo por su nombre:',
    shellNotFoundElsewhere: 'O seguí por acá',

    shellErrorLabel: 'Error',
    shellErrorTitle: 'Algo falló al abrir esta página',
    shellErrorBody: 'Puede ser algo pasajero. Probá de nuevo; si sigue fallando, volvé a la búsqueda.',
    shellErrorHome: 'Ir a la búsqueda',
    shellErrorReference: 'Referencia',
  },
  en: {
    installBanner: 'Install Valheim Codex on your home screen: it opens faster and works offline.',

    shellMetaDescription: 'Valheim questions answered from the wiki, with the source in view.',
    shellAppDescription: 'A Valheim wiki and assistant, for looking things up mid-game.',
    shellShortcutSearch: 'Find an item, creature or biome',
    shellShortcutCraft: 'Your crafting list and what is left to gather',
    shellShortcutGuide: 'Completion checklist, biome by biome',
    shellShortcutBrowse: 'Biomes, categories and stations',
    shellSkipToContent: 'Skip to content',
    shellHome: 'Valheim Codex, wiki home',
    shellCraft: 'Craft',
    shellCraftCount: '{n} in your list',
    shellGuide: 'Guide',
    shellChatNeedsSignIn: 'requires signing in',
    shellSearchLabel: 'Search the wiki',
    shellSearchPlaceholder: 'Search the wiki…',
    shellLanguageEs: 'Español',
    shellLanguageEn: 'English',

    shellDegraded: 'The server is not responding. Pages you have opened still work; the chat is unavailable for now.',
    shellOfflineMissed: 'That page is not saved on this device. Offline, only pages you have already opened can be read.',
    shellOnlineAgain: 'You are back online.',
    shellOpenMissed: 'Open the page',

    shellNotFoundLabel: 'Error 404',
    shellNotFoundTitle: 'This page does not exist',
    shellNotFoundBody: 'The article may have been renamed, or the address has a typo. Search for it by name:',
    shellNotFoundElsewhere: 'Or go here',

    shellErrorLabel: 'Error',
    shellErrorTitle: 'Something broke while opening this page',
    shellErrorBody: 'It may be temporary. Try again; if it keeps failing, go back to search.',
    shellErrorHome: 'Go to search',
    shellErrorReference: 'Reference',
  },
} as const;
