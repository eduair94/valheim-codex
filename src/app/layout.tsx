import type { Metadata, Viewport } from 'next';
import { Cinzel, JetBrains_Mono, Spectral } from 'next/font/google';
import { cookies } from 'next/headers';
import { HashHistory } from '@/components/shell/hash-history';
import { LangProvider } from '@/components/shell/lang-context';
import { NavProgress } from '@/components/shell/nav-progress';
import { InstallCaptureScript } from '@/components/wiki/install-capture-script';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings } from '@/lib/i18n/strings';
import { SITE_URL, siteOpenGraph } from '@/lib/site';
import './globals.css';

/*
 * Cinzel: Roman inscriptional capitals — carved stone, used only for the app
 * name and titles. Spectral: a serif drawn for screen reading, which keeps
 * long wiki answers warm without tiring. JetBrains Mono: crafting quantities,
 * labels and citation markers, where digits genuinely need to align.
 *
 * Only what the first paint needs is preloaded. Root-layout preloads go out on
 * every route, and six of them (116 KB, Spectral 300 included, which nothing
 * used) shared the start of a slow connection with the stylesheet and held back
 * the first paint. Now: Spectral's three weights, because body text is most of
 * every page, and Cinzel's one variable file, because an article's title is
 * above the fold in it. JetBrains Mono waits for the stylesheet to ask.
 *
 * Measured on a throttled phone rather than assumed: with its face blocked,
 * next/font's size-matched fallback stands in for Spectral and JetBrains Mono
 * without moving a pixel, but not for Cinzel: the fallback sets tracked
 * capitals wider than Cinzel does, so a title painted in it took three lines
 * instead of two, and the page jumped when the real face landed.
 */
const cinzel = Cinzel({
  subsets: ['latin'],
  weight: ['500', '600'],
  variable: '--font-cinzel',
});
const spectral = Spectral({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-spectral',
});
const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains',
  preload: false,
});

async function requestLang() {
  return parseLang((await cookies()).get(LANG_COOKIE)?.value);
}

export async function generateMetadata(): Promise<Metadata> {
  const lang = await requestLang();
  const t = strings(lang);
  return {
    metadataBase: new URL(SITE_URL),
    title: t.appName,
    description: t.shellMetaDescription,
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
     * Site-wide social preview. Only what is true of every page is set here.
     *
     * Next fills og:title, og:description and the Twitter pair from each
     * page's own title and description, unless a layout sets them; setting
     * them here pinned every article's preview to the site's name and
     * tagline, and `url: '/'` made every shared article point at the home
     * page. Pages that want a canonical URL set it themselves.
     *
     * `openGraph.images` is deliberately left unset: `src/app/opengraph-image.tsx`
     * is picked up automatically for every route that doesn't render its own,
     * which `wiki/a/[slug]` and `wiki/guide` do — setting `images` here would
     * block that file-based image from merging in.
     *
     * The site's fields come from `siteOpenGraph`, which the pages that set
     * their own `openGraph` (and so replace this one) share. The locale
     * follows the page's language; crawlers send no cookie and read Spanish.
     */
    openGraph: siteOpenGraph('website', lang),
    twitter: {
      card: 'summary_large_image',
    },
    other: {
      // The non-Apple counterpart of `appleWebApp.capable` — Chrome on Android
      // and other Chromium browsers read this one, not the `apple-*` tag.
      'mobile-web-app-capable': 'yes',
    },
  };
}

export const viewport: Viewport = {
  themeColor: '#14170F',
  // The app is installed to a home screen and read one-handed; pinch-zoom
  // stays enabled because disabling it fails an accessibility expectation for
  // anyone who needs larger text.
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

/**
 * `<html lang>` follows the reader's language. Hard-coded to Spanish, it had
 * screen readers voicing the whole English interface with Spanish
 * pronunciation. Every page reads cookies already, so this makes nothing
 * dynamic that was not.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await requestLang();
  return (
    <html lang={lang} className={`${cinzel.variable} ${spectral.variable} ${jetbrains.variable}`}>
      <body className="antialiased">
        {/*
         * A plain inline script, so it runs while the HTML is parsed (see
         * `InstallCaptureScript`). It is here rather than in the reader's frame
         * so client-side navigation never renders it again; it takes the install
         * offer only while the reader is on screen.
         */}
        <InstallCaptureScript />
        <HashHistory />
        <NavProgress />
        {/*
         * The language's copy table goes to the browser here, once per page,
         * for every Client Component below (`useStrings`).
         */}
        <LangProvider lang={lang} strings={strings(lang)}>
          {children}
        </LangProvider>
      </body>
    </html>
  );
}
