import type { Metadata, Viewport } from 'next';
import { Cinzel, JetBrains_Mono, Spectral } from 'next/font/google';
import './globals.css';

/*
 * Cinzel: Roman inscriptional capitals — carved stone, used only for the app
 * name and section labels. Spectral: a serif drawn for screen reading, which
 * keeps long wiki answers warm without tiring. JetBrains Mono: crafting
 * quantities and citation markers, where digits genuinely need to align.
 */
const cinzel = Cinzel({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-cinzel' });
const spectral = Spectral({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-spectral',
});
const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains',
});

const SITE_URL = 'https://valheim.digitalshopuy.com';
const DESCRIPTION = 'Preguntas sobre Valheim respondidas desde la wiki, con la fuente a la vista.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Valheim Codex',
  description: DESCRIPTION,
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Codex', statusBarStyle: 'black-translucent' },
  icons: {
    // The SVG first: every current browser prefers a vector favicon and
    // scales it correctly at any tab/bookmark size. The PNG is the fallback
    // for the crawlers and older browsers that don't look past the first
    // format they don't recognise.
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
    ],
    // iOS's "Add to Home Screen" does not read the manifest at all, and
    // does not accept an SVG here — this is the one icon reference it does
    // read, and it must be a raster image.
    apple: '/apple-touch-icon.png',
  },
  /*
   * Site-wide social preview. `openGraph.images` is deliberately left unset:
   * `src/app/opengraph-image.tsx` is picked up automatically for every route
   * that doesn't render its own, which `wiki/a/[slug]` and `wiki/guide` do —
   * setting `images` here would block that file-based image from merging in.
   */
  openGraph: {
    type: 'website',
    siteName: 'Valheim Codex',
    title: 'Valheim Codex',
    description: DESCRIPTION,
    locale: 'es_ES',
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Valheim Codex',
    description: DESCRIPTION,
  },
  other: {
    // The non-Apple counterpart of `appleWebApp.capable` — Chrome on Android
    // and other Chromium browsers read this one, not the `apple-*` tag.
    'mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  themeColor: '#14170F',
  // The app is installed to a home screen and read one-handed; pinch-zoom
  // stays enabled because disabling it fails an accessibility expectation for
  // anyone who needs larger text.
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${cinzel.variable} ${spectral.variable} ${jetbrains.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
