import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

export const alt = 'Codex de Valheim — Guía 100%';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const BOG = '#14170F';
const MOSS = '#2A3120';
const FORGE = '#D98A34';
const BIRCH = '#E8E2D0';
const ASH = '#9AA089';

const cinzel = readFile(join(process.cwd(), 'src/assets/fonts/Cinzel-SemiBold.ttf'));
const spectral = readFile(join(process.cwd(), 'src/assets/fonts/Spectral-Regular.ttf'));

export default async function Image() {
  const [cinzelData, spectralData] = await Promise.all([cinzel, spectral]);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          background: BOG,
          padding: '0 88px',
        }}
      >
        <div
          style={{
            display: 'flex',
            fontFamily: 'Spectral',
            fontSize: 28,
            letterSpacing: 5,
            textTransform: 'uppercase',
            color: FORGE,
            marginBottom: 22,
          }}
        >
          Guía de finalización · 7 jefes
        </div>
        <div
          style={{
            display: 'flex',
            fontFamily: 'Cinzel',
            fontWeight: 600,
            fontSize: 96,
            letterSpacing: 3,
            textTransform: 'uppercase',
            color: BIRCH,
            lineHeight: 1.05,
          }}
        >
          Codex de Valheim
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 30,
            fontFamily: 'Spectral',
            fontSize: 34,
            color: ASH,
          }}
        >
          Bioma por bioma, con checklist — de Meadows a Ashlands.
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
            marginTop: 48,
            maxWidth: 1024,
          }}
        >
          {['Meadows', 'Black Forest', 'Swamp', 'Mountain', 'Plains', 'Mistlands', 'Ashlands'].map(
            (name) => (
              <div
                key={name}
                style={{
                  display: 'flex',
                  padding: '8px 18px',
                  borderRadius: 999,
                  border: `1px solid ${MOSS}`,
                  fontFamily: 'Spectral',
                  fontSize: 20,
                  color: BIRCH,
                }}
              >
                {name}
              </div>
            ),
          )}
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
