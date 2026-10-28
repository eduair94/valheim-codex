import { describe, expect, it, vi } from 'vitest';
import { STRINGS } from '@/lib/i18n/strings';

/*
 * The tab title of a wiki 404. For a 404 Next uses the layouts' metadata and
 * the deepest not-found module's, never the page's: a filter that matches
 * nothing (`/wiki/c/all?biome=Junk`) is the category page's own
 * `notFound()`, and the category layout has no title for `all`. Without this
 * module's title the page went out as the bare app name.
 */

const langCookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'wv_lang' && langCookie.value ? { name, value: langCookie.value } : undefined),
  }),
}));

const { generateMetadata } = await import('@/app/wiki/not-found');

describe('the wiki 404', () => {
  it('is titled in the reader’s language, as the root 404 is', async () => {
    for (const lang of ['es', 'en'] as const) {
      langCookie.value = lang;
      expect(await generateMetadata()).toEqual({ title: `${STRINGS[lang].shellNotFoundTitle} — ${STRINGS[lang].appName}` });
    }
  });

  it('is titled in Spanish when the reader has not chosen', async () => {
    langCookie.value = undefined;
    expect((await generateMetadata()).title).toBe(`${STRINGS.es.shellNotFoundTitle} — ${STRINGS.es.appName}`);
  });
});
