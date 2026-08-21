/**
 * Turns a Fandom thumbnail URL into the full-resolution original.
 *
 * The wiki serves images through a resizing path — `.../Biome_ashlands.png/
 * revision/latest/scale-to-width-down/268?cb=...` — and that is what the ingest
 * stores, because it is the right thing for a grid: 18 KB instead of 162 KB.
 *
 * It is the wrong thing for a lightbox. Opening a 268px image full screen on a
 * 390px phone showed it at 185px, which is smaller than the thumbnail grid it
 * was opened from and makes the whole gesture pointless. Dropping the resizing
 * segment asks the same CDN for the same file at its original size.
 *
 * Anything that is not a Fandom resizing URL comes back untouched, so a
 * non-Fandom source, or a URL whose shape changes later, degrades to showing
 * the image the reader already had rather than to a broken link.
 */

/** `/scale-to-width-down/268`, `/scale-to-width/500`, `/scale-to-height/300`, `/thumbnail/width/200`. */
const RESIZE_SEGMENT = /\/(?:scale-to-(?:width|height)(?:-down)?|thumbnail\/width|window-crop)\/[0-9]+(?:\/[0-9]+)?/;

export function fullSizeImageUrl(url: string): string {
  if (!url.includes('wikia.nocookie.net')) return url;
  return url.replace(RESIZE_SEGMENT, '');
}

/** `.../Iron.png/revision/latest?cb=1` — where the resizing segment belongs. */
const REVISION = /\/revision\/latest/;

/**
 * Asks the CDN for an image at roughly the size it will be drawn.
 *
 * The same resizing path that had to be stripped for the lightbox is what a
 * grid of 32px icons wants. Asked for at twice the drawn size, so it stays
 * sharp on a retina screen.
 *
 * Worth roughly 10%, measured over forty icons: 98.5 KB against 88.4 KB, with
 * none coming back larger. Not the saving it looks like it should be, because
 * most of these sprites are already a couple of kilobytes and Fandom returns
 * them unchanged. The gain is concentrated in the few that are not — a charred
 * warrior went from 17.9 KB to 2 KB — and those are exactly the ones that would
 * otherwise stall a recipe on a slow connection.
 *
 * A URL that already carries a resizing segment, or that is not from Fandom,
 * is returned untouched: better the image the reader would have had than a
 * URL assembled from a guess about someone else's CDN.
 */
export function thumbnailImageUrl(url: string, width: number): string {
  if (!url.includes('wikia.nocookie.net')) return url;
  if (RESIZE_SEGMENT.test(url)) return url;
  if (!REVISION.test(url)) return url;

  return url.replace(REVISION, `/revision/latest/scale-to-width-down/${Math.round(width * 2)}`);
}
