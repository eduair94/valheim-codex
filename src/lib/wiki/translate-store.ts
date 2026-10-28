import { sql } from 'drizzle-orm';
import { rawQuery, type Db } from '@/lib/db/create-db';
import { describeError, logWarn } from '@/lib/log';
import type { ArticleDoc, ArticleImage } from './article-types';
import { captionsOf, overlayCaptions, type FailureLog, type TranslationMemory } from './translate';

/**
 * Where translations, and what they were made from, are kept.
 *
 * Two tables, on purpose. `article_translations` is what a reader is shown:
 * anything in it is served under the "machine translation" label.
 * `article_translation_memory` (drizzle/0009) is every string translated so
 * far for an article, keyed by its English text, how many are still missing,
 * which ones keep failing, and who is working on the article right now.
 * Progress has to be kept even when it is not yet worth showing — otherwise a
 * long article that takes three calls pays for the first call three times,
 * and a batch that failed throws away the batches that worked — and nothing
 * can be kept in the first table without being shown.
 *
 * One writer per article at a time, across processes: whoever translates an
 * article takes its lease first (`acquireLease`), and the memory is only ever
 * written under the lease. The reader's endpoint and `pnpm translate:es` run
 * on different machines, translate in the same order, and used to pay for the
 * same strings and save over each other's progress.
 *
 * Every read is one query: the article, its translation and its memory joined
 * by slug. The reader's endpoint used to fetch the article and then its
 * translation, two sequential round trips to a metered database per request.
 *
 * The new parts of the schema are optional at runtime. Deploys here do not run
 * migrations, so a missing memory table, or one this role may not use, must
 * not take translation down: reads fall back to the translation alone, the
 * first write creates what is missing if the database role may (the same rule
 * as `rate_limits` in quota.ts), and otherwise the caller learns there is no
 * memory to keep progress in. The same goes for the captions column.
 */

const UNDEFINED_TABLE = '42P01';
const UNDEFINED_COLUMN = '42703';

/**
 * The table exists but this role may not use it: 0009 was applied with the
 * owner credential before the app's role existed, say. Treated like a missing
 * table, not as an outage.
 */
const INSUFFICIENT_PRIVILEGE = '42501';

/** How long a missing part of the schema is believed missing before it is looked for again. */
const RECHECK_MS = 10 * 60 * 1000;

/** How long a lease lasts unless its holder says otherwise. */
const DEFAULT_LEASE_MS = 2 * 60 * 1000;

/**
 * The parts of the schema a deployment may not have yet, both from
 * drizzle/0009: the memory table, and the captions column on translations.
 */
type Feature = 'memory' | 'captions';
type Features = Record<Feature, boolean>;

/** When each was last found unusable; 0 while it works. */
const missingSince: Record<Feature, number> = { memory: 0, captions: 0 };
/** When this process last tried to create it. */
const createTriedAt: Record<Feature, number> = { memory: 0, captions: 0 };

const believed = (feature: Feature, now = Date.now()): boolean => now - missingSince[feature] >= RECHECK_MS;

/** Test-only: forget what was found missing. */
export function resetMemoryTableState(): void {
  missingSince.memory = 0;
  missingSince.captions = 0;
  createTriedAt.memory = 0;
  createTriedAt.captions = 0;
}

/**
 * The Postgres error inside whatever wrapped it: its SQLSTATE and its own
 * message. Drizzle wraps errors in one whose message is the whole query, which
 * names every column the query uses.
 */
function pgError(error: unknown): { code: string; message: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, message: typeof message === 'string' ? message : '' };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Which optional part of the schema an error says is missing, if any. */
function lacking(error: unknown): Feature | null {
  const pg = pgError(error);
  if (!pg) return null;
  if (pg.code === UNDEFINED_TABLE || pg.code === INSUFFICIENT_PRIVILEGE) return 'memory';
  if (pg.code === UNDEFINED_COLUMN) return /\bcaptions\b/.test(pg.message) ? 'captions' : 'memory';
  return null;
}

