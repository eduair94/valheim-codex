import type { MetadataRoute } from 'next';

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
 * manifest is generated once at build time, not per request, so it cannot
 * read the language cookie. Spanish is the app's default (`<html lang="es">`
 * in the root layout), which is what an installed icon's OS-level name
 * should match.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Valheim Codex',
    short_name: 'Codex',
    description: 'Wiki de Valheim y asistente, para consultar a mitad de partida.',
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
      { name: 'Buscar', url: '/wiki', description: 'Buscar un objeto, criatura o bioma' },
      { name: 'Guía 100%', url: '/wiki/guide', description: 'Checklist de finalización, bioma por bioma' },
      { name: 'Explorar', url: '/wiki/browse', description: 'Biomas, categorías y estaciones' },
    ],
  };
}
