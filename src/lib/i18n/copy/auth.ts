/**
 * Copy for connecting: the shared password, your own Gemini key and Puter.
 *
 * Merged into `STRINGS` by `../strings.ts`. Keys added here override a base
 * key of the same name, so an area can reword its own existing copy without
 * touching the base table. Both languages must carry the same keys; the unit
 * test in `tests/unit/strings.test.ts` fails the build otherwise.
 *
 * The `authError*` keys are what to show for each `{ error }` code the
 * sign-in routes answer with (`/api/auth/*`), one key per code
 * (`connectErrorText` in `src/lib/chat/connect.ts` does the mapping):
 *
 *   forbidden_origin → authErrorForbiddenOrigin   unavailable → authErrorUnavailable
 *   rate_limited     → authErrorRateLimited ({wait} = the response's retryAfter, as words)
 *   unauthorized     → authErrorUnauthorized
 *   byok_disabled, byok_key_invalid, byok_model_unavailable, byok_key_rate_limited,
 *   byok_region_unavailable, byok_unreachable → authErrorByok…
 *   puter_disabled, puter_token_invalid, wrong_audience, puter_account_required,
 *   puter_unreachable and puter_unavailable → authErrorPuter…
 *
 * plus what the browser itself reports about Puter's sign-in popup
 * (`authErrorPuterPopupBlocked`, `…WindowClosed`, `…Unsupported`, `…Timeout`,
 * `…Load`, `…Failed`). The password form's own codes keep their `login*` keys.
 *
 * `connect*` keys are the connect page (`/login`).
 */
