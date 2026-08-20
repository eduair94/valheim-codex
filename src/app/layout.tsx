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

export const metadata: Metadata = {
  title: 'Valheim Codex',
  description: 'Preguntas sobre Valheim respondidas desde la wiki, con la fuente a la vista.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Codex', statusBarStyle: 'black-translucent' },
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
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
