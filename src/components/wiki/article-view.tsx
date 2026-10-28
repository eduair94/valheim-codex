import Link from 'next/link';
import type { ArticlePage } from '@/lib/wiki/data';
import { buildLinker } from '@/lib/wiki/links';
import { isMaintenanceCategory } from '@/lib/wiki/browse-groups';
import { categoryHref } from '@/lib/routes';
import { hasTermLabel, termLabel } from '@/lib/i18n/terms';
import { strings, type Lang } from '@/lib/i18n/strings';
import { AskButton } from './ask-button';
import { Gallery, type GalleryImage } from './gallery';
import { LinkedText } from './linked-text';
import { TranslateOnView } from './translate-on-view';
import { articleTitle, displayTitle, primaryCategory } from './article/article-meta';
import { AskLink, type AskTarget } from './article/ask-link';
import { STAND_DOWN, type Docked } from './article/ask-stand-down';
import { ArticleBody } from './article/body';
import { ExternalGlyph } from './article/glyphs';
import { ArticleHeader } from './article/identity';
import { Infobox, hasInfoboxContent } from './article/infobox';
import { articleLayout } from './article/infobox-model';
import { IntentPrefetch } from './article/intent-prefetch';
import { translateMode } from './article/translate-request';

/**
 * The article page.
 *
 * Fandom on a phone buries the numbers under a full-width infobox and a wall
 * of prose. Here the data *is* the page: identity, then stats, then the text.
 * Nobody opens "Iron Sword" to read prose.
 *
 * From 1024px the identity strip runs across the top and the stats either
 * move into a column beside the text, kept in view while it fits the window,
 * or — when they are most of the article — spread over three columns above
 * a text that then has the whole width (`articleLayout`). The text keeps a
 * reading measure either way; tables and pictures take the width there is.
 * Document order is the reading order at every width: the identity, the
 * lead, the stats, the body.
 *
 * Rendered on the server. What runs in the browser is small and specific: the
 * level switcher, the gallery's viewer, the floating "ask" button, the
 * translation request, the sticky infobox and the tables' scroll boxes.
 */