const NOTICE: Record<Feature, (code: string | undefined) => string> = {
  memory: (code) =>
    code === INSUFFICIENT_PRIVILEGE
      ? 'article_translation_memory is not granted to this role; translating without a memory until it is (drizzle/0009 grants it to valheim_app)'
      : code === UNDEFINED_COLUMN
        ? 'article_translation_memory predates drizzle/0009 as it stands; translating without a memory until the table is brought up to date'
        : 'article_translation_memory does not exist; translating without a memory until `pnpm db:migrate` applies drizzle/0009',
  captions: () =>
    'article_translations has no captions column; image captions stay in English until `pnpm db:migrate` applies drizzle/0009',
};

function noteMissing(feature: Feature, error: unknown): void {
  if (missingSince[feature] === 0) logWarn('translate', NOTICE[feature](pgError(error)?.code));
  missingSince[feature] = Date.now();
}

/** Runs a read with every optional part believed usable, dropping each one the database turns out to lack. */
async function withSchema<T>(read: (features: Features) => Promise<T>): Promise<T> {
  const features: Features = { memory: believed('memory'), captions: believed('captions') };
  for (;;) {
    try {
      const result = await read(features);
      if (features.memory) missingSince.memory = 0;
      if (features.captions) missingSince.captions = 0;
      return result;
    } catch (error) {
      const feature = lacking(error);
      if (!feature || !features[feature]) throw error;
      noteMissing(feature, error);
      features[feature] = false;
    }
  }
}

/**
 * Same DDL as drizzle/0009, so the migration still applies cleanly afterwards.
 * The grant is best effort: only the table's owner may give it.
 */
export async function ensureMemoryTable(db: Db): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS article_translation_memory (
      page_key     text        NOT NULL REFERENCES pages(key) ON DELETE CASCADE,
      lang         text        NOT NULL,
      entries      jsonb       NOT NULL DEFAULT '{}'::jsonb,
      failures     jsonb       NOT NULL DEFAULT '{}'::jsonb,
      pending      integer     NOT NULL DEFAULT 0,
      lease_holder text,
      lease_until  timestamptz,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (page_key, lang)
    )
  `);
  await db.execute(
    sql`ALTER TABLE article_translation_memory ADD COLUMN IF NOT EXISTS failures jsonb NOT NULL DEFAULT '{}'::jsonb`,
  );
  await db.execute(sql`ALTER TABLE article_translation_memory ADD COLUMN IF NOT EXISTS lease_holder text`);
  await db.execute(sql`ALTER TABLE article_translation_memory ADD COLUMN IF NOT EXISTS lease_until timestamptz`);
  await db
    .execute(
      sql.raw(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'valheim_app') THEN
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE article_translation_memory TO valheim_app;
          END IF;
        END
        $$`),
    )
    .catch(() => {});
  missingSince.memory = 0;
}

/** Same DDL as drizzle/0009. Only the table's owner may run it. */
export async function ensureCaptionsColumn(db: Db): Promise<void> {
  await db.execute(sql`ALTER TABLE article_translations ADD COLUMN IF NOT EXISTS captions jsonb`);
  missingSince.captions = 0;
}

/**
 * Creates the missing part if this role may, at most once per RECHECK_MS.
 * True when it now exists.
 */
