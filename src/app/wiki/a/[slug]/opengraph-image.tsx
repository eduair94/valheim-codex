import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { articleTitle, displayTitle, primaryCategory } from '@/components/wiki/article/article-meta';
import { getArticlePage } from '@/lib/wiki/data';
import { isSlug } from '@/lib/wiki/slug';
import { termLabel } from '@/lib/i18n/terms';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * Only used where a page does not name the card itself. The article page
 * does, with an alternative text that says which article the card is of
 * (`generateMetadata` in `page.tsx`): a file route can state one text for
 * every article, and stating one per article from here
 * (`generateImageMetadata`) moved the card to a new address, which broke
 * every preview already shared.
 */
export const alt = 'Valheim Codex';

const BOG = '#14170F';
const MOSS = '#2A3120';
const FORGE = '#D98A34';
const BIRCH = '#E8E2D0';
const ASH = '#9AA089';

/**
 * Link previews are drawn in Spanish, the site's default: the crawlers that
 * fetch them send no language cookie, and a preview that changed language
 * with whoever happened to share it could not be cached.
 */
const LANG = 'es';

/**
 * A real article's card changes only when its title or category does, which
 * is rare; a day fresh and a week stale keeps crawlers and the CDN from
 * re-rendering it on every share, while a translation that lands later still
 * reaches the card within a day (SEC-08).
 */
const CARD_CACHE = 'public, max-age=86400, stale-while-revalidate=604800';

/**
 * Nothing to draw. Answered without rendering, and remembered for an hour, so
 * a crawler or a typo cannot make the server draw a card per address (SEC-08).
 */
const MISSING_CACHE = 'public, max-age=3600';

const cinzel = readFile(join(process.cwd(), 'public/fonts/Cinzel-SemiBold.ttf'));
const spectral = readFile(join(process.cwd(), 'public/fonts/Spectral-Regular.ttf'));

/*
 * A share of this article's link should show the article, not a repeat of
 * the site's own name — that's what makes a preview worth a click over a
 * plain-text URL.
 */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = isSlug(slug) ? await getArticlePage(slug, LANG) : null;
  if (!page) return new Response(null, { status: 404, headers: { 'Cache-Control': MISSING_CACHE } });

  const [cinzelData, spectralData] = await Promise.all([cinzel, spectral]);
  // The name the article goes by in Spanish, as on its page: an untranslated
  // one's from the names the lists use (`articleTitle`).
  const { name, english } = displayTitle(articleTitle(page, LANG), page.article.title);
  const category = primaryCategory(page.article.categories);
  // A long title needs a smaller size to fit three lines without spilling
  // past the card; a short one is worth setting bigger.
  const titleSize = name.length > 60 ? 58 : name.length > 32 ? 72 : 88;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: BOG,
          padding: 72,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <svg width={56} height={56} viewBox="0 0 512 512">
            <rect width="512" height="512" rx="96" fill={MOSS} />
            <g stroke={FORGE} strokeWidth="34" strokeLinecap="round" fill="none">
              <path d="M176 96 V416" />
              <path d="M176 150 L336 104" />
              <path d="M176 252 L316 208" />
            </g>
          </svg>
          <div
            style={{
              display: 'flex',
              fontFamily: 'Cinzel',
              fontSize: 26,
              letterSpacing: 4,
              textTransform: 'uppercase',
              color: ASH,
            }}
          >
            Valheim Codex
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {category ? (
            <div style={{ display: 'flex', fontFamily: 'Spectral', fontSize: 28, color: FORGE, marginBottom: 18 }}>
              {termLabel('category', category, LANG)}
            </div>
          ) : null}
          <div
            style={{
              display: 'flex',
              fontFamily: 'Cinzel',
              fontWeight: 600,
              fontSize: titleSize,
              lineHeight: 1.15,
              color: BIRCH,
              maxWidth: 1000,
            }}
          >
            {name}
          </div>
          {english ? (
            <div style={{ display: 'flex', fontFamily: 'Spectral', fontSize: 32, color: ASH, marginTop: 16 }}>
              {english}
            </div>
          ) : null}
        </div>
      </div>
    ),
    {
      ...size,
      headers: { 'Cache-Control': CARD_CACHE },
      fonts: [
        { name: 'Cinzel', data: cinzelData, style: 'normal', weight: 600 },
        { name: 'Spectral', data: spectralData, style: 'normal', weight: 400 },
      ],
    },
  );
}
