'use client';

import { FANDOM_IMG_PROPS } from '@/lib/wiki/image-url';
import { fandomSources } from './image';

/**
 * When a picture is fetched.
 *
 *   - `lazy`, the default: once it nears the screen. Most pictures here are
 *     tiles and rows further down.
 *   - `eager`: with the page, for one in the first screen.
 *   - `high`: with the page and ahead of the other pictures, for the one most
 *     likely to be the page's largest paint (LCP). A lazy one is found late —
 *     only once layout has placed it — and that was the desktop home's LCP.
 */
export type ImagePriority = 'lazy' | 'eager' | 'high';

/**
 * A picture from the wiki, sized for its slot, for tiles and list rows.
 *
 * A client component for one reason: Fandom's CDN 404s intermittently, and a
 * broken-image glyph inside a plate reads as a bug where an empty plate reads
 * fine — so a failed picture hides itself. React re-assigns `src` when it
 * hydrates an image with an error handler, so this also catches one that
 * failed before the page's script arrived.
 *
 * Decorative (`alt=""`): every one sits next to the name it shows.
 */
export function WikiImage({
  url,
  drawn,
  sizes,
  width,
  height,
  priority = 'lazy',
  className,
}: {
  url: string;
  /** The CSS widths the picture is drawn at; more than one gives it a `srcset`. */
  drawn: readonly number[];
  /** Required with more than one drawn width: which one applies at which screen width. */
  sizes?: string;
  width: number;
  height: number;
  priority?: ImagePriority;
  className?: string;
}) {
  const { src, srcSet } = fandomSources(url, drawn);
  return (
    // Hotlinked from Fandom's CDN at the size it is drawn; not `next/image`.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...FANDOM_IMG_PROPS}
      src={src}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt=""
      width={width}
      height={height}
      loading={priority === 'lazy' ? 'lazy' : 'eager'}
      fetchPriority={priority === 'high' ? 'high' : undefined}
      onError={(event) => {
        event.currentTarget.style.display = 'none';
      }}
      className={className}
    />
  );
}
