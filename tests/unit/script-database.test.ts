import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chooseDatabase,
  databaseHost,
  DatabaseChoiceError,
  describeDatabase,
  envSource,
  type DatabaseFlags,
  type EnvSource,
} from '../../scripts/_db';

/**
 * Which database a script works on (scripts/_db.ts). The rule it replaces —
 * DATABASE_URL when set, PGLITE_DATA_DIR otherwise — let `.env.local`'s
 * production URL reach runs meant for a local copy.
 */

/** Not a real credential: the point is that it never shows up in a message. */
const PROD_URL = 'postgresql://neondb_owner:s3cret-pw@ep-quiet-sky.us-east-2.aws.neon.tech/neondb?sslmode=require';
const HOST = 'ep-quiet-sky.us-east-2.aws.neon.tech';

const choose = (
  input: Partial<{
    flags: DatabaseFlags;
    env: Record<string, string | undefined>;
    urlFrom: EnvSource | null;
    writes: boolean;
    lang: 'es' | 'en';
  }>,
) => chooseDatabase({ flags: {}, env: {}, urlFrom: null, writes: true, lang: 'en', ...input });

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseChoiceError);
    return (error as Error).message;
  }
  throw new Error('expected the choice to be refused');
};

describe('which database a script works on (IT-3)', () => {
  const fromFile = { env: { DATABASE_URL: PROD_URL }, urlFrom: '.env.local' as const };

  it('works on a DATABASE_URL given in the environment, as the scheduled workflow gives it', () => {
    expect(choose({ env: { DATABASE_URL: PROD_URL }, urlFrom: 'environment' })).toMatchObject({ driver: 'neon', host: HOST });
  });

  it('asks for --neon before writing to a DATABASE_URL .env.local filled in', () => {
    const message = refusal(() => choose(fromFile));
    expect(message).toContain('--neon');
    expect(message).toContain('.env.local');
    expect(choose({ ...fromFile, flags: { neon: true } })).toMatchObject({ driver: 'neon', from: '.env.local' });
    // A run that only reads needs no confirmation.
    expect(choose({ ...fromFile, writes: false })).toMatchObject({ driver: 'neon' });
  });

  it('refuses to guess between DATABASE_URL and PGLITE_DATA_DIR, whoever set them', () => {
    const both = { env: { DATABASE_URL: PROD_URL, PGLITE_DATA_DIR: '.data/copy' } };
    expect(refusal(() => choose({ ...both, urlFrom: '.env.local' }))).toContain('--pglite .data/copy');
    refusal(() => choose({ ...both, urlFrom: '.env.local', writes: false }));
    refusal(() => choose({ ...both, urlFrom: 'environment' }));

    expect(choose({ ...both, flags: { pglite: '.data/copy' } })).toEqual({ driver: 'pglite', dir: '.data/copy' });
    expect(choose({ ...both, urlFrom: '.env.local', flags: { neon: true } })).toMatchObject({ driver: 'neon' });
  });

  it('takes --pglite over anything the environment says, but not together with --neon', () => {
    expect(choose({ ...fromFile, flags: { pglite: 'C:/copies/corpus' } })).toEqual({
      driver: 'pglite',
      dir: 'C:/copies/corpus',
    });
    refusal(() => choose({ ...fromFile, flags: { pglite: '.data/copy', neon: true } }));
    refusal(() => choose({ flags: { pglite: ' ' } }));
  });

  it('needs a DATABASE_URL for --neon', () => {
    expect(refusal(() => choose({ flags: { neon: true } }))).toContain('DATABASE_URL');
  });

  it('falls back to PGLITE_DATA_DIR, then .data/pglite', () => {
    expect(choose({ env: { PGLITE_DATA_DIR: '.data/serve' } })).toEqual({ driver: 'pglite', dir: '.data/serve' });
    expect(choose({})).toEqual({ driver: 'pglite', dir: '.data/pglite' });
    // An empty DATABASE_URL — `DATABASE_URL=` in a POSIX shell — is no URL.
    expect(choose({ env: { DATABASE_URL: '' } })).toEqual({ driver: 'pglite', dir: '.data/pglite' });
  });

  it('names the host, never the credentials', () => {
    const messages = [
      refusal(() => choose(fromFile)),
      refusal(() => choose({ env: { DATABASE_URL: PROD_URL, PGLITE_DATA_DIR: '.data/copy' }, urlFrom: '.env.local' })),
      describeDatabase(choose({ env: { DATABASE_URL: PROD_URL }, urlFrom: 'environment' }), 'en'),
      describeDatabase(choose({ ...fromFile, writes: false, lang: 'es' }), 'es'),
    ];
    for (const message of messages) {
      expect(message).toContain(HOST);
      expect(message).not.toContain('s3cret');
      expect(message).not.toContain('neondb_owner');
    }
    expect(databaseHost('not a url')).toBe('(an unreadable URL)');
  });

  it('says it in Spanish for the translation scripts', () => {
    expect(refusal(() => choose({ ...fromFile, lang: 'es' }))).toContain('Pasá --neon');
    expect(describeDatabase({ driver: 'pglite', dir: '.data/copy' }, 'es')).toBe('PGlite en .data/copy');
    expect(describeDatabase(choose({ ...fromFile, writes: false, lang: 'es' }), 'es')).toBe(
      `Neon en ${HOST} (DATABASE_URL de .env.local)`,
    );
  });
});

describe('where DATABASE_URL came from', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wv-dotenv-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('tells a value .env.local filled in from one the shell set', () => {
    writeFileSync(join(dir, '.env.local'), `DATABASE_URL=${PROD_URL}\n`);
    expect(envSource('DATABASE_URL', { DATABASE_URL: PROD_URL }, dir)).toBe('.env.local');
    expect(envSource('DATABASE_URL', { DATABASE_URL: 'postgresql://elsewhere/db' }, dir)).toBe('environment');
    expect(envSource('DATABASE_URL', { DATABASE_URL: '' }, dir)).toBeNull();
    expect(envSource('DATABASE_URL', {}, dir)).toBeNull();
  });

  it('reads .env after .env.local, the order _env.ts loads them in', () => {
    writeFileSync(join(dir, '.env'), `DATABASE_URL=${PROD_URL}\n`);
    expect(envSource('DATABASE_URL', { DATABASE_URL: PROD_URL }, dir)).toBe('.env');
    // Defined first by .env.local, with another value: this one was the shell's.
    writeFileSync(join(dir, '.env.local'), 'DATABASE_URL=postgresql://local/db\n');
    expect(envSource('DATABASE_URL', { DATABASE_URL: PROD_URL }, dir)).toBe('environment');
  });

  it('counts a value no file defines as the environment’s', () => {
    expect(envSource('DATABASE_URL', { DATABASE_URL: PROD_URL }, dir)).toBe('environment');
  });
});
