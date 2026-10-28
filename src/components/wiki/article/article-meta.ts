import { spanishTitle } from '@/lib/i18n/article-names';
import type { Lang } from '@/lib/i18n/strings';
import { isMaintenanceCategory } from '@/lib/wiki/browse-groups';
import { normalizeTerm, spanishName } from '@/lib/wiki/links';

/**
 * Small decisions about an article's identity: how its title is shown and
 * sized, which category leads back to it, what a link preview and the chat
 * are told about it.
 */

/**
 * The title an article goes by for this reader, with the English one as a
 * gloss where they differ: the shape of a stored translation's title,
 * "Espada de hierro (Iron Sword)". What the heading, the tab title, the link
 * preview and the question for the chat are made from.
 *
 * A translated article's is its translation's. An untranslated one, in
 * Spanish, goes by the name the lists, the comparison and the search already
 * give it (`spanishTitle`), "Jabalí (Boar)": its page said "Boar" under a list
 * that read "Jabalí". Without a Spanish name, or in English, the English
 * title as it is.
 */
export function articleTitle(
  page: { title: string; translation: object | null; article: { title: string } },
  lang: Lang,
): string {
  if (lang === 'en' || page.translation) return page.title;
  const name = spanishTitle(page.article.title, null).name;
  return name ? `${name} (${page.article.title})` : page.title;
}

/**
 * The heading and, beside it, the English name.
 *
 * A translated title carries the English as a gloss — "Champiñones a montones
 * a la Tierras brumosas (Mushrooms Galore á la Mistlands)" — and as one
 * tracked, all-capitals h1 that wrapped to six lines on a phone, the English
 * name players match against the game broken across the last three (LM-14).
 * The name is the heading; the English goes underneath, in its own language.
 */
export function displayTitle(shown: string, english: string): { name: string; english: string | null } {
  const name = shown === english ? shown.trim() : spanishName(shown, english);
  return { name, english: normalizeTerm(name) === normalizeTerm(english) ? null : english };
}

/**
 * How big the title can afford to be. Measured in characters because the
 * display face is set in capitals: a short name is worth setting large, a
 * long one in the face's small capitals, untracked, so it wraps to two or
 * three balanced lines instead of six.
 */
export type TitleTier = 'short' | 'medium' | 'long';

export function titleTier(name: string): TitleTier {
  const length = name.trim().length;
  if (length <= 20) return 'short';
  if (length <= 34) return 'medium';
  return 'long';
}

/**
 * How the title breaks a word too long for its line. A Spanish name can be a
 * single long word, and beside the picture on a 320px phone "Congelamiento"
 * ran 26px past the column, taking the page sideways with it. Any word breaks
 * at the edge instead, and a one-word name is also hyphenated where the
 * browser knows its language ("Quiebraes-pinas"). A name of several words
 * still breaks only between them: hyphenation there would also split the last
 * long word of many a two-line title that fits as it is.
 */
export function titleWrapClass(name: string): string {
  return /\s/.test(name.trim()) ? 'wrap-break-word' : 'wrap-break-word hyphens-auto';
}

/**
 * The category the breadcrumb leads back to: the article's first real one.
 * The wiki's bookkeeping ("Unfinished") is not a place, and a recipe list
 * ("Forge recipes") is a station's index rather than what the thing is.
 */
export function primaryCategory(categories: readonly string[]): string | null {
  const real = categories.filter((category) => !isMaintenanceCategory(category));
  return real.find((category) => !/\brecipes$/i.test(category)) ?? real[0] ?? null;
}

/** A description cut at a word boundary, with an ellipsis, so it never ends mid-word. */
export function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.(–-]+$/, '')}…`;
}

/**
 * What "Ask about this" puts in the chat's input: the name the reader sees,
 * with the English alongside when they differ. The answer comes from an
 * English wiki and the search rewrites the question into English anyway, but
 * the English name is what pins it to this article; "Murciélago" alone would
 * leave the bat to the model's knowledge of Spanish.
 */
export function askTitle(shown: string, english: string): string {
  const { name, english: gloss } = displayTitle(shown, english);
  return gloss ? `${name} (${gloss})` : name;
}
