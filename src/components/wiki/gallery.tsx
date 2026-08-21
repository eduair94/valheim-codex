'use client';

import { useState } from 'react';
import Lightbox from 'yet-another-react-lightbox';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/captions.css';
import 'yet-another-react-lightbox/plugins/counter.css';
import type { ArticleImage } from '@/lib/wiki/article-types';
import { fullSizeImageUrl } from '@/lib/wiki/image-url';
import { strings, type Lang } from '@/lib/i18n/strings';

/**
 * The article's screenshots, openable full screen.
 *
 * These are the one thing on the page a thumbnail cannot do justice to: a
 * screenshot of a copper deposit at 128px tall is a green smudge, and the
 * whole reason it is on the page is to show what the deposit looks like in
 * the world. So the grid is a set of buttons rather than pictures.
 *
 * `yet-another-react-lightbox` rather than a hand-rolled dialog, for the parts
 * that are genuinely hard: pinch and double-tap zoom, panning a zoomed image,
 * swiping between images on a phone, focus trapping, and restoring focus to
 * the thumbnail on close. A `<dialog>` with a big `<img>` is fifty lines and
 * gets none of that right on the device this reader is mostly used on.
 */
export function Gallery({ images, lang }: { images: ArticleImage[]; lang: Lang }) {
  const t = strings(lang);
  // -1 rather than a separate boolean: the index *is* the state, and two
  // pieces of state that must agree are one bug waiting to be written.
  const [open, setOpen] = useState(-1);

  if (images.length === 0) return null;
  const shown = images.slice(0, 12);

  return (
    <section className="mt-8">
      <h2 className="label mb-2">{t.wikiGallery}</h2>

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shown.map((image, i) => (
          <li key={image.url}>
            <button
              type="button"
              onClick={() => setOpen(i)}
              aria-label={`${t.wikiOpenImage}: ${image.caption || image.alt || i + 1}`}
              className="group block w-full overflow-hidden rounded-md border border-moss bg-peat text-left transition-colors hover:border-forge/60"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.alt || image.caption || ''}
                loading="lazy"
                className="h-32 w-full object-contain p-1 transition-transform duration-200 group-hover:scale-[1.03]"
              />
              {image.caption ? (
                <span className="block border-t border-moss px-2 py-1 text-[0.68rem] text-ash">
                  {image.caption}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      <Lightbox
        open={open >= 0}
        index={Math.max(open, 0)}
        close={() => setOpen(-1)}
        slides={shown.map((image) => ({
          // The grid keeps the thumbnail; full screen deserves the original.
          src: fullSizeImageUrl(image.url),
          alt: image.alt || image.caption || '',
          description: image.caption,
        }))}
        plugins={[Zoom, Captions, Counter]}
        // One image is not a carousel; hide the arrows rather than show two
        // dead controls.
        carousel={{ finite: shown.length <= 1 }}
        controller={{ closeOnBackdropClick: true }}
        // Some wiki images are genuinely small even at full size — sprites are
        // 64px — so allow scaling past 1:1 rather than showing a stamp.
        zoom={{ maxZoomPixelRatio: 4, doubleTapDelay: 250 }}
        captions={{ descriptionTextAlign: 'center' }}
        styles={{
          // The library's default is a neutral black that would put a cold
          // rectangle in the middle of a deliberately warm palette.
          container: { backgroundColor: 'color-mix(in srgb, var(--color-bog) 94%, transparent)' },
          captionsDescription: {
            backgroundColor: 'transparent',
            color: 'var(--color-birch)',
            fontFamily: 'var(--font-body)',
          },
        }}
      />
    </section>
  );
}
