import type { Lang, Strings } from './strings';

/** The words the error page shows (`ErrorPage`, components/shell/error-view.tsx). */
export type ErrorCopy = Readonly<
  Pick<
    Record<keyof Strings, string>,
    | 'appName'
    | 'retry'
    | 'shellErrorLabel'
    | 'shellErrorTitle'
    | 'shellErrorBody'
    | 'shellErrorHome'
    | 'shellErrorReference'
  >
>;

/**
 * The error page's words, in both languages, for `app/global-error.tsx`.
 *
 * That page replaces the root layout when the layout itself fails, so there
 * is no `LangProvider` above it to read the table from, and importing the
 * table would put all of it, both languages, into a chunk every page loads.
 * It carries these seven instead.
 *
 * A copy of the table's own entries: `tests/unit/strings.test.ts` fails when
 * the two differ, so a rewording there must be made here too.
 */
export const ERROR_COPY: Readonly<Record<Lang, ErrorCopy>> = {
  es: {
    appName: 'Valheim Codex',
    retry: 'Reintentar',
    shellErrorLabel: 'Error',
    shellErrorTitle: 'Algo falló al abrir esta página',
    shellErrorBody: 'Puede ser algo pasajero. Probá de nuevo; si sigue fallando, volvé a la búsqueda.',
    shellErrorHome: 'Ir a la búsqueda',
    shellErrorReference: 'Referencia',
  },
  en: {
    appName: 'Valheim Codex',
    retry: 'Retry',
    shellErrorLabel: 'Error',
    shellErrorTitle: 'Something broke while opening this page',
    shellErrorBody: 'It may be temporary. Try again; if it keeps failing, go back to search.',
    shellErrorHome: 'Go to search',
    shellErrorReference: 'Reference',
  },
};
