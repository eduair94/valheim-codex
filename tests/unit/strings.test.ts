import { describe, expect, it } from 'vitest';
import { STRINGS } from '@/lib/i18n/strings';
import { BROWSE_COPY } from '@/lib/i18n/browse-copy';
import { ARTICLE_COPY } from '@/lib/i18n/copy/article';
import { AUTH_COPY } from '@/lib/i18n/copy/auth';
import { CHAT_COPY } from '@/lib/i18n/copy/chat';
import { CRAFT_COPY } from '@/lib/i18n/copy/craft';
import { GUIDE_COPY } from '@/lib/i18n/copy/guide';
import { SEARCH_COPY } from '@/lib/i18n/copy/search';
import { SHELL_COPY } from '@/lib/i18n/copy/shell';
import { WIKI_COPY } from '@/lib/i18n/copy/wiki';
import { ERROR_COPY } from '@/lib/i18n/error-copy';

const AREAS = {
  article: ARTICLE_COPY,
  auth: AUTH_COPY,
  browse: BROWSE_COPY,
  chat: CHAT_COPY,
  craft: CRAFT_COPY,
  guide: GUIDE_COPY,
  search: SEARCH_COPY,
  shell: SHELL_COPY,
  wiki: WIKI_COPY,
} as const;

const LANGS = ['es', 'en'] as const;

function keys(o: object): string[] {
  return Object.keys(o).sort();
}

describe('UI copy', () => {
  it('carries the same keys in both languages', () => {
    expect(keys(STRINGS.en)).toEqual(keys(STRINGS.es));
  });

  it.each(Object.entries(AREAS))('keeps the %s area in step between languages', (_area, copy) => {
    expect(keys(copy.en)).toEqual(keys(copy.es));
  });

  it('gives list-valued copy the same length in both languages', () => {
    for (const key of keys(STRINGS.es)) {
      const es = (STRINGS.es as Record<string, unknown>)[key];
      const en = (STRINGS.en as Record<string, unknown>)[key];
      if (Array.isArray(es)) expect(Array.isArray(en) && en.length, key).toBe(es.length);
    }
  });

  it('names the first column of a comparison for everything it lists, not only objects', () => {
    // The base table's "Objeto"/"Item" was always overridden, and is gone; this is the one that shows.
    expect(STRINGS.es.wikiItem).toBe('Nombre');
    expect(STRINGS.en.wikiItem).toBe('Name');
  });

  it('never leaves a string empty', () => {
    for (const lang of ['es', 'en'] as const) {
      for (const [key, value] of Object.entries(STRINGS[lang])) {
        if (typeof value === 'string') expect(value.trim().length, `${lang}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('copy that reaches the browser', () => {
  it('is plain strings and lists of strings, so the layout can hand a language to LangProvider', () => {
    // It travels in the RSC payload: a function, a date or a symbol there
    // would fail the render or arrive as something else.
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(STRINGS[lang])) {
        const ok = typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
        expect(ok, `${lang}.${key}`).toBe(true);
      }
      expect(JSON.parse(JSON.stringify(STRINGS[lang]))).toEqual(STRINGS[lang]);
    }
  });

  it('keeps the browsing words as browse-copy.ts has them: no area overrides one', () => {
    // The search shows these from BROWSE_COPY in the browser and the browse
    // page from the table on the server; an override would split the two.
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(BROWSE_COPY[lang])) {
        expect((STRINGS[lang] as Record<string, unknown>)[key], `${lang}.${key}`).toBe(value);
      }
    }
  });

  it('gives the root error page the same words as the table', () => {
    // global-error.tsx carries its own copy (ERROR_COPY), having no provider
    // above it; a rewording of the table's entries must be made there too.
    expect(keys(ERROR_COPY.en)).toEqual(keys(ERROR_COPY.es));
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(ERROR_COPY[lang])) {
        expect(value, `ERROR_COPY.${lang}.${key} differs from the table`).toBe(
          (STRINGS[lang] as Record<string, unknown>)[key],
        );
      }
    }
  });
});
