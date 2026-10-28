import Link from 'next/link';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import type { Linker } from '@/lib/wiki/links';
import { BROWSE_HREF } from '@/components/shell/nav-model';
import { categoryHref } from '@/lib/routes';
import { FANDOM_IMG_PROPS, thumbnailImageUrl } from '@/lib/wiki/image-url';
import { hasTermLabel, termLabel } from '@/lib/i18n/terms';
import { strings, type Lang } from '@/lib/i18n/strings';
import { LinkedText } from '../linked-text';
import { titleTier, titleWrapClass } from './article-meta';

/** The image's drawn size at its largest (lg:size-28), in CSS pixels. */
const IMAGE_PX = 112;

/**
 * Title type by length. The display face is carved capitals, worth setting
 * large for a short name; a long one is set in the face's small capitals,
 * without tracking, so it wraps to two balanced lines instead of six (LM-14).
 */
const TITLE_CLASS = {
  short: 'display text-xl sm:text-2xl lg:text-3xl',
  medium: 'display text-lg tracking-[0.08em] sm:text-xl lg:text-2xl',
  long: 'font-display text-lg font-semibold tracking-[0.02em] sm:text-xl lg:text-2xl',
} as const;

/**
 * Where the reader is, and what this is: a breadcrumb back to the article's
 * category, the picture, the name (with the English name the game and the
 * wiki use underneath it, in its own language), the facets, and whatever
 * needs saying about the translation — up here, where it qualifies what
 * follows, rather than after the last paragraph (LD-07).
 *
 * Across the whole width at every size; from 1024px the picture and the name
 * grow, since there is room for them to.
 */
export function ArticleHeader({
  name,
  nameLang,
  english,
  doc,
  category,
  lang,
  uiLang,
  linker,
  notice,
}: {
  name: string;
  /** The name's language, when it is not the article's: an untranslated article's Spanish name. */
  nameLang?: Lang;
  /** The English name, when it differs from the one shown. */
  english: string | null;
  doc: ArticleDoc;
  /** The category the breadcrumb leads back to. */
  category: string | null;
  lang: Lang;
  /** Set when the article is in another language than the interface. */
  uiLang?: Lang;
  linker: Linker;
  notice: React.ReactNode;
}) {
  const t = strings(lang);
  const image = doc.infobox?.image;
  const { type, station, biome } = doc.facets;

  // Facets are stored in English, the language filters match on; they are
  // shown in the reader's. The page's links include these display names.
  const facets = [
    type ? termLabel('type', type, lang) : null,
    station ? `${t.wikiStation}: ${termLabel('station', station, lang)}` : null,
    biome ? termLabel('biome', biome, lang) : null,
  ].filter((facet): facet is string => Boolean(facet));

  const categoryLabel = category ? termLabel('category', category, lang) : null;
  // A category with no Spanish name yet is English inside a Spanish page.
  const categoryLang = category && lang === 'es' && !hasTermLabel('category', category) ? 'en' : undefined;

  return (
    <header>
      <nav aria-label={t.articleBreadcrumb} lang={uiLang} className="mb-3 font-mono text-xs text-ash">
        <ol className="flex flex-wrap items-center gap-x-2">
          <li>
            <Link href={BROWSE_HREF} prefetch={false} className="crumb">
              {t.wikiBrowse}
            </Link>
          </li>
          {category && categoryLabel ? (
            <li className="flex items-center gap-x-2">
              <span aria-hidden="true" className="text-ash/60">
                ›
              </span>
              <Link href={categoryHref(category)} prefetch={false} lang={categoryLang} className="crumb">
                {categoryLabel}
              </Link>
            </li>
          ) : null}
        </ol>
      </nav>

      <div className="flex items-start gap-4 lg:gap-6">
        {image ? (
          // Hotlinked from Fandom's CDN, and deliberately not `next/image`:
          // third-party URLs that would otherwise be proxied and re-encoded
          // through our server for no gain. Asked for at its largest drawn
          // size; the slot's size is fixed, so nothing moves when it lands.
          // Shrunk to fit the slot but never enlarged (`scale-down`): most
          // item pictures are 64px sprites, and `contain` stretched them to
          // 94px in the desktop plate, blurred.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            {...FANDOM_IMG_PROPS}
            src={thumbnailImageUrl(image.url, IMAGE_PX)}
            alt={image.alt || name}
            lang={image.alt ? undefined : nameLang}
            width={IMAGE_PX}
            height={IMAGE_PX}
            loading="eager"
            fetchPriority="high"
            className="size-18 shrink-0 rounded-md border border-moss bg-peat object-scale-down p-1 lg:size-28 lg:p-2"
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <h1
            lang={nameLang}
            className={`leading-tight text-balance text-birch ${TITLE_CLASS[titleTier(name)]} ${titleWrapClass(name)}`}
          >
            {name}
          </h1>
          {english ? (
            <p lang="en" className="mt-1 font-mono text-xs text-ash">
              {english}
            </p>
          ) : null}
          {facets.length > 0 ? (
            <p lang={uiLang} className="mt-2 font-mono text-xs leading-relaxed text-ash">
              {facets.map((facet, i) => (
                <span key={facet}>
                  {i > 0 ? <span aria-hidden="true"> · </span> : null}
                  <LinkedText text={facet} linker={linker} />
                </span>
              ))}
            </p>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div lang={uiLang} className="mt-4">
          {notice}
        </div>
      ) : null}
    </header>
  );
}
