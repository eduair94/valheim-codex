import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * Rasterises the two hand-drawn brand SVGs into the PNG sizes real install
 * surfaces actually require.
 *
 * `public/icon.svg` and `public/icon-maskable.svg` already satisfy Chrome's
 * installability check (`sizes: "any"`, `type: "image/svg+xml"`) on their
 * own, but iOS's "Add to Home Screen" does not render an SVG apple-touch-icon
 * at all, and Android's install-banner heuristics and other crawlers still
 * look for a concrete raster size. Run with `node scripts/generate-icons.mjs`
 * whenever the source SVGs change; nothing here reads from a live server, so
 * it never needs credentials.
 */

const ROOT = process.cwd();
const publicDir = join(ROOT, 'public');

const icon = readFileSync(join(publicDir, 'icon.svg'));
const iconMaskable = readFileSync(join(publicDir, 'icon-maskable.svg'));

const targets = [
  { src: icon, out: 'icon-192.png', size: 192 },
  { src: icon, out: 'icon-512.png', size: 512 },
  { src: iconMaskable, out: 'icon-512-maskable.png', size: 512 },
  // iOS ignores manifest icons entirely; this is the one it actually reads.
  { src: icon, out: 'apple-touch-icon.png', size: 180 },
  // Legacy fallback for crawlers/browsers that still expect a small PNG
  // favicon rather than the SVG one already registered in `metadata.icons`.
  { src: icon, out: 'favicon-32.png', size: 32 },
];

for (const { src, out, size } of targets) {
  await sharp(src, { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(join(publicDir, out));
  console.log(`wrote public/${out} (${size}x${size})`);
}
