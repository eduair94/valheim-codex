/**
 * Copy for the article page: identity strip, infobox, prose, tables, gallery, ask button, translation notices.
 *
 * Merged into `STRINGS` by `../strings.ts`. Keys added here override a base
 * key of the same name, so an area can reword its own existing copy without
 * touching the base table. Both languages must carry the same keys; the unit
 * test in `tests/unit/strings.test.ts` fails the build otherwise.
 *
 * The base keys the article already used (`wikiLevel`, `wikiLevels`,
 * `wikiGallery`, `wikiSourceLink`, `wikiAskAbout`…) keep their meaning and
 * stay in the base table; only what is new or reworded lives here.
 */
export const ARTICLE_COPY = {
  es: {
    articleBreadcrumb: 'Ruta de navegación',
    articleInfobox: 'Ficha',
    articleCategories: 'Categorías del artículo',

    // Infobox tabs. Only an item's numbered tabs are upgrade levels; a
    // creature's tabs are its star levels and its trophy, and anything else
    // is a variant ("Crudo / Cocinado"), which has no crafting station.
    articleStars: 'Estrellas',
    articleStarsHint: 'Las criaturas con estrellas son más fuertes y sueltan más botín.',
    articleStarOne: '{n} estrella',
    articleStarMany: '{n} estrellas',
    articleVariants: 'Variantes',

    articleTable: 'Tabla',
    articleNoticeUnfinished: 'Sin terminar',
    articleNoticeRemoved: 'Eliminado del juego',
    articleNoticeDlc: 'Contenido descargable',
    articleNoticeUpcoming: 'Próximamente',
    articleNoticeOther: 'Aviso de la wiki',

    articleImage: 'Imagen {n}',
    articleSourceNewTab: 'se abre en otra pestaña',
    articleAskInFlow: 'Preguntarle al chat sobre {name}',

    articleTranslatedPartial: 'traducción parcial: algunas partes siguen en inglés',
    articleUntranslated: 'Todavía no hay traducción de este artículo: se muestra en inglés.',
    articleTranslationProgress: 'Traduciendo este artículo… {done} de {total} textos listos.',
    articleTranslationQueued: 'La traducción sigue en curso. Volvé a abrir el artículo en unos minutos.',
    articleTranslationReady: 'Traducción lista. Cargando…',
    articleTranslationStored: 'La traducción ya está guardada: vas a verla al volver a abrir el artículo dentro de un rato.',
    articleTranslationCurrent: 'No hay nada nuevo para traducir por ahora.',
    articleTranslationLimited: 'Se agotó el cupo de traducciones por ahora. Probá de nuevo en {wait}.',
    articleTranslationLimitedLater: 'Se agotó el cupo de traducciones por ahora. Probá de nuevo más tarde.',
    articleTranslationDisabled: 'La traducción automática no está disponible ahora.',
    articleTranslationFailed: 'No se pudo traducir ahora. Probá de nuevo más tarde.',
    articleTranslationOffline: 'Sin conexión: no se pudo pedir la traducción.',
    articleTranslationUpdate: 'Actualizar la traducción',
    articleTranslationComplete: 'Completar la traducción',
    articleWaitMinutes: '{n} min',
    articleWaitHours: '{n} h',

    articleLoading: 'Cargando el artículo…',
    articleMetaDescription: '{title}: datos, recetas y notas de la wiki de Valheim.',

    // The image viewer's own controls, which otherwise speak English.
    articleViewer: 'Visor de imágenes',
    articleViewerGallery: 'Galería',
    articleViewerSlide: 'Imagen',
    articleViewerPosition: '{index} de {total}',
    articleViewerPrevious: 'Anterior',
    articleViewerNext: 'Siguiente',
    articleViewerClose: 'Cerrar',
    articleViewerZoomIn: 'Acercar',
    articleViewerZoomOut: 'Alejar',
    articleViewerCaption: 'Descripción',
  },
  en: {
    articleBreadcrumb: 'Breadcrumb',
    articleInfobox: 'Quick facts',
    articleCategories: 'Article categories',

    articleStars: 'Star levels',
    articleStarsHint: 'Starred creatures are stronger and drop more loot.',
    articleStarOne: '{n} star',
    articleStarMany: '{n} stars',
    articleVariants: 'Variants',

    articleTable: 'Table',
    articleNoticeUnfinished: 'Unfinished',
    articleNoticeRemoved: 'Removed from the game',
    articleNoticeDlc: 'Downloadable content',
    articleNoticeUpcoming: 'Upcoming',
    articleNoticeOther: 'Wiki notice',

    articleImage: 'Image {n}',
    articleSourceNewTab: 'opens in a new tab',
    articleAskInFlow: 'Ask the chat about {name}',

    articleTranslatedPartial: 'partial translation: some parts are still in English',
    articleUntranslated: 'No translation of this article yet: it is shown in English.',
    articleTranslationProgress: 'Translating this article… {done} of {total} strings done.',
    articleTranslationQueued: 'The translation is still in progress. Open the article again in a few minutes.',
    articleTranslationReady: 'Translation ready. Loading…',
    articleTranslationStored: 'The translation is saved: you will see it when you open the article again in a while.',
    articleTranslationCurrent: 'Nothing new to translate right now.',
    articleTranslationLimited: 'The translation allowance is used up for now. Try again in {wait}.',
    articleTranslationLimitedLater: 'The translation allowance is used up for now. Try again later.',
    articleTranslationDisabled: 'Machine translation is not available right now.',
    articleTranslationFailed: 'The translation failed. Try again later.',
    articleTranslationOffline: 'Offline: the translation could not be requested.',
    articleTranslationUpdate: 'Update the translation',
    articleTranslationComplete: 'Complete the translation',
    articleWaitMinutes: '{n} min',
    articleWaitHours: '{n} h',

    articleLoading: 'Loading the article…',
    articleMetaDescription: '{title}: stats, recipes and notes from the Valheim wiki.',

    articleViewer: 'Image viewer',
    articleViewerGallery: 'Gallery',
    articleViewerSlide: 'Image',
    articleViewerPosition: '{index} of {total}',
    articleViewerPrevious: 'Previous',
    articleViewerNext: 'Next',
    articleViewerClose: 'Close',
    articleViewerZoomIn: 'Zoom in',
    articleViewerZoomOut: 'Zoom out',
    articleViewerCaption: 'Caption',
  },
} as const;
