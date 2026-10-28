import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { useServerLang, useStrings } from '@/components/shell/lang-context';
import { STRINGS, type Lang } from '@/lib/i18n/strings';
import { loadAllStrings, loadedStrings, subscribeToLoadedStrings } from '@/lib/i18n/strings-loader';
import { withLang } from '../helpers/lang';

/*
 * Client Components read their copy from the root layout's `LangProvider`
 * (`useStrings`), not from the table: see tests/unit/client-copy-guard.test.ts.
 * These are the server-render half of that contract; the switch in the
 * browser is the loader's, below, and the chat's.
 */

function Probe({ lang }: { lang?: Lang }) {
  const t = useStrings(lang);
  return createElement('p', { 'data-lang': useServerLang() }, t.composerPlaceholder);
}

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);

describe('useStrings, rendered on the server', () => {
  it('gives the page’s own table, in either language', () => {
    expect(render(withLang('es', createElement(Probe)))).toBe(`<p data-lang="es">${STRINGS.es.composerPlaceholder}</p>`);
    expect(render(withLang('en', createElement(Probe, { lang: 'en' })))).toBe(
      `<p data-lang="en">${STRINGS.en.composerPlaceholder}</p>`,
    );
  });

  it('renders the provider’s table for another language, so hydration agrees with the HTML', () => {
    // The browser fetches the other table after hydrating; the server and
    // the hydrating render never have it, and must produce the same markup.
    expect(render(withLang('es', createElement(Probe, { lang: 'en' })))).toContain(STRINGS.es.composerPlaceholder);
  });

  it('says what is missing when there is no provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(createElement(Probe))).toThrow(/LangProvider/);
    vi.restoreAllMocks();
  });
});

describe('the table, loaded on demand', () => {
  it('arrives once, for both languages, and tells every subscriber', async () => {
    const heard = vi.fn();
    const unsubscribe = subscribeToLoadedStrings(heard);
    expect(loadedStrings('en')).toBeNull();

    await Promise.all([loadAllStrings(), loadAllStrings()]);
    expect(loadedStrings('en')).toBe(STRINGS.en);
    expect(loadedStrings('es')).toBe(STRINGS.es);
    expect(heard).toHaveBeenCalledTimes(1);

    unsubscribe();
    await loadAllStrings();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
