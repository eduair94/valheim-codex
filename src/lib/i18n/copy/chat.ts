/**
 * Copy for the chat: conversation list, composer, answers, errors.
 *
 * Merged into `STRINGS` by `../strings.ts`. Keys added here override a base
 * key of the same name, so an area can reword its own existing copy without
 * touching the base table. Both languages must carry the same keys; the unit
 * test in `tests/unit/strings.test.ts` fails the build otherwise.
 *
 * Errors name what happened and the way out, and match the action next to
 * them: a sentence that says "reconnect Puter" sits beside a button that does
 * exactly that. `{wait}` is a phrase from `waitPhrase` ("41 segundos",
 * "3 minutos"); `{n}` and `{max}` are numbers.
 */
export const CHAT_COPY = {
  es: {
    chatSkipToComposer: 'Ir a la pregunta',
    chatCloseMenu: 'Cerrar la lista de consultas',
    chatTable: 'Tabla',
    chatJumpToLatest: 'Ir al final',
    chatOpensNewTab: '(se abre en una pestaña nueva)',
    chatLoadingConversation: 'Abriendo la consulta…',
    chatDismiss: 'Cerrar aviso',
    chatRetryIn: 'Reintentar en {n} s',
    chatQuestionCount: '{n} de {max} caracteres',

    chatOutcomeStopped: 'Respuesta detenida.',
    chatOutcomeCut: 'La respuesta se cortó antes de terminar.',
    chatOutcomeFailed: 'No se pudo responder esta pregunta.',
    chatOutcomeUnanswered: 'Detenida antes de responder.',

    chatErrorSessionEnded: 'Tu sesión terminó. Volvé a conectarte para seguir con esta consulta.',
    chatErrorForbidden: 'Esta forma de conectarte no permite preguntar. Probá con otra.',
    chatErrorMethodChanged: 'Te conectaste de otra forma en otra pestaña. Recargá esta para seguir.',
    chatErrorTooLong: 'La pregunta es demasiado larga. Acortala y volvé a enviarla.',
    chatErrorTooLongMax: 'La pregunta es demasiado larga: el máximo son {n} caracteres.',
    chatErrorNotFound: 'Esta consulta ya no existe; quizás la borraste en otra pestaña. Empezá una nueva.',
    chatErrorRateLimited: 'Hiciste muchas consultas seguidas. Esperá un momento y volvé a preguntar.',
    chatErrorRateLimitedWait: 'Hiciste muchas consultas seguidas. Esperá {wait} y volvé a preguntar.',
    chatErrorUnavailable: 'El servidor no puede atender ahora. Probá de nuevo en unos segundos.',
    chatErrorTimeout: 'El modelo tardó demasiado en responder. Probá de nuevo.',
    chatErrorInterrupted: 'Se cortó la respuesta. Probá de nuevo.',
    chatErrorEmptyAnswer: 'El modelo no pudo responder esta pregunta. Probá reformularla.',
    chatErrorByokKeyInvalid: 'Google rechazó tu clave de Gemini. Cargá otra clave para seguir.',
    chatErrorByokQuotaWait: 'Tu clave de Gemini llegó a su límite de consultas por ahora. Esperá {wait} y volvé a preguntar.',
    chatErrorByokQuotaDaily:
      'Tu clave de Gemini usó todo su cupo de hoy. Se renueva a la medianoche del Pacífico (EE. UU.); mientras tanto podés usar otra clave.',
    chatErrorByokModel: 'Tu clave no tiene acceso a este modelo. Elegí otro y volvé a intentar.',
    chatErrorByokRegion: 'Google no ofrece Gemini para tu clave en tu región o con tu plan. Probá conectarte de otra forma.',
    chatErrorPuterSignedOut: 'Tu sesión de Puter se cerró en este navegador. Reconectá Puter para seguir preguntando.',
    chatErrorPuterFunds:
      'Se terminó tu saldo de Puter. La wiki se puede seguir leyendo; para preguntar, cargá saldo en Puter o conectate de otra forma.',
    chatErrorPuterSubscription: 'Ese modelo necesita un plan pago de Puter. Elegí otro modelo.',
    chatErrorPuterRateLimited: 'Puter está frenando tus consultas por ahora. Esperá un momento y volvé a preguntar.',
    chatErrorPuterFailed: 'Puter no pudo responder. Probá de nuevo en un momento.',

    chatWaitSecond: '1 segundo',
    chatWaitSeconds: '{n} segundos',
    chatWaitMinutes: '{n} minutos',
    chatWaitHours: '{n} horas',

    chatActionSignIn: 'Conectarme de nuevo',
    chatActionReload: 'Recargar',
    chatActionReconnectPuter: 'Reconectar Puter',
    chatActionChangeKey: 'Cambiar clave',
    chatActionChangeModel: 'Elegir otro modelo',
    chatActionChangeMethod: 'Conectarme de otra forma',
    chatActionDismiss: 'Entendido',

    chatAccountLabel: 'Conexión',
    chatAccountPassword: 'Contraseña del grupo',
    chatAccountByok: 'Tu clave, tu cuenta de Google',
    chatAccountPuter: 'Tu cuenta y tu saldo de Puter',
    chatAccountModel: 'Modelo',
    chatChangeMethod: 'Cambiar método',
    chatForgetKey: 'Olvidar clave',
    chatForgetKeyConfirm:
      '¿Olvidar tu clave de Gemini en este navegador? Tus consultas no se borran y vuelven si la cargás de nuevo acá; para seguir con ellas usando otra clave, usá «Cambiar clave».',

    chatModelLatestFlashLite: 'Gemini Flash-Lite (última)',
    chatModelHintRecommended: 'El modelo recomendado.',
    chatModelHintLatest: 'Sigue a la versión más nueva de Flash-Lite, que Google puede cambiar sin aviso.',
    chatModelHintLegacyKeys: 'Google solo lo ofrece a claves que ya lo usaban.',

    chatNoticeOpenNotFound: 'Esa consulta ya no existe.',
    chatNoticeOpenRateLimitedWait: 'Se abrieron muchas consultas en poco tiempo. Probá de nuevo en {wait}.',
    chatNoticeOpenRateLimited: 'Se abrieron muchas consultas en poco tiempo. Probá de nuevo en un momento.',
    chatOlderHidden: 'Los mensajes más antiguos de esta consulta no se muestran.',
  },
  en: {
    chatSkipToComposer: 'Skip to the question box',
    chatCloseMenu: 'Close the question list',
    chatTable: 'Table',
    chatJumpToLatest: 'Jump to the latest',
    chatOpensNewTab: '(opens in a new tab)',
    chatLoadingConversation: 'Opening the conversation…',
    chatDismiss: 'Dismiss',
    chatRetryIn: 'Retry in {n} s',
    chatQuestionCount: '{n} of {max} characters',

    chatOutcomeStopped: 'You stopped this answer.',
    chatOutcomeCut: 'This answer was cut off before the end.',
    chatOutcomeFailed: 'This question could not be answered.',
    chatOutcomeUnanswered: 'Stopped before an answer.',

    chatErrorSessionEnded: 'Your session has ended. Connect again to carry on with this conversation.',
    chatErrorForbidden: 'This way of connecting cannot ask questions. Try another one.',
    chatErrorMethodChanged: 'You connected another way in another tab. Reload this one to carry on.',
    chatErrorTooLong: 'The question is too long. Shorten it and send it again.',
    chatErrorTooLongMax: 'The question is too long: the limit is {n} characters.',
    chatErrorNotFound: 'This conversation no longer exists; perhaps you deleted it in another tab. Start a new one.',
    chatErrorRateLimited: 'You asked a lot in a short time. Wait a moment and ask again.',
    chatErrorRateLimitedWait: 'You asked a lot in a short time. Wait {wait} and ask again.',
    chatErrorUnavailable: 'The server cannot take questions right now. Try again in a few seconds.',
    chatErrorTimeout: 'The model took too long to answer. Try again.',
    chatErrorInterrupted: 'The answer was cut off. Try again.',
    chatErrorEmptyAnswer: 'The model could not answer this question. Try rephrasing it.',
    chatErrorByokKeyInvalid: 'Google rejected your Gemini key. Add another key to carry on.',
    chatErrorByokQuotaWait: 'Your Gemini key hit its request limit for now. Wait {wait} and ask again.',
    chatErrorByokQuotaDaily:
      'Your Gemini key has used up today’s quota. It renews at midnight Pacific time; meanwhile you can use another key.',
    chatErrorByokModel: 'Your key has no access to this model. Pick another one and try again.',
    chatErrorByokRegion: 'Google does not offer Gemini for your key in your region or on your plan. Try connecting another way.',
    chatErrorPuterSignedOut: 'Your Puter session ended in this browser. Reconnect Puter to keep asking.',
    chatErrorPuterFunds:
      'Your Puter balance has run out. The wiki still works; to ask, top up at Puter or connect another way.',
    chatErrorPuterSubscription: 'That model needs a paid Puter plan. Pick another model.',
    chatErrorPuterRateLimited: 'Puter is holding back your requests for now. Wait a moment and ask again.',
    chatErrorPuterFailed: 'Puter could not answer. Try again in a moment.',

    chatWaitSecond: '1 second',
    chatWaitSeconds: '{n} seconds',
    chatWaitMinutes: '{n} minutes',
    chatWaitHours: '{n} hours',

    chatActionSignIn: 'Connect again',
    chatActionReload: 'Reload',
    chatActionReconnectPuter: 'Reconnect Puter',
    chatActionChangeKey: 'Change key',
    chatActionChangeModel: 'Pick another model',
    chatActionChangeMethod: 'Connect another way',
    chatActionDismiss: 'Got it',

    chatAccountLabel: 'Connection',
    chatAccountPassword: 'Crew password',
    chatAccountByok: 'Your key, your Google account',
    chatAccountPuter: 'Your Puter account and balance',
    chatAccountModel: 'Model',
    chatChangeMethod: 'Change method',
    chatForgetKey: 'Forget key',
    chatForgetKeyConfirm:
      'Forget your Gemini key in this browser? Your conversations are not deleted and come back if you enter it here again; to keep them with another key, use “Change key” instead.',

    chatModelLatestFlashLite: 'Gemini Flash-Lite (latest)',
    chatModelHintRecommended: 'The recommended model.',
    chatModelHintLatest: 'Follows the newest Flash-Lite, which Google can change without notice.',
    chatModelHintLegacyKeys: 'Google only serves it to keys that used it before.',

    chatNoticeOpenNotFound: 'That conversation no longer exists.',
    chatNoticeOpenRateLimitedWait: 'Too many conversations were opened in a short time. Try again in {wait}.',
    chatNoticeOpenRateLimited: 'Too many conversations were opened in a short time. Try again in a moment.',
    chatOlderHidden: 'Older messages in this conversation are not shown.',
  },
} as const;