async function tryCreate(feature: Feature, db: Db, error: unknown): Promise<boolean> {
  const now = Date.now();
  const recently = now - createTriedAt[feature] < RECHECK_MS;
  // Refused for want of a grant counts as tried: creating cannot fix that,
  // and the writes in between need not ask again.
  createTriedAt[feature] = recently ? createTriedAt[feature] : now;
  if (pgError(error)?.code === INSUFFICIENT_PRIVILEGE || recently) {
    noteMissing(feature, error);
    return false;
  }
  try {
    await (feature === 'memory' ? ensureMemoryTable(db) : ensureCaptionsColumn(db));
    return true;
  } catch (createError) {
    noteMissing(feature, error);
    logWarn('translate', `could not create the missing ${feature} schema: ${describeError(createError).message}`);
    return false;
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseObject(value: unknown): Record<string, unknown> | null {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** A stored memory, keeping only well-formed entries. */
function parseMemory(value: unknown): TranslationMemory | null {
  const parsed = parseObject(value);
  if (!parsed) return null;
  const memory: TranslationMemory = new Map();
  for (const [english, translated] of Object.entries(parsed)) {
    if (typeof translated === 'string' && translated.trim() !== '') memory.set(english, translated);
  }
  return memory;
}

function parseFailures(value: unknown): FailureLog {
  const failures: FailureLog = new Map();
  for (const [english, count] of Object.entries(parseObject(value) ?? {})) {
    if (typeof count === 'number' && Number.isInteger(count) && count > 0) failures.set(english, count);
  }
  return failures;
}

function parseCaptions(value: unknown): Record<string, string> | null {
  const parsed = parseObject(value);
  if (!parsed) return null;
  const captions = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return captions.length > 0 ? Object.fromEntries(captions) : null;
}

function parseImages(value: unknown): ArticleImage[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? (parsed as ArticleImage[]) : [];
}

function docFrom(row: { lead: unknown; blocks: unknown; infobox: unknown }, images: ArticleImage[]): ArticleDoc {
  return {
    lead: typeof row.lead === 'string' ? row.lead : '',
    blocks: (parseJson(row.blocks) ?? []) as ArticleDoc['blocks'],
    infobox: (parseJson(row.infobox) ?? null) as ArticleDoc['infobox'],
    images,
    // Facets are matched against English values elsewhere and never translated.
    facets: {},
  };
}

/** A number safe to bind as an integer: "never" is a very large one. */
const asLimit = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 1_000_000);

export type CachedTranslation = {
  title: string;
  /** The translated document over the English article's images, their captions translated where stored. */
  doc: ArticleDoc;
  /** The article changed after it was translated. */
  stale: boolean;
  /** Some strings are still in English, waiting for a later call. */
  partial: boolean;
  /**
   * Some of those may still be sent: fewer have failed `maxFailures` times
   * than are missing. Always `partial` when no `maxFailures` is given.
   */
  retryable: boolean;
};

export type CachedLookup = { article: false } | { article: true; translation: CachedTranslation | null };

/**
 * The stored translation of an article, by slug. One query; no side effects.
 *
 * `maxFailures` is for a caller deciding whether a reader could add anything:
 * the strings that failed that many times are left out of `retryable`.
 */
export async function readCachedTranslation(
  db: Db,
  slug: string,
  lang: string,
  options: { maxFailures?: number } = {},
): Promise<CachedLookup> {
  const rows = await withSchema((f) =>
    rawQuery<{
      translated: boolean;
      title: string | null;
      lead: unknown;
      blocks: unknown;
      infobox: unknown;
      images: unknown;
      captions: unknown;
      stale: boolean;
      pending: number | string;
      stuck: number | string;
    }>(
      db,
      sql`
        SELECT (t.page_key IS NOT NULL) AS translated,
               t.title, t.lead, t.blocks, t.infobox, a.images,
               ${f.captions ? sql`t.captions` : sql`NULL::jsonb`} AS captions,
               coalesce(t.source_updated_at < a.updated_at, false) AS stale,
               ${f.memory ? sql`coalesce(m.pending, 0)` : sql`0`} AS pending,
               ${
                 f.memory && options.maxFailures !== undefined
                   ? sql`(SELECT count(*) FROM jsonb_each_text(m.failures) x
                          WHERE x.value::int >= ${asLimit(options.maxFailures)}::int)`
                   : sql`0`
               } AS stuck
        FROM articles a
        LEFT JOIN article_translations t ON t.page_key = a.page_key AND t.lang = ${lang}
        ${f.memory ? sql`LEFT JOIN article_translation_memory m ON m.page_key = a.page_key AND m.lang = ${lang}` : sql.empty()}
        WHERE a.slug = ${slug}
        LIMIT 1
      `,
    ),
  );

  const row = rows[0];
  if (!row) return { article: false };
  if (!row.translated || row.title === null) return { article: true, translation: null };
  const pending = Number(row.pending) || 0;
  return {
    article: true,
    translation: {
      title: row.title,
      doc: docFrom(row, overlayCaptions(parseImages(row.images), parseCaptions(row.captions))),
      stale: row.stale === true,
      partial: pending > 0,
      retryable: pending > (Number(row.stuck) || 0),
    },
  };
}

export type TranslationJob = {
  pageKey: string;
  slug: string;
  title: string;
  /** The English article, images included (their captions are translated too). */
  doc: ArticleDoc;
  /**
   * The article's `updated_at` exactly as stored, as text. A translation is
   * stamped with this very value: a JavaScript Date keeps milliseconds only,
   * and a stamp a few microseconds short of the article's would make a new
   * translation stale the moment it was saved.
   */
  version: string;
  /** What readers are shown now, if anything. */
  published: { title: string; doc: ArticleDoc; model: string; stale: boolean } | null;
  /** Null when nothing is remembered for this article (or there is no memory table). */
  memory: TranslationMemory | null;
  /** Strings that came back unusable, and how often. */
  failures: FailureLog;
  /** Strings still in English as of the memory's last write. */
  pending: number;
  /** Whether the memory table could be read. Writing it takes a lease (`acquireLease`). */
  memoryAvailable: boolean;
};

/** Everything needed to translate or refresh one article, in one query. */
export async function loadTranslationJob(db: Db, slug: string, lang: string): Promise<TranslationJob | null> {
  let memoryAvailable = false;
  const rows = await withSchema((f) => {
    memoryAvailable = f.memory;
    return rawQuery<{
      page_key: string;
      slug: string;
      title: string;
      lead: unknown;
      blocks: unknown;
      infobox: unknown;
      images: unknown;
      version: string;
      translated: boolean;
      t_title: string | null;
      t_lead: unknown;
      t_blocks: unknown;
      t_infobox: unknown;
      t_model: string | null;
      t_captions: unknown;
      stale: boolean;
      memory: unknown;
      failures: unknown;
      pending: number | string;
    }>(
      db,
      sql`
        SELECT a.page_key, a.slug, a.title, a.lead, a.blocks, a.infobox, a.images,
               a.updated_at::text AS version,
               (t.page_key IS NOT NULL) AS translated,
               t.title AS t_title, t.lead AS t_lead, t.blocks AS t_blocks, t.infobox AS t_infobox,
               t.model AS t_model,
               ${f.captions ? sql`t.captions` : sql`NULL::jsonb`} AS t_captions,
               coalesce(t.source_updated_at < a.updated_at, false) AS stale,
               ${f.memory ? sql`m.entries` : sql`NULL::jsonb`} AS memory,
               ${f.memory ? sql`m.failures` : sql`NULL::jsonb`} AS failures,
               ${f.memory ? sql`coalesce(m.pending, 0)` : sql`0`} AS pending
        FROM articles a
        LEFT JOIN article_translations t ON t.page_key = a.page_key AND t.lang = ${lang}
        ${f.memory ? sql`LEFT JOIN article_translation_memory m ON m.page_key = a.page_key AND m.lang = ${lang}` : sql.empty()}
        WHERE a.slug = ${slug}
        LIMIT 1
      `,
    );
  });

  const row = rows[0];
  if (!row) return null;
  const images = parseImages(row.images);
  return {
    pageKey: row.page_key,
    slug: row.slug,
    title: row.title,
    doc: docFrom(row, images),
    version: row.version,
    published:
      row.translated && row.t_title !== null
        ? {
            title: row.t_title,
            doc: docFrom(
              { lead: row.t_lead, blocks: row.t_blocks, infobox: row.t_infobox },
              overlayCaptions(images, parseCaptions(row.t_captions)),
            ),
            model: row.t_model ?? 'none',
            stale: row.stale === true,
          }
        : null,
    memory: parseMemory(row.memory),
    failures: parseFailures(row.failures),
    pending: Number(row.pending) || 0,
    memoryAvailable,
  };
}

export type Lease =
  /** The article is this holder's until it releases it or the lease runs out. Its memory as of now. */
  | { kind: 'acquired'; holder: string; memory: TranslationMemory; failures: FailureLog }
  /** Someone else is translating it right now. */
  | { kind: 'held' }
  /** There is no memory table this role can write: nothing can be kept between calls. */
  | { kind: 'unavailable' };

/**
 * Takes an article for translation: one writer at a time, across processes.
 *
 * Granted when nobody holds the article or the last holder's lease ran out
 * (a crashed process, a request Cloudflare gave up on). The memory comes back
 * with it, read at the moment of taking it, so the holder starts from
 * everything the previous one saved, never from a copy loaded before it.
 */
export async function acquireLease(
  db: Db,
  input: { pageKey: string; lang: string; holder: string; ttlMs?: number },
): Promise<Lease> {
  if (!believed('memory') && Date.now() - createTriedAt.memory < RECHECK_MS) return { kind: 'unavailable' };
  const seconds = Math.max(1, Math.ceil((input.ttlMs ?? DEFAULT_LEASE_MS) / 1000));
  const take = () =>
    rawQuery<{ entries: unknown; failures: unknown }>(
      db,
      sql`
        INSERT INTO article_translation_memory AS m (page_key, lang, lease_holder, lease_until)
        VALUES (${input.pageKey}, ${input.lang}, ${input.holder}, now() + ${seconds}::int * interval '1 second')
        ON CONFLICT (page_key, lang) DO UPDATE SET
          lease_holder = EXCLUDED.lease_holder,
          lease_until = EXCLUDED.lease_until
        WHERE m.lease_until IS NULL OR m.lease_until <= now() OR m.lease_holder = EXCLUDED.lease_holder
        RETURNING m.entries, m.failures
      `,
    );

  let rows: { entries: unknown; failures: unknown }[];
  try {
    rows = await take();
  } catch (error) {
    if (lacking(error) !== 'memory') throw error;
    if (!(await tryCreate('memory', db, error))) return { kind: 'unavailable' };
    try {
      rows = await take();
    } catch (retryError) {
      if (lacking(retryError) !== 'memory') throw retryError;
      noteMissing('memory', retryError);
      return { kind: 'unavailable' };
    }
  }
  missingSince.memory = 0;

  const row = rows[0];
  if (!row) return { kind: 'held' };
  return {
    kind: 'acquired',
    holder: input.holder,
    memory: parseMemory(row.entries) ?? new Map(),
    failures: parseFailures(row.failures),
  };
}

/** Gives an article back without writing anything else. Harmless if the lease already passed on. */
export async function releaseLease(db: Db, input: { pageKey: string; lang: string; holder: string }): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE article_translation_memory SET lease_holder = NULL, lease_until = NULL
      WHERE page_key = ${input.pageKey} AND lang = ${input.lang} AND lease_holder = ${input.holder}
    `);
  } catch (error) {
    if (lacking(error) !== 'memory') throw error;
  }
}

export type TranslationWork = {
  pageKey: string;
  lang: string;
  /** The lease this is written under (`acquireLease`), or null without one: then no memory is written. */
  lease: string | null;
  /** Give the lease up with this write — the work is done — or keep it for another `leaseMs`. */
  release: boolean;
  leaseMs?: number;
  /** Every translated string of the article, pruned to the strings it has now. */
  memory: TranslationMemory;
  failures: FailureLog;
  /** Strings still in English. */
  pending: number;
  /**
   * What readers are shown from now on, stamped with the article version it
   * was made from. Null keeps the current translation, if there is one: a
   * stale but complete Spanish page beats a fresh one that is mostly English.
   */
  publish: Publication | null;
};

export type Publication = {
  title: string;
  doc: ArticleDoc;
  model: string;
  version: string;
  /**
   * The translated captions, by image URL: `captionsOf(doc, englishDoc)`.
   * When left out, every caption `doc` carries is kept, translated or not.
   */
  captions?: Record<string, string> | null;
};

export type SavedWork = {
  /**
   * `stored`: written. `lost`: the lease had run out and passed to someone
   * else, so nothing was written — the new holder's work stands. `unavailable`:
   * there is no memory this role can write.
   */
  memory: 'stored' | 'lost' | 'unavailable';
  /** Whether readers now see `publish`. */
  published: boolean;
};

/**
 * Stores the memory, then (when given) the translation readers see.
 *
 * In that order: if the second write fails, the next attempt still starts from
 * everything this one paid for.
 *
 * A partial translation is never published without its memory. The memory is
 * the only record of which strings are still in English; without it a page
 * with English left in it would read as complete from then on, served to
 * shared caches and never queued for completion.
 */
export async function saveTranslationWork(db: Db, work: TranslationWork): Promise<SavedWork> {
  const memory = work.lease === null ? 'unavailable' : await saveMemory(db, work, work.lease);
  if (memory === 'lost' || !work.publish) return { memory, published: false };
  if (memory === 'unavailable' && work.pending > 0) return { memory, published: false };
  await publishTranslation(db, work.pageKey, work.lang, work.publish);
  return { memory, published: true };
}

async function saveMemory(db: Db, work: TranslationWork, holder: string): Promise<SavedWork['memory']> {
  const seconds = Math.max(1, Math.ceil((work.leaseMs ?? DEFAULT_LEASE_MS) / 1000));
  try {
    const rows = await rawQuery<{ page_key: string }>(
      db,
      sql`
        UPDATE article_translation_memory SET
          entries = ${JSON.stringify(Object.fromEntries(work.memory))}::jsonb,
          failures = ${JSON.stringify(Object.fromEntries(work.failures))}::jsonb,
          pending = ${work.pending},
          updated_at = now(),
          lease_holder = ${work.release ? sql`NULL` : sql`lease_holder`},
          lease_until = ${work.release ? sql`NULL` : sql`now() + ${seconds}::int * interval '1 second'`}
        WHERE page_key = ${work.pageKey} AND lang = ${work.lang} AND lease_holder = ${holder}
        RETURNING page_key
      `,
    );
    if (rows.length > 0) return 'stored';
    logWarn('translate', `lease on ${work.pageKey} ran out before its work was saved; the next holder's stands`);
    return 'lost';
  } catch (error) {
    if (lacking(error) !== 'memory') throw error;
    noteMissing('memory', error);
    return 'unavailable';
  }
}

