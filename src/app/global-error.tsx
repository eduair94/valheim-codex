'use client';

import { useSyncExternalStore } from 'react';
import type { ErrorInfo } from 'next/error';
import { ErrorPage } from '@/components/shell/error-view';
import { ERROR_COPY } from '@/lib/i18n/error-copy';
import { readLangCookie } from '@/lib/i18n/lang-cookie';
import type { Lang } from '@/lib/i18n/strings';
import './globals.css';

const neverChanges = (): (() => void) => () => {};
const cookieLang = (): Lang => readLangCookie() ?? 'es';
const defaultLang = (): Lang => 'es';

/**
 * The root layout itself failed, so this replaces the whole document: it
 * brings its own `<html>`, `<body>` and stylesheet. Without it Next showed its
 * built-in page, unstyled and in English.
 *
 * Nothing the root layout provides is available here, the language and its
 * copy included: the language is read from the cookie in the browser, and the
 * words are the error page's own seven, in both languages (`ERROR_COPY`),
 * rather than the whole table, which would load with every page.
 */
export default function GlobalError({ error, retry }: ErrorInfo) {
  const lang = useSyncExternalStore(neverChanges, cookieLang, defaultLang);
  const t = ERROR_COPY[lang];
  return (
    <html lang={lang}>
      <body className="antialiased">
        <title>{`${t.shellErrorTitle} — ${t.appName}`}</title>
        <ErrorPage copy={t} error={error} retry={retry} />
      </body>
    </html>
  );
}
