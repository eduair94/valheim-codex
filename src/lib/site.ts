import type { Lang } from '@/lib/i18n/strings';

/**
 * The public origin the app is served from.
 *
 * Absolute URLs (metadata, link previews) are built on it, and so is every
 * check where the server must know its own identity without trusting the
 * request. The Puter sign-in check is the sharp case: it compares the app id
 * baked into a user's token with the id Puter assigns to *this* origin, so the
 * origin has to come from configuration. Taken from a header, a token minted
 * for any other Puter-enabled site would pass by naming that site.
 */
export const SITE_URL = 'https://valheim.digitalshopuy.com';

/** The site's name in link previews, the same in both languages. */
export const SITE_NAME = 'Valheim Codex';

/**
 * Each interface language as an Open Graph locale: Rioplatense Spanish, which
 * the copy is written in, and English.
 */
const OG_LOCALES = { es: 'es_UY', en: 'en_US' } as const satisfies Record<Lang, string>;

/**
 * What every link preview says about the site: the kind of page, the site's
 * name, and the language the page is in, with the other one as an alternate.
 *
 * One object for the root layout and for every page that sets `openGraph`.
 * Metadata merges shallowly, so a page's `openGraph` replaces the layout's
 * whole object, and each such page used to restate these fields by hand — one
 * with a locale of its own.
 *
 * The locale follows the language the page is rendered in. A link-preview
 * crawler sends no language cookie and gets the Spanish page, `es_UY`; a page
 * rendered in English for a reader who chose it is English, and said `es_UY`
 * as well until this followed. The same address serves both, by cookie, so
 * each names the other as its alternate.
 */
export function siteOpenGraph<T extends 'website' | 'article'>(type: T, lang: Lang) {
  return {
    type,
    siteName: SITE_NAME,
    locale: OG_LOCALES[lang],
    alternateLocale: [OG_LOCALES[lang === 'es' ? 'en' : 'es']],
  };
}

/**
 * Origins this deployment answers on, for server-side identity checks.
 *
 * `APP_ORIGIN` (comma-separated, no trailing slash) overrides the default for
 * another domain or a staging copy.
 */
export function appOrigins(): string[] {
  const raw = process.env.APP_ORIGIN;
  if (!raw) return [SITE_URL];
  const origins = raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => /^https?:\/\/[^/]+$/.test(origin));
  return origins.length > 0 ? origins : [SITE_URL];
}