/**
 * Runs a write with the captions column if it is there, creating it if this
 * role may, and without it otherwise. Only a failed attempt to create it, not
 * a read that found it missing, makes later writes skip it for a while.
 */
async function withCaptionsColumn(db: Db, write: (captions: boolean) => Promise<unknown>): Promise<void> {
  if (!believed('captions') && Date.now() - createTriedAt.captions < RECHECK_MS) {
    await write(false);
    return;
  }
  try {
    await write(true);
    missingSince.captions = 0;
  } catch (error) {
    if (lacking(error) !== 'captions') throw error;
    if (await tryCreate('captions', db, error)) await write(true);
    else await write(false);
  }
}

async function publishTranslation(db: Db, pageKey: string, lang: string, publish: Publication): Promise<void> {
  const { title, doc, model, version } = publish;
  const captions = publish.captions !== undefined ? publish.captions : captionsOf(doc);
  await withCaptionsColumn(db, (withCaptions) =>
    db.execute(sql`
      INSERT INTO article_translations
        (page_key, lang, title, lead, blocks, infobox, model, source_updated_at${withCaptions ? sql`, captions` : sql.empty()})
      VALUES (
        ${pageKey}, ${lang}, ${title}, ${doc.lead},
        ${JSON.stringify(doc.blocks)}::jsonb,
        ${doc.infobox === null ? null : JSON.stringify(doc.infobox)}::jsonb,
        ${model}, ${version}::timestamptz${withCaptions ? sql`, ${captions === null ? null : JSON.stringify(captions)}::jsonb` : sql.empty()}
      )
      ON CONFLICT (page_key, lang) DO UPDATE SET
        title = EXCLUDED.title,
        lead = EXCLUDED.lead,
        blocks = EXCLUDED.blocks,
        infobox = EXCLUDED.infobox,
        model = EXCLUDED.model,
        source_updated_at = EXCLUDED.source_updated_at,
        ${withCaptions ? sql`captions = EXCLUDED.captions,` : sql.empty()}
        created_at = now()
    `),
  );
}

