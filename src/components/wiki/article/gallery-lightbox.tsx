'use client';

import Lightbox, { type SlideImage } from 'yet-another-react-lightbox';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/captions.css';
import 'yet-another-react-lightbox/plugins/counter.css';
import { useStrings } from '@/components/shell/lang-context';
import { FANDOM_IMG_PROPS } from '@/lib/wiki/image-url';
import type { Lang } from '@/lib/i18n/strings';

/**
 * The full-screen viewer, in a module of its own so that it is only
 * downloaded once someone opens an image (PERF-10). A third of the articles
 * have no pictures at all, and on the rest the viewer and its stylesheet were
 * 16 KB of script and 7 KB of render-blocking CSS on every view for a tap
 * most readers never make.
 *
 * `yet-another-react-lightbox` rather than a hand-rolled dialog, for the parts
 * that are genuinely hard: pinch and double-tap zoom, panning a zoomed image,
 * swiping between images on a phone, focus trapping, and restoring focus to
 * the thumbnail on close.
 */
export default function GalleryLightbox({
  slides,
  index,
  open,
  onClose,
  lang,
}: {
  slides: SlideImage[];
  index: number;
  open: boolean;
  onClose: () => void;
  lang: Lang;
}) {
  const t = useStrings(lang);
  return (
    <Lightbox
      open={open}
      index={index}
      close={onClose}
      slides={slides}
      plugins={[Zoom, Captions, Counter]}
      carousel={{
        // One image is not a carousel; hide the arrows rather than show two
        // dead controls.
        finite: slides.length <= 1,
        // The library draws its own image element: without these the
        // full-size picture went out with a Referer, which Fandom answers
        // with a grey placeholder.
        imageProps: { referrerPolicy: FANDOM_IMG_PROPS.referrerPolicy, decoding: FANDOM_IMG_PROPS.decoding },
      }}
      controller={{ closeOnBackdropClick: true }}
      // Some wiki images are genuinely small even at full size — sprites are
      // 64px — so allow scaling past 1:1 rather than showing a stamp.
      zoom={{ maxZoomPixelRatio: 4, doubleTapDelay: 250 }}
      captions={{ descriptionTextAlign: 'center' }}
      labels={{
        Lightbox: t.articleViewer,
        'Photo gallery': t.articleViewerGallery,
        Carousel: t.articleViewerGallery,
        Slide: t.articleViewerSlide,
        '{index} of {total}': t.articleViewerPosition,
        Previous: t.articleViewerPrevious,
        Next: t.articleViewerNext,
        Close: t.articleViewerClose,
        'Zoom in': t.articleViewerZoomIn,
        'Zoom out': t.articleViewerZoomOut,
        Caption: t.articleViewerCaption,
      }}
      styles={{
        /*
         * Opaque, and in the palette. The library's default is a neutral
         * black, which drops a cold rectangle into a deliberately warm page;
         * its default is also translucent, which left the article's own
         * headings legible behind the photo and competing with it.
         *
         * The page is drawn under a notch and a home indicator
         * (`viewport-fit=cover`), and the viewer is fixed to the whole
         * screen, so its controls keep clear of both themselves (LM-09):
         * the toolbar and the counter below the status bar, the arrows
         * inside a landscape notch, the caption above the home indicator.
         *
         * The counter is not a button, so the button styles below never
         * reached it: it kept the library's near-white text under a black
         * drop shadow. It reads its own variables, set here to the buttons'
         * ash with no shadow.
         */
        root: {
          '--yarl__toolbar_padding': 'max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) 8px 8px',
          '--yarl__counter_margin': 'max(8px, env(safe-area-inset-top)) 8px 8px max(8px, env(safe-area-inset-left))',
          '--yarl__counter_color': 'var(--color-ash)',
          '--yarl__counter_filter': 'none',
          '--yarl__slide_captions_container_padding':
            '12px max(16px, env(safe-area-inset-right)) max(20px, calc(env(safe-area-inset-bottom) + 12px)) max(16px, env(safe-area-inset-left))',
        },
        container: { backgroundColor: 'var(--color-bog)' },
        button: { color: 'var(--color-ash)', filter: 'none' },
        navigationPrev: { color: 'var(--color-ash)', left: 'env(safe-area-inset-left)' },
        navigationNext: { color: 'var(--color-ash)', right: 'env(safe-area-inset-right)' },
        captionsDescriptionContainer: { backgroundColor: 'color-mix(in srgb, var(--color-bog) 88%, transparent)' },
        captionsDescription: {
          color: 'var(--color-birch)',
          fontFamily: 'var(--font-body)',
          fontSize: '0.875rem',
        },
      }}
    />
  );
}
