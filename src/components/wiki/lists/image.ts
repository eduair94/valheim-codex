import { thumbnailImageUrl } from '@/lib/wiki/image-url';

/**
 * The URLs to ask Fandom's CDN for, for a picture drawn at several sizes.
 *
 * `thumbnailImageUrl` asks for twice the drawn width and never more than the
 * stored size. A picture drawn at one size gets one URL. A picture whose slot
 * changes with the screen — a biome is a 64px plate on a phone and a 266px
 * card on a desktop — gets a `srcset`, so a phone downloads the plate's few
 * kilobytes and not the card's: one URL for both was either blurry on the
 * desktop or four times the bytes on the phone.
 *
 * The `w` descriptors are the widths the resizer was asked for, read back out
 * of each URL; when a URL carries none (a CDN shape this does not know), the
 * picture keeps a single `src`, which is what it had before.
 */
export function fandomSources(url: string, drawn: readonly number[]): { src: string; srcSet?: string } {
  const largest = Math.max(...drawn);
  const src = thumbnailImageUrl(url, largest);
  if (drawn.length < 2) return { src };

  const candidates = new Map<string, number>();
  for (const width of drawn) {
    const candidate = thumbnailImageUrl(url, width);
    const actual = /\/scale-to-width-down\/([0-9]+)/.exec(candidate)?.[1];
    if (!actual) return { src };
    candidates.set(candidate, Number(actual));
  }
  if (candidates.size < 2) return { src };

  const srcSet = [...candidates]
    .sort((a, b) => a[1] - b[1])
    .map(([candidate, width]) => `${candidate} ${width}w`)
    .join(', ');
  return { src, srcSet };
}