/**
 * Rewrites the text of a stored translation and nothing else: its model, its
 * stamp and its date stay as they were. For repairs that need no model.
 */
export async function rewriteTranslation(
  db: Db,
  input: { pageKey: string; lang: string; title: string; doc: ArticleDoc; captions?: Record<string, string> | null },
): Promise<void> {
  const captions = input.captions !== undefined ? input.captions : captionsOf(input.doc);
  await withCaptionsColumn(db, (withCaptions) =>
    db.execute(sql`
      UPDATE article_translations SET
        ${withCaptions ? sql`captions = ${captions === null ? null : JSON.stringify(captions)}::jsonb,` : sql.empty()}
        title = ${input.title},
        lead = ${input.doc.lead},
        blocks = ${JSON.stringify(input.doc.blocks)}::jsonb,
        infobox = ${input.doc.infobox === null ? null : JSON.stringify(input.doc.infobox)}::jsonb
      WHERE page_key = ${input.pageKey} AND lang = ${input.lang}
    `),
  );
}

/**
 * A translation's image captions, keyed by image URL, for a page that shows
 * the English article's images under the translated text — overlay them with
 * `overlayCaptions` from translate.ts. Null when there are none, and when the
 * column does not exist yet (a deploy that skipped drizzle/0009): never an
 * error, so a page can ask on every render.
 */
