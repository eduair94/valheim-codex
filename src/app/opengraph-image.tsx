import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

export const alt = 'Valheim Codex';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/*
 * Same palette as `public/icon.svg` and `globals.css`'s `@theme` block,
 * copied as literal hex rather than imported: Satori (what `ImageResponse`
 * renders through) reads inline styles, not the app's CSS custom properties.
 */
const BOG = '#14170F';
const MOSS = '#2A3120';
const FORGE = '#D98A34';
const BIRCH = '#E8E2D0';
const ASH = '#9AA089';

// Read once at module scope — this route is fully static (no params), so
// Next renders it a single time at build and serves the PNG from then on.
const cinzel = readFile(join(process.cwd(), 'public/fonts/Cinzel-SemiBold.ttf'));
const spectral = readFile(join(process.cwd(), 'public/fonts/Spectral-Regular.ttf'));

/** The Fehu rune from `icon.svg`, at its own viewBox so it drops in at any size. */
function RuneMark({ size: s }: { size: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 512 512">
      <rect width="512" height="512" rx="96" fill={MOSS} />
      <rect x="28" y="28" width="456" height="456" rx="72" fill="none" stroke="#3A4330" strokeWidth="8" />
      <g stroke={FORGE} strokeWidth="34" strokeLinecap="round" fill="none">
        <path d="M176 96 V416" />
        <path d="M176 150 L336 104" />
        <path d="M176 252 L316 208" />
      </g>
    </svg>
  );
}

export default async function Image() {
  const [cinzelData, spectralData] = await Promise.all([cinzel, spectral]);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: BOG,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 56,
            padding: '0 80px',
          }}
        >
          <RuneMark size={220} />
          <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 760 }}>
            <div
              style={{
                display: 'flex',
                fontFamily: 'Cinzel',
                fontSize: 90,
                fontWeight: 600,
                letterSpacing: 6,
                color: BIRCH,
                textTransform: 'uppercase',
                lineHeight: 1.05,
              }}
            >
              Valheim Codex
            </div>
            <div
              style={{
                display: 'flex',
                marginTop: 28,
                fontFamily: 'Spectral',
                fontSize: 34,
                color: ASH,
                lineHeight: 1.4,
              }}
            >
              Preguntas sobre Valheim respondidas desde la wiki, con la fuente a la vista.
            </div>
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