export function ArticleView({
  page,
  lang,
  ask,
  canTranslate,
}: {
  page: ArticlePage;
  lang: Lang;
  ask: AskTarget;
  /** This reader may ask for a translation (their allowance is not switched off). */
  canTranslate: boolean;
}) {
  const t = strings(lang);
  const { article, translation, doc } = page;

  // English shown inside the Spanish interface is marked as English, for the
  // screen readers that voice it and the browsers that hyphenate it; the
  // interface strings inside it are then marked back (I18N-04).
  const contentLang: Lang = lang === 'es' && !translation ? 'en' : lang;
  const uiLang = contentLang === lang ? undefined : lang;

  const linker = buildLinker(page.links, { selfSlug: article.slug });
  // An untranslated article still goes by its Spanish name where it has one,
  // as in the lists and the search: Spanish inside an English article, and
  // marked so.
  const { name, english } = displayTitle(articleTitle(page, lang), article.title);
  const nameLang = uiLang && english ? uiLang : undefined;
  const infobox = hasInfoboxContent(doc.infobox) ? doc.infobox : null;
  const categories = article.categories.filter((category) => !isMaintenanceCategory(category));

  const mode = lang === 'es' ? translateMode(translation) : null;
  const notice = translation ? (
    <TranslationNote
      lang={lang}
      stale={translation.stale}
      partial={translation.partial}
      action={canTranslate && mode ? <TranslateOnView slug={article.slug} lang={lang} mode={mode} /> : null}
    />
  ) : lang === 'es' ? (
    canTranslate ? (
      <TranslateOnView slug={article.slug} lang={lang} mode="missing" />
    ) : (
      <p className="text-sm text-ash">{t.articleUntranslated}</p>
    )
  ) : null;

  // Captions arrive translated where the translation has them; the rest are
  // still the English ones, and say so. A formula the wiki drew as a picture
  // is not a picture of the game: black type on this page's dark ground,
  // named by its TeX source. The parser leaves them out now; rows stored
  // before it did still carry them.
  const sourceImages = article.doc.images;
  const images: GalleryImage[] = doc.images.flatMap((image, i) =>
    image.url.includes(MATH_RENDER)
      ? []
      : [
          {
            url: image.url,
            alt: image.alt,
            caption: image.caption,
            captionLang:
              contentLang === 'es' && image.caption && image.caption === sourceImages[i]?.caption ? 'en' : undefined,
          },
        ],
  );

  // From 1024px: the stats beside the text, or spread above it (`articleLayout`).
  const layout = articleLayout(doc, infobox);
  const side = layout === 'side';
  const docked: Docked = layout === 'side' ? 'sticky' : layout === 'spread' ? 'always' : 'never';

  return (
    <IntentPrefetch lang={contentLang} className="pb-4">
      <ArticleHeader
        name={name}
        nameLang={nameLang}
        english={english}
        doc={doc}
        category={primaryCategory(categories)}
        lang={lang}
        uiLang={uiLang}
        linker={linker}
        notice={notice}
      />

      <div className={`mt-6 lg:mt-8 ${side ? SIDE_GRID : ''}`}>
        {doc.lead ? (
          <p className="max-w-[68ch] text-[1.0625rem] leading-[1.7] text-birch/90 lg:col-start-1 lg:row-start-1">
            <LinkedText text={doc.lead} linker={linker} lines />
          </p>
        ) : null}

        {infobox ? (
          <Infobox
            infobox={infobox}
            lang={lang}
            uiLang={uiLang}
            linker={linker}
            ingredientTargets={page.ingredientTargets}
            recipeSources={page.recipeSources}
            ask={ask}
            layout={side ? 'side' : 'spread'}
            className={`${doc.lead ? 'mt-6' : ''} ${side ? SIDE_INFOBOX : 'lg:mt-8'}`}
          />
        ) : null}

        <div
          className={`flex min-w-0 flex-col gap-10 ${doc.lead || infobox ? 'mt-10' : ''} ${
            !side ? 'lg:mt-12' : doc.lead ? 'lg:col-start-1 lg:row-start-2 lg:mt-8' : 'lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:mt-0'
          }`}
        >
          {doc.blocks.length > 0 ? (
            <ArticleBody
              blocks={doc.blocks}
              sourceBlocks={translation ? article.doc.blocks : undefined}
              linker={linker}
              lang={lang}
              uiLang={uiLang}
            />
          ) : null}
          {images.length > 0 ? <Gallery images={images} lang={lang} uiLang={uiLang} wide={!side} /> : null}
        </div>
      </div>

      <footer lang={uiLang} className="mt-12 flex flex-col gap-4 border-t border-moss pt-6">
        {categories.length > 0 ? (
          <ul aria-label={t.articleCategories} className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <li key={category}>
                <Link
                  href={categoryHref(category)}
                  prefetch={false}
                  lang={lang === 'es' && !hasTermLabel('category', category) ? 'en' : undefined}
                  className="inline-flex min-h-8 items-center rounded-md border border-moss px-3 text-sm text-ash transition-colors hover:border-forge/40 hover:text-birch pointer-coarse:min-h-11"
                >
                  {termLabel('category', category, lang)}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <AskLink
            ask={ask}
            className="inline-flex min-h-8 items-center gap-2 text-sm text-forge underline-offset-4 hover:underline pointer-coarse:min-h-11"
          >
            {t.articleAskInFlow.replace('{name}', name)}
          </AskLink>
          <a
            href={article.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-8 items-center gap-1 font-mono text-xs text-ash underline-offset-4 hover:text-birch hover:underline pointer-coarse:min-h-11"
          >
            {t.wikiSourceLink}
            <ExternalGlyph />
            <span className="sr-only">({t.articleSourceNewTab})</span>
          </a>
        </div>
      </footer>

      {/*
       * Keeps the end of the article clear of the floating button wherever it
       * floats; the frame already clears the tab bar. One spacer, sized to
       * the button: the article used to carry two, 224px of dead end (LM-10).
       */}
      <div aria-hidden="true" className={`h-10 ${STAND_DOWN[docked]}`} />

      <AskButton ask={ask} label={t.wikiAskAbout} docked={docked} lang={uiLang} />
    </IntentPrefetch>
  );
}

/** Where MediaWiki's maths renderer serves its formulas (`article.ts` skips the same). */
const MATH_RENDER = '/media/math/render/';

/** Two columns: the text, and the 22rem infobox column beside it. */
const SIDE_GRID = 'lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_1fr] lg:gap-x-12';

/** The infobox column: beside the lead and the body, pinned below the nav while it fits the window. */
const SIDE_INFOBOX =
  'lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-0 lg:self-start lg:top-[calc(var(--nav-h)+1.5rem)] lg:data-sticky:sticky';

/**
 * Said plainly rather than hidden. This text was translated by a model from
 * an English wiki, and a reader deciding whether to trust a crafting cost
 * deserves to know that before they mine the iron.
 */
function TranslationNote({
  lang,
  stale,
  partial,
  action,
}: {
  lang: Lang;
  stale: boolean;
  partial: boolean;
  action: React.ReactNode;
}) {
  const t = strings(lang);
  const parts = [t.wikiTranslated, stale ? t.wikiTranslationStale : null, partial ? t.articleTranslatedPartial : null];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ash">{parts.filter(Boolean).join(' · ')}</p>
      {action}
    </div>
  );
}