export async function readTranslatedCaptions(
  db: Db,
  slug: string,
  lang: string,
): Promise<Record<string, string> | null> {
  if (!believed('captions')) return null;
  try {
    const rows = await rawQuery<{ captions: unknown }>(
      db,
      sql`
        SELECT t.captions FROM articles a
        JOIN article_translations t ON t.page_key = a.page_key AND t.lang = ${lang}
        WHERE a.slug = ${slug}
        LIMIT 1
      `,
    );
    missingSince.captions = 0;
    return parseCaptions(rows[0]?.captions);
  } catch (error) {
    if (lacking(error) !== 'captions') throw error;
    noteMissing('captions', error);
    return null;
  }
}

export type QueueEntry = {
  slug: string;
  /** Characters of English text, the order the queue is sorted by. */
  size: number;
  /** Why it is queued: never translated, translated before the article changed, or not finished. */
  state: 'missing' | 'stale' | 'partial';
};

/**
 * Every article that needs translation work in `lang`, smallest or largest
 * first — and, either way, the articles with only old failures left last.
 *
 * Those are articles whose every pending string has come back unusable
 * before. They stay queued, since the bulk script retries every such string
 * once per run, but they are the work least likely to succeed: smallest
 * first, they gathered at the head of the queue (everything around them gets
 * finished) and took the first requests of every day's budget. Known only
 * while the memory still describes the article: for a stale translation, or
 * a memory saved before the article last changed, the failures may belong to
 * strings it no longer has.
 */
