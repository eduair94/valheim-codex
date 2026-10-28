import type { MetadataRoute } from 'next';
import { CRAFT_PLANNER_LIVE } from '@/lib/craft/feature';
import { strings } from '@/lib/i18n/strings';

/**
 * The install manifest.
 *
 * A typed route rather than the static `public/manifest.webmanifest` this
 * replaces, so a bad icon path or a typo'd enum value is a build error
 * instead of a manifest Chrome silently ignores. Next serves this at the
 * exact same `/manifest.webmanifest` URL, so nothing else — `layout.tsx`'s
 * `metadata.manifest`, `proxy.ts`'s matcher, `sw.js`'s precache list — needed
 * to change.
 *
 * `lang` is fixed to `es` rather than following the `en`/`es` toggle: a
 * manifest is generated once at build time, not per request, and browsers
 * fetch it without cookies anyway, so it cannot know the reader's choice.
 * Spanish is the app's default (what the root layout's `<html lang>` falls
 * back to without a cookie), which is what an installed icon's OS-level name
 * should match. Its words come from the same Spanish copy as the app's, so
 * the two cannot drift apart.
 */
export default function manifest(): MetadataRoute.Manifest {
  const t = strings('es');
  return {
    name: t.appName,
    short_name: 'Codex',
    description: t.shellAppDescription,
    start_url: '/wiki',
    id: '/wiki',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui', 'browser'],
    /*
     * Not locked to portrait: several tables in the wiki (crafting costs,
     * boss stats) are wide, and an installed app is exactly where a reader
     * can't fall back to a browser chrome that ignores the lock. Rotating to
     * read a table sideways should work, not fight the manifest.
     */
    orientation: 'any',
    background_color: '#14170F',
    theme_color: '#14170F',
    lang: 'es',
    categories: ['reference', 'games'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: t.wikiSearch, url: '/wiki', description: t.shellShortcutSearch },
      ...(CRAFT_PLANNER_LIVE ? [{ name: t.shellCraft, url: '/wiki/craft', description: t.shellShortcutCraft }] : []),
      { name: t.wikiGuideTitle, url: '/wiki/guide', description: t.shellShortcutGuide },
      { name: t.wikiBrowse, url: '/wiki/browse', description: t.shellShortcutBrowse },
    ],
  };
}