export const AUTH_COPY = {
  es: {
    // The page no longer asks only for the password.
    loginSubtitle: 'Para preguntar hace falta un modelo de IA. Elegí cómo conectarte.',

    authErrorForbiddenOrigin: 'El pedido llegó desde otro sitio y se rechazó. Recargá esta página y probá de nuevo.',
    authErrorUnavailable: 'Ahora no podemos verificar el acceso. Probá de nuevo en unos segundos.',
    authErrorRateLimited: 'Demasiados intentos seguidos. Probá de nuevo en {wait}.',
    authErrorUnauthorized: 'Tu sesión terminó. Volvé a entrar.',
    authErrorByokDisabled: 'Este servidor no permite entrar con tu propia clave de Gemini.',
    authErrorByokKeyInvalid:
      'Google no aceptó esa clave. Revisá que esté completa y que tenga habilitada la API de Gemini.',
    authErrorByokModelUnavailable: 'Tu clave no tiene acceso a ese modelo. Elegí otro de la lista.',
    authErrorByokKeyRateLimited: 'Tu clave llegó al límite de uso de Google. Esperá un rato o probá con otra.',
    authErrorByokRegionUnavailable: 'Google no ofrece la API de Gemini en la región de tu clave.',
    authErrorByokUnreachable: 'No pudimos consultar a Google para verificar la clave. Probá de nuevo en un momento.',
    authErrorPuterDisabled: 'Este servidor no permite entrar con Puter.',
    authErrorPuterTokenInvalid: 'Puter no reconoció tu sesión. Volvé a conectar Puter.',
    authErrorPuterWrongAudience: 'Esa sesión de Puter es de otro sitio. Volvé a conectar Puter desde acá.',
    authErrorPuterAccountRequired:
      'Para guardar tu historial hace falta una cuenta de Puter propia, no una de invitado.',
    authErrorPuterUnreachable: 'No pudimos comunicarnos con Puter. Probá de nuevo en un momento.',
    authErrorPuterPopupBlocked:
      'El navegador bloqueó la ventana de Puter. Permití las ventanas emergentes para este sitio y probá de nuevo.',
    authErrorPuterWindowClosed: 'Se cerró la ventana de Puter antes de terminar. Probá de nuevo.',
    authErrorPuterUnsupported: 'Puter no puede iniciar sesión desde esta ventana. Abrí el Codex en el navegador y probá ahí.',
    authErrorPuterTimeout: 'Puter tardó demasiado en responder. Probá de nuevo.',
    authErrorPuterLoad: 'No se pudo cargar Puter. Revisá tu conexión y probá de nuevo.',
    authErrorPuterFailed: 'No se pudo conectar con Puter. Probá de nuevo en un momento.',

    connectBackToWiki: 'Volver a la wiki',
    connectMethods: 'Cómo te conectás',
    connectMethodPassword: 'Contraseña',
    connectMethodByok: 'Gemini',
    connectMethodPuter: 'Puter',
    connectNoMethods: 'Por ahora este servidor no ofrece ninguna forma de conectarse al chat. La wiki se puede leer igual.',
    connectCurrentPassword: 'Ahora estás conectado con la contraseña del grupo, como {name}.',
    connectCurrentByok: 'Ahora estás conectado con tu clave de Gemini ({hint}).',
    connectCurrentPuter: 'Ahora estás conectado con tu cuenta de Puter ({name}).',
    connectSwitchHint: 'Si te conectás de otra forma, la conexión actual se cierra.',
    connectSwitchHintByok:
      'Con otra clave de Gemini seguís con estas consultas. Si te conectás de otra forma, esta conexión se cierra, pero las consultas vuelven cuando cargues esta clave acá.',
    connectBackToChat: 'Volver al chat',

    connectPasswordIntro: 'Para los grupos que comparten la contraseña de este Codex. Las respuestas las paga el servidor.',

    connectByokIntro:
      'Usá tu propia clave de la API de Gemini: cada respuesta se cobra a tu cuenta de Google, no al servidor.',
    connectByokKey: 'Clave de API de Gemini',
    connectByokShow: 'Mostrar',
    connectByokHide: 'Ocultar',
    connectByokShowKey: 'Mostrar la clave',
    connectByokHideKey: 'Ocultar la clave',
    connectByokGetKey: 'Conseguí una clave en Google AI Studio',
    connectByokModel: 'Modelo',
    connectByokNoteStored:
      'Se guarda cifrada en una cookie de este navegador y no se vuelve a mostrar: acá solo vas a ver sus últimos cuatro caracteres.',
    connectByokNoteHistory:
      'Tus consultas quedan asociadas a este navegador: si volvés a cargar esta clave acá dentro de 180 días, las recuperás. En otro navegador o dispositivo empezás de cero.',
    connectByokNoteFreeTier: 'Con una clave del plan gratuito, Google puede usar tus preguntas para mejorar sus productos.',
    connectByokNoteRestrict:
      'Conviene usar una clave restringida a la API de Gemini, con una alerta de presupuesto en Google Cloud.',
    connectByokSubmit: 'Guardar y conectar',
    connectByokPending: 'Verificando con Google…',

    connectPuterIntro:
      'Entrá con tu cuenta de Puter: el modelo corre en este navegador y se descuenta de tu saldo de Puter, no del servidor.',
    connectPuterNote: 'Hace falta una cuenta propia, no de invitado. Se abre una ventana de Puter para iniciar sesión.',
    connectPuterButton: 'Conectar con Puter',
    connectPuterPending: 'Esperando a Puter…',
    connectPuterRetry: 'Probar de nuevo',
    connectPuterOtherAccount: 'Usar otra cuenta de Puter',
    connectOpenInBrowser: 'Abrir en el navegador',
  },
  en: {
    loginSubtitle: 'Asking takes an AI model. Choose how to connect.',

    authErrorForbiddenOrigin: 'The request came from another site and was refused. Reload this page and try again.',
    authErrorUnavailable: 'Access cannot be checked right now. Try again in a few seconds.',
    authErrorRateLimited: 'Too many attempts in a row. Try again in {wait}.',
    authErrorUnauthorized: 'Your session has ended. Sign in again.',
    authErrorByokDisabled: 'This server does not allow signing in with your own Gemini key.',
    authErrorByokKeyInvalid: 'Google did not accept that key. Check that it is complete and has the Gemini API enabled.',
    authErrorByokModelUnavailable: 'Your key has no access to that model. Pick another one from the list.',
    authErrorByokKeyRateLimited: 'Your key has reached its Google usage limit. Wait a while or try another one.',
    authErrorByokRegionUnavailable: 'Google does not offer the Gemini API in your key’s region.',
    authErrorByokUnreachable: 'Google could not be reached to check the key. Try again in a moment.',
    authErrorPuterDisabled: 'This server does not allow signing in with Puter.',
    authErrorPuterTokenInvalid: 'Puter did not recognise your session. Connect Puter again.',
    authErrorPuterWrongAudience: 'That Puter session belongs to another site. Connect Puter again from here.',
    authErrorPuterAccountRequired: 'Saving your history needs a Puter account of your own, not a guest one.',
    authErrorPuterUnreachable: 'Puter could not be reached. Try again in a moment.',
    authErrorPuterPopupBlocked: 'Your browser blocked the Puter window. Allow pop-ups for this site and try again.',
    authErrorPuterWindowClosed: 'The Puter window closed before signing in finished. Try again.',
    authErrorPuterUnsupported: 'Puter cannot sign in from this window. Open the Codex in your browser and try there.',
    authErrorPuterTimeout: 'Puter took too long to answer. Try again.',
    authErrorPuterLoad: 'Puter could not be loaded. Check your connection and try again.',
    authErrorPuterFailed: 'Connecting to Puter failed. Try again in a moment.',

    connectBackToWiki: 'Back to the wiki',
    connectMethods: 'How you connect',
    connectMethodPassword: 'Password',
    connectMethodByok: 'Gemini',
    connectMethodPuter: 'Puter',
    connectNoMethods: 'This server offers no way to connect to the chat for now. The wiki is still open to read.',
    connectCurrentPassword: 'You are connected with the crew password, as {name}.',
    connectCurrentByok: 'You are connected with your Gemini key ({hint}).',
    connectCurrentPuter: 'You are connected with your Puter account ({name}).',
    connectSwitchHint: 'Connecting another way closes the current connection.',
    connectSwitchHintByok:
      'Another Gemini key keeps these conversations. Connecting another way closes this connection, but they come back when you enter this key here again.',
    connectBackToChat: 'Back to the chat',

    connectPasswordIntro: 'For crews that share this Codex’s password. The server pays for the answers.',

    connectByokIntro: 'Use your own Gemini API key: each answer is billed to your Google account, not the server.',
    connectByokKey: 'Gemini API key',
    connectByokShow: 'Show',
    connectByokHide: 'Hide',
    connectByokShowKey: 'Show the key',
    connectByokHideKey: 'Hide the key',
    connectByokGetKey: 'Get a key at Google AI Studio',
    connectByokModel: 'Model',
    connectByokNoteStored:
      'It is stored encrypted in a cookie in this browser and never shown again: here you will only see its last four characters.',
    connectByokNoteHistory:
      'Your conversations are tied to this browser: enter this key here again within 180 days and they come back. Another browser or device starts from scratch.',
    connectByokNoteFreeTier: 'With a free-tier key, Google may use your questions to improve its products.',
    connectByokNoteRestrict: 'Best use a key restricted to the Gemini API, with a budget alert in Google Cloud.',
    connectByokSubmit: 'Save and connect',
    connectByokPending: 'Checking with Google…',

    connectPuterIntro:
      'Sign in with your Puter account: the model runs in this browser and is charged to your Puter balance, not the server.',
    connectPuterNote: 'It takes an account of your own, not a guest one. A Puter window opens for you to sign in.',
    connectPuterButton: 'Connect with Puter',
    connectPuterPending: 'Waiting for Puter…',
    connectPuterRetry: 'Try again',
    connectPuterOtherAccount: 'Use another Puter account',
    connectOpenInBrowser: 'Open in the browser',
  },
} as const;