export async function listTranslationQueue(
  db: Db,
  lang: string,
  order: 'smallest' | 'largest' = 'smallest',
): Promise<QueueEntry[]> {
  const rows = await withSchema((f) =>
    rawQuery<{ slug: string; size: number | string; state: QueueEntry['state'] }>(
      db,
      sql`
        SELECT a.slug,
               length(a.lead) + length(a.blocks::text) AS size,
               CASE WHEN t.page_key IS NULL THEN 'missing'
                    WHEN t.source_updated_at < a.updated_at THEN 'stale'
                    ELSE 'partial' END AS state
        FROM articles a
        LEFT JOIN article_translations t ON t.page_key = a.page_key AND t.lang = ${lang}
        ${f.memory ? sql`LEFT JOIN article_translation_memory m ON m.page_key = a.page_key AND m.lang = ${lang}` : sql.empty()}
        WHERE t.page_key IS NULL
           OR t.source_updated_at < a.updated_at
           ${f.memory ? sql`OR m.pending > 0` : sql.empty()}
        ORDER BY
          ${
            f.memory
              ? sql`coalesce(
                  m.pending > 0
                  AND m.pending <= (SELECT count(*) FROM jsonb_object_keys(m.failures))
                  AND CASE WHEN t.page_key IS NULL THEN m.updated_at >= a.updated_at
                           ELSE t.source_updated_at >= a.updated_at END,
                  false),`
              : sql.empty()
          }
          size ${sql.raw(order === 'largest' ? 'DESC' : 'ASC')}, a.slug
      `,
    ),
  );
  return rows.map((row) => ({ slug: row.slug, size: Number(row.size), state: row.state }));
}

/**
 * Current translations with no memory: the ones stored before memories were
 * kept. A memory row that holds only a lease (taken, then given back without
 * saving anything) counts as none. Stale ones are left out, because their
 * memory can no longer be recovered by position (see `deriveMemory`).
 */
export async function listTranslationsWithoutMemory(db: Db, lang: string): Promise<string[]> {
  const rows = await withSchema((f) =>
    rawQuery<{ slug: string }>(
      db,
      sql`
        SELECT a.slug
        FROM articles a
        JOIN article_translations t ON t.page_key = a.page_key AND t.lang = ${lang}
        ${f.memory ? sql`LEFT JOIN article_translation_memory m ON m.page_key = a.page_key AND m.lang = ${lang}` : sql.empty()}
        WHERE t.source_updated_at >= a.updated_at
          ${f.memory ? sql`AND (m.page_key IS NULL OR m.entries = '{}'::jsonb)` : sql.empty()}
        ORDER BY a.slug
      `,
    ),
  );
  return rows.map((row) => row.slug);
}
