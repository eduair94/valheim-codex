import type { JSX, ReactElement } from 'react';
import { LangProvider } from '@/components/shell/lang-context';
import { strings, type Lang } from '@/lib/i18n/strings';

/**
 * Wraps an element in the provider the root layout gives every page, so the
 * Client Components inside read their copy with `useStrings` as they do in
 * the app. Without it they throw: there is no table to fall back to.
 */
export function withLang(lang: Lang, element: ReactElement): JSX.Element {
  return (
    <LangProvider lang={lang} strings={strings(lang)}>
      {element}
    </LangProvider>
  );
}
