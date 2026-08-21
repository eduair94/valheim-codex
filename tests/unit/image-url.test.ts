import { describe, expect, it } from 'vitest';
import { fullSizeImageUrl, thumbnailImageUrl } from '@/lib/wiki/image-url';

/**
 * Opening a 268px thumbnail full screen on a 390px phone rendered it at 185px
 * — smaller than the grid it was opened from. The stored URL is a resizing
 * URL, and the fix is to stop asking for the small one.
 */
describe('fullSizeImageUrl', () => {
  it.each([
    [
      'https://static.wikia.nocookie.net/valheim/images/5/56/Biome.png/revision/latest/scale-to-width-down/268?cb=1',
      'https://static.wikia.nocookie.net/valheim/images/5/56/Biome.png/revision/latest?cb=1',
    ],
    [
      'https://static.wikia.nocookie.net/valheim/images/a/ab/X.png/revision/latest/scale-to-width/500',
      'https://static.wikia.nocookie.net/valheim/images/a/ab/X.png/revision/latest',
    ],
    [
      'https://static.wikia.nocookie.net/valheim/images/a/ab/X.png/revision/latest/thumbnail/width/200',
      'https://static.wikia.nocookie.net/valheim/images/a/ab/X.png/revision/latest',
    ],
  ])('drops the resizing segment', (thumb, full) => {
    expect(fullSizeImageUrl(thumb)).toBe(full);
  });

  it('leaves an already-full URL alone', () => {
    const url = 'https://static.wikia.nocookie.net/valheim/images/c/c7/Iron_Sword.png/revision/latest?cb=2';
    expect(fullSizeImageUrl(url)).toBe(url);
  });

  it('leaves a non-Fandom URL alone', () => {
    // Degrading to the image the reader already had beats a broken link.
    const url = 'https://example.test/scale-to-width-down/268/pic.png';
    expect(fullSizeImageUrl(url)).toBe(url);
  });
});

describe('thumbnailImageUrl', () => {
  /**
   * A recipe draws four icons at 32px. Serving four 300px sprites to do it is
   * most of a page's bandwidth spent on pixels nobody sees, on a phone.
   */
  it('asks for twice the drawn size, for a retina screen', () => {
    expect(
      thumbnailImageUrl(
        'https://static.wikia.nocookie.net/valheim/images/c/c7/Iron.png/revision/latest?cb=2',
        32,
      ),
    ).toBe(
      'https://static.wikia.nocookie.net/valheim/images/c/c7/Iron.png/revision/latest/scale-to-width-down/64?cb=2',
    );
  });

  it('leaves a URL that is already sized alone', () => {
    const url =
      'https://static.wikia.nocookie.net/valheim/images/c/c7/Iron.png/revision/latest/scale-to-width-down/268?cb=2';
    expect(thumbnailImageUrl(url, 32)).toBe(url);
  });

  it('leaves a non-Fandom URL alone', () => {
    // Assembling a URL from a guess about someone else's CDN breaks the image.
    const url = 'https://example.test/pic.png';
    expect(thumbnailImageUrl(url, 32)).toBe(url);
  });
});
