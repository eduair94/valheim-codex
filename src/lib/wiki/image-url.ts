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
