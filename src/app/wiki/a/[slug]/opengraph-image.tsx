import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { getDb } from '@/lib/db/client';
import { getArticleBySlug } from '@/lib/db/wiki-repo';

export const alt = 'Valheim Codex';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const BOG = '#14170F';
const MOSS = '#2A3120';
const FORGE = '#D98A34';
const BIRCH = '#E8E2D0';
const ASH = '#9AA089';

const cinzel = readFile(join(process.cwd(), 'public/fonts/Cinzel-SemiBold.ttf'));
const spectral = readFile(join(process.cwd(), 'public/fonts/Spectral-Regular.ttf'));

/*
 * A share of this article's link should show the article, not a repeat of
 * the site's own name — that's what makes a preview worth a click over a
 * plain-text URL. Falls back to the site card when the slug is gone (a
 * removed article, or a crawler that got here before the page 404s).
 */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [db, cinzelData, spectralData] = await Promise.all([getDb(), cinzel, spectral]);
  const article = await getArticleBySlug(db, slug);

  const title = article?.title ?? 'Valheim Codex';
  const category = article?.categories?.[0] ?? null;
  // A long title needs a smaller size to fit three lines without spilling
  // past the card; a short one is worth setting bigger.
  const titleSize = title.length > 60 ? 58 : title.length > 32 ? 72 : 88;

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
            <div
              style={{
                display: 'flex',
                fontFamily: 'Spectral',
                fontSize: 28,
                color: FORGE,
                marginBottom: 18,
              }}
            >
              {category}
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
            {title}
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Cinzel', data: cinzelData, style: 'normal', weight: 600 },
        { name: 'Spectral', data: spectralData, style: 'normal', weight: 400 },
      ],
    },
  );
}
