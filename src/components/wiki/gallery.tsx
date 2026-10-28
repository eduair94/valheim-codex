'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { SlideImage } from 'yet-another-react-lightbox';
import { useStrings } from '@/components/shell/lang-context';
import { FANDOM_IMG_PROPS, fullSizeImageUrl, thumbnailImageUrl } from '@/lib/wiki/image-url';
import type { Lang } from '@/lib/i18n/strings';

/** Downloaded the first time an image is opened, or a thumbnail is about to be. */
const loadLightbox = () => import('./article/gallery-lightbox');
const GalleryLightbox = dynamic(loadLightbox, { ssr: false });

export type GalleryImage = {
  url: string;
  alt: string;
  caption?: string;
  /** Set when the caption is in another language than the page around it. */
  captionLang?: string;
};

/** The widths a thumbnail is offered at; the browser picks by slot and screen density. */
const THUMB_WIDTHS = [240, 480] as const;

/** A Fandom picture at about `width` pixels, from the original rather than from a smaller copy. */
function sized(url: string, width: number): string {
  // `thumbnailImageUrl` asks for twice the size it is given, for density.
  return thumbnailImageUrl(fullSizeImageUrl(url), width / 2);
}

/**
 * The article's screenshots, openable full screen.
 *
 * These are the one thing on the page a thumbnail cannot do justice to: a
 * screenshot of a copper deposit at 128px tall is a green smudge, and the
 * whole reason it is on the page is to show what the deposit looks like in
 * the world. So the grid is a set of buttons rather than pictures.
 *
 * Thumbnails are cut from the original at the size of their slot. The stored
 * address is a 185px copy, which a 233px desktop slot drew blurred (LD-19);
 * and a picture smaller than its slot is shown at its own size, centred,
 * never stretched.
 *
 * The cells of a row share its height, so a long caption does not leave the
 * picture beside it with a ragged edge (LM-18), and every picture box is
 * exactly 4:3: a portrait screenshot is fitted inside it rather than
 * stretching it, which pushed its caption below its neighbours'.
 *
 * Each button is named by what it shows, "Ver imagen completa: <caption>",
 * from its content rather than an `aria-label`, so that each part carries its
 * own language: an English caption inside the Spanish interface is marked as
 * English, and the interface's words around it as Spanish (I18N-04).
 */
export function Gallery({
  images,
  lang,
  uiLang,
  wide = false,
}: {
  images: GalleryImage[];
  lang: Lang;
  /** Set when the article is in another language than the interface. */
  uiLang?: Lang;
  wide?: boolean;
}) {
  const t = useStrings(lang);
  // -1 rather than a separate boolean: the index *is* the state, and two
  // pieces of state that must agree are one bug waiting to be written.
  const [open, setOpen] = useState(-1);
  // Mounted once opened, and kept, so closing plays the viewer's fade.
  const [mounted, setMounted] = useState(false);

  if (images.length === 0) return null;
  const shown = images.slice(0, 12);

  const slides: SlideImage[] = shown.map((image) => ({
    // The grid keeps the thumbnail; full screen deserves the original.
    src: fullSizeImageUrl(image.url),
    alt: image.alt || image.caption || '',
    description: image.caption ? <span lang={image.captionLang}>{image.caption}</span> : undefined,
  }));

  const sizes = wide
    ? '(min-width: 1024px) 17rem, (min-width: 640px) 33vw, 50vw'
    : '(min-width: 1024px) 15rem, (min-width: 640px) 33vw, 50vw';

  const warm = (): void => {
    void loadLightbox();
  };

  return (
    <section>
      <h2 lang={uiLang} className="label mb-2">
        {t.wikiGallery}
      </h2>

      <ul
        className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${wide ? 'lg:grid-cols-4' : ''}`}
        onPointerOver={warm}
        onFocus={warm}
      >
        {shown.map((image, i) => {
          // The caption names the picture; without one, its alt text does,
          // and without either, its place in the set ("Imagen 3"), which is
          // interface copy.
          const alt = image.caption ? '' : image.alt || t.articleImage.replace('{n}', String(i + 1));
          return (
            <li key={image.url}>
              <button
                type="button"
                onClick={() => {
                  setMounted(true);
                  setOpen(i);
                }}
                className="group flex h-full w-full flex-col overflow-hidden rounded-md border border-moss bg-peat text-left transition-colors hover:border-forge/60"
              >
                <span lang={uiLang} className="sr-only">
                  {`${t.wikiOpenImage}: `}
                </span>
                <span className="flex aspect-4/3 min-h-0 w-full shrink-0 items-center justify-center overflow-hidden p-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    {...FANDOM_IMG_PROPS}
                    src={sized(image.url, THUMB_WIDTHS[0])}
                    srcSet={THUMB_WIDTHS.map((w) => `${sized(image.url, w)} ${w}w`).join(', ')}
                    sizes={sizes}
                    alt={alt}
                    lang={!image.caption && !image.alt ? uiLang : undefined}
                    loading="lazy"
                    className="max-h-full max-w-full object-contain transition-transform duration-200 group-hover:scale-[1.03]"
                  />
                </span>
                {image.caption ? (
                  <span lang={image.captionLang} className="block flex-1 border-t border-moss px-2 py-1 text-xs leading-snug text-ash">
                    {image.caption}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      {mounted ? (
        <GalleryLightbox slides={slides} index={Math.max(open, 0)} open={open >= 0} onClose={() => setOpen(-1)} lang={lang} />
      ) : null}
    </section>
  );
}
