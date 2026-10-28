import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rawQuery, type DbHandle } from '@/lib/db/create-db';
import { getArticleBySlug, getTranslation, saveTranslation, upsertArticle } from '@/lib/db/wiki-repo';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import { applyMemory, deriveMemory } from '@/lib/wiki/translate';
import {
  acquireLease,
  listTranslationQueue,
  listTranslationsWithoutMemory,
  loadTranslationJob,
  readCachedTranslation,
  readTranslatedCaptions,
  releaseLease,
  resetMemoryTableState,
  rewriteTranslation,
  saveTranslationWork,
  type TranslationWork,
} from '@/lib/wiki/translate-store';
import { createTestDb } from '../helpers/db';

/**
 * The queries the endpoint and the bulk scripts run on: which articles still
 * need work, who may write an article's memory, what may be published without
 * one, which translations predate memories, and the repairs that need no model.
 */

let handle: DbHandle;
let pageId = 1;

beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  await handle?.close();
});
beforeEach(() => {
  resetMemoryTableState();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function paragraphs(texts: string[], section = ''): ArticleDoc {
  return {
    lead: '',
    blocks: texts.map((text) => ({ kind: 'paragraph' as const, section, text })),
    infobox: null,
    images: [],
    facets: {},
  };
}

async function seed(slug: string, doc: ArticleDoc, title = slug): Promise<string> {
  const key = `fandom:${pageId}`;
  await handle.db.execute(sql`
    INSERT INTO pages (key, source, page_id, title, url, revid)
    VALUES (${key}, 'fandom', ${pageId}, ${title}, ${`https://example.test/${slug}`}, 1)
  `);
  pageId += 1;
  await upsertArticle(handle.db, {
    pageKey: key,
    source: 'fandom',
    title,
    slug,
    url: `https://example.test/${slug}`,
    categories: [],
    doc,
  });
  return key;
}

/** Saves the way every writer does: under the article's lease, given back with the write. */
async function saveLeased(work: Omit<TranslationWork, 'lease' | 'release' | 'failures'> & Partial<TranslationWork>) {
  const lease = await acquireLease(handle.db, { pageKey: work.pageKey, lang: work.lang, holder: 'test' });
  if (lease.kind !== 'acquired') throw new Error(`expected the lease, got ${lease.kind}`);
  return saveTranslationWork(handle.db, { failures: new Map(), ...work, lease: lease.holder, release: true });
}

describe('the translation queue', () => {
  it('lists missing, stale and partial work, smallest or largest first, and leaves finished work out', async () => {
    await seed('q-missing-small', paragraphs(['Short.']));
    await seed('q-missing-large', paragraphs(['A much longer paragraph than any other here. '.repeat(10)]));

    const done = await seed('q-done', paragraphs(['Finished.']));
    let job = (await loadTranslationJob(handle.db, 'q-done', 'es'))!;
    await saveLeased({
      pageKey: done,
      lang: 'es',
      memory: new Map([['Finished.', 'Terminado.']]),
      pending: 0,
      publish: { title: 'q-done', doc: job.doc, model: 'test', version: job.version },
    });

    const stale = await seed('q-stale', paragraphs(['Changed later.']));
    job = (await loadTranslationJob(handle.db, 'q-stale', 'es'))!;
    await saveLeased({
      pageKey: stale,
      lang: 'es',
      memory: new Map(),
      pending: 0,
      publish: { title: 'q-stale', doc: job.doc, model: 'test', version: job.version },
    });
    await handle.db.execute(sql`UPDATE articles SET updated_at = updated_at + interval '1 minute' WHERE slug = 'q-stale'`);

    const partial = await seed('q-partial', paragraphs(['Half.', 'Done.']));
    job = (await loadTranslationJob(handle.db, 'q-partial', 'es'))!;
    await saveLeased({
      pageKey: partial,
      lang: 'es',
      memory: new Map([['Half.', 'Mitad.']]),
      pending: 1,
      publish: { title: 'q-partial', doc: job.doc, model: 'test', version: job.version },
    });

    const smallest = await listTranslationQueue(handle.db, 'es', 'smallest');
    const states = Object.fromEntries(smallest.map((e) => [e.slug, e.state]));
    expect(states).toEqual({
      'q-missing-small': 'missing',
      'q-missing-large': 'missing',
      'q-stale': 'stale',
      'q-partial': 'partial',
    });
    expect(smallest.at(-1)?.slug).toBe('q-missing-large');

    const largest = await listTranslationQueue(handle.db, 'es', 'largest');
    expect(largest[0]?.slug).toBe('q-missing-large');
  });

  it('puts articles with only old failures left after every other kind of work, in either order (IT-1)', async () => {
    // Shown, with one string left that has come back unusable before.
    const stuck = await seed('q-stuck', paragraphs(['Tiny.', 'Stubborn.']));
    let job = (await loadTranslationJob(handle.db, 'q-stuck', 'es'))!;
    await saveLeased({
      pageKey: stuck,
      lang: 'es',
      memory: new Map([
        ['q-stuck', 'q-atascado'],
        ['Tiny.', 'Diminuto.'],
      ]),
      failures: new Map([['Stubborn.', 1]]),
      pending: 1,
      publish: { title: 'q-atascado', doc: job.doc, model: 'test', version: job.version },
    });

    // Never shown: too little of it translated, and all of what is left failed.
    const unshown = await seed('q-stuck-unshown', paragraphs(['One.', 'Two.', 'Three.']));
    await saveLeased({
      pageKey: unshown,
      lang: 'es',
      memory: new Map([['q-stuck-unshown', 'q-sin-mostrar']]),
      failures: new Map([
        ['One.', 1],
        ['Two.', 2],
        ['Three.', 1],
      ]),
      pending: 3,
      publish: null,
    });

    // The same as q-stuck, but the article changed since: its failures may
    // belong to strings it no longer has, so it is ordinary work.
    const changed = await seed('q-stuck-changed', paragraphs(['Small.', 'Odd.']));
    job = (await loadTranslationJob(handle.db, 'q-stuck-changed', 'es'))!;
    await saveLeased({
      pageKey: changed,
      lang: 'es',
      memory: new Map([
        ['q-stuck-changed', 'q-cambiado'],
        ['Small.', 'Chico.'],
      ]),
      failures: new Map([['Odd.', 1]]),
      pending: 1,
      publish: { title: 'q-cambiado', doc: job.doc, model: 'test', version: job.version },
    });
    await handle.db.execute(sql`UPDATE articles SET updated_at = updated_at + interval '1 minute' WHERE slug = 'q-stuck-changed'`);

    for (const order of ['smallest', 'largest'] as const) {
      const slugs = (await listTranslationQueue(handle.db, 'es', order)).map((e) => e.slug);
      expect(slugs.slice(-2).sort()).toEqual(['q-stuck', 'q-stuck-unshown']);
      // Still queued: the bulk script retries every such string once per run.
      expect(slugs).toContain('q-stuck-changed');
      expect(slugs.indexOf('q-stuck-changed')).toBeLessThan(slugs.indexOf('q-stuck'));
      expect(slugs.indexOf('q-missing-large')).toBeLessThan(slugs.indexOf('q-stuck'));
    }
  });

  it('keeps the translation readers see when a call saves progress only', async () => {
    const key = await seed('q-keep', paragraphs(['Kept.']));
    const job = (await loadTranslationJob(handle.db, 'q-keep', 'es'))!;
    await saveLeased({
      pageKey: key,
      lang: 'es',
      memory: new Map([['Kept.', 'Guardado.']]),
      pending: 0,
      publish: { title: 'Guardado', doc: job.doc, model: 'first', version: job.version },
    });
    await saveLeased({ pageKey: key, lang: 'es', memory: new Map(), pending: 1, publish: null });

    const found = await readCachedTranslation(handle.db, 'q-keep', 'es');
    expect(found).toMatchObject({ article: true, translation: { title: 'Guardado', partial: true } });
  });
});

describe('one writer per article (the lease)', () => {
  it('lets one holder at a time take an article, and hands back its memory as of that moment', async () => {
    const key = await seed('lease-one', paragraphs(['One.', 'Two.']));
    const first = await acquireLease(handle.db, { pageKey: key, lang: 'es', holder: 'script' });
    expect(first).toMatchObject({ kind: 'acquired', holder: 'script' });
    expect(await acquireLease(handle.db, { pageKey: key, lang: 'es', holder: 'site' })).toEqual({ kind: 'held' });
    // Taking it again is renewing it.
    expect(await acquireLease(handle.db, { pageKey: key, lang: 'es', holder: 'script' })).toMatchObject({ kind: 'acquired' });

    await saveTranslationWork(handle.db, {
      pageKey: key,
      lang: 'es',
      lease: 'script',
      release: true,
      memory: new Map([['One.', 'Uno.']]),
      failures: new Map([['Two.', 1]]),
      pending: 1,
      publish: null,
    });
    const next = await acquireLease(handle.db, { pageKey: key, lang: 'es', holder: 'site' });
    if (next.kind !== 'acquired') throw new Error('expected the lease');
    expect([...next.memory]).toEqual([['One.', 'Uno.']]);
    expect([...next.failures]).toEqual([['Two.', 1]]);
    await releaseLease(handle.db, { pageKey: key, lang: 'es', holder: 'site' });
  });

  it('frees an article whose holder stopped renewing, and refuses that holder’s late save', async () => {
    const key = await seed('lease-expired', paragraphs(['Late.']));
    await acquireLease(handle.db, { pageKey: key, lang: 'es', holder: 'crashed' });
    await handle.db.execute(
      sql`UPDATE article_translation_memory SET lease_until = now() - interval '1 second' WHERE page_key = ${key}`,
    );
    expect(await acquireLease(handle.db, { pageKey: key, lang: 'es', holder: 'site' })).toMatchObject({ kind: 'acquired' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const job = (await loadTranslationJob(handle.db, 'lease-expired', 'es'))!;
    const late = await saveTranslationWork(handle.db, {
      pageKey: key,
      lang: 'es',
      lease: 'crashed',
      release: true,
      memory: new Map([['Late.', 'Tarde.']]),
      failures: new Map(),
      pending: 0,
      publish: { title: 'Tarde', doc: job.doc, model: 'test', version: job.version },
    });
    expect(late).toEqual({ memory: 'lost', published: false });
    expect(await readCachedTranslation(handle.db, 'lease-expired', 'es')).toEqual({ article: true, translation: null });
  });

  it('never publishes a partial translation without a memory, and publishes a complete one', async () => {
    const key = await seed('no-memory-write', paragraphs(['First.', 'Second.']));
    const job = (await loadTranslationJob(handle.db, 'no-memory-write', 'es'))!;
    const work = {
      pageKey: key,
      lang: 'es',
      lease: null,
      release: true,
      failures: new Map(),
      publish: { title: 'Sin memoria', doc: job.doc, model: 'test', version: job.version },
    };
    const partial = await saveTranslationWork(handle.db, { ...work, memory: new Map([['First.', 'Primero.']]), pending: 1 });
    expect(partial).toEqual({ memory: 'unavailable', published: false });
    expect(await readCachedTranslation(handle.db, 'no-memory-write', 'es')).toMatchObject({ translation: null });

    const complete = await saveTranslationWork(handle.db, { ...work, memory: new Map(), pending: 0 });
    expect(complete).toEqual({ memory: 'unavailable', published: true });
  });
});

describe('translations stored before memories were kept', () => {
  it('finds the current ones without a memory, and leaves stale ones out', async () => {
    const legacy = await seed('legacy-fresh', paragraphs(['Old text.']));
    const article = (await getArticleBySlug(handle.db, 'legacy-fresh'))!;
    // Saved the way every translation was before this change: no memory.
    await saveTranslation(handle.db, {
      pageKey: legacy,
      lang: 'es',
      title: 'Viejo',
      doc: paragraphs(['Texto viejo.']),
      model: 'claude-sonnet-4-6',
      sourceUpdatedAt: article.updatedAt,
    });

    const staleKey = await seed('legacy-stale', paragraphs(['Changed.']));
    await saveTranslation(handle.db, {
      pageKey: staleKey,
      lang: 'es',
      title: 'Cambiado',
      doc: paragraphs(['Cambiado.']),
      model: 'claude-sonnet-4-6',
      sourceUpdatedAt: new Date('2020-01-01T00:00:00Z'),
    });

    const slugs = await listTranslationsWithoutMemory(handle.db, 'es');
    expect(slugs).toContain('legacy-fresh');
    expect(slugs).not.toContain('legacy-stale');
    // Translations saved through the new path carry a memory already.
    expect(slugs).not.toContain('q-done');

    // A lease taken and given back without saving leaves no memory behind.
    await acquireLease(handle.db, { pageKey: legacy, lang: 'es', holder: 'test' });
    await releaseLease(handle.db, { pageKey: legacy, lang: 'es', holder: 'test' });
    expect(await listTranslationsWithoutMemory(handle.db, 'es')).toContain('legacy-fresh');
  });

  it('rebuilds a doubled heading into one, keeping the model and the stamp', async () => {
    // /wiki/a/magic as the old translator stored it: the gloss on the first
    // block of the section only, so the reader drew the heading twice.
    const english = paragraphs(['Elemental magic spends eitr.', 'Staffs cast it.'], 'Magic > Elemental Magic');
    const key = await seed('legacy-magic', english, 'Magic');
    const stored = paragraphs(['La magia elemental gasta eitr.', 'Los bastones la lanzan.']);
    stored.blocks[0]!.section = 'Magia > Magia elemental (Elemental Magic)';
    stored.blocks[1]!.section = 'Magia > Magia elemental';
    const job = (await loadTranslationJob(handle.db, 'legacy-magic', 'es'))!;
    await handle.db.execute(sql`
      INSERT INTO article_translations (page_key, lang, title, lead, blocks, infobox, model, source_updated_at, created_at)
      VALUES (${key}, 'es', 'Magia', '', ${JSON.stringify(stored.blocks)}::jsonb, NULL, 'claude-sonnet-4-6',
              ${job.version}::timestamptz, '2026-08-21T20:00:00Z')
    `);

    // What `pnpm translate:es --rebuild` does for each such translation.
    const legacy = (await loadTranslationJob(handle.db, 'legacy-magic', 'es'))!;
    const memory = deriveMemory(
      { doc: legacy.doc, title: legacy.title },
      { doc: legacy.published!.doc, title: legacy.published!.title },
    );
    const applied = applyMemory(legacy.doc, legacy.title, memory);
    expect(applied.pending).toBe(0);
    const saved = await saveLeased({ pageKey: key, lang: 'es', memory: applied.memory, pending: applied.pending, publish: null });
    expect(saved.memory).toBe('stored');
    await rewriteTranslation(handle.db, { pageKey: key, lang: 'es', title: applied.title, doc: applied.doc });

    const after = await getTranslation(handle.db, key, 'es');
    expect(after?.doc.blocks.map((b) => b.section)).toEqual([
      'Magia > Magia elemental (Elemental Magic)',
      'Magia > Magia elemental (Elemental Magic)',
    ]);
    expect(after?.stale).toBe(false);

    const rows = await rawQuery<{ model: string; kept: boolean }>(
      handle.db,
      sql`SELECT model, created_at = '2026-08-21T20:00:00Z'::timestamptz AS kept
          FROM article_translations WHERE page_key = ${key}`,
    );
    expect(rows[0]).toEqual({ model: 'claude-sonnet-4-6', kept: true });
    expect(await listTranslationsWithoutMemory(handle.db, 'es')).not.toContain('legacy-magic');
  });
});

describe('image captions', () => {
  const pictured: ArticleDoc = {
    ...paragraphs(['Boars roam the Meadows.']),
    images: [
      { url: 'https://example.test/boar.png', alt: 'Boar.png', caption: 'A boar' },
      { url: 'https://example.test/map.png', alt: 'Map.png' },
    ],
  };

  it('stores the translated captions with the translation and lays them over the English images', async () => {
    const key = await seed('captions', pictured, 'Boar');
    const job = (await loadTranslationJob(handle.db, 'captions', 'es'))!;
    expect(job.doc.images).toEqual(pictured.images);
    const memory = new Map([
      ['Boar', 'Jabalí'],
      ['Boars roam the Meadows.', 'Los jabalíes recorren las Praderas.'],
      ['A boar', 'Un jabalí'],
    ]);
    const applied = applyMemory(job.doc, job.title, memory);
    await saveLeased({
      pageKey: key,
      lang: 'es',
      memory: applied.memory,
      pending: applied.pending,
      publish: { title: applied.title, doc: applied.doc, model: 'test', version: job.version },
    });

    expect(await readTranslatedCaptions(handle.db, 'captions', 'es')).toEqual({ 'https://example.test/boar.png': 'Un jabalí' });
    const found = await readCachedTranslation(handle.db, 'captions', 'es');
    if (!found.article || !found.translation) throw new Error('expected a translation');
    expect(found.translation.doc.images.map((i) => i.caption)).toEqual(['Un jabalí', undefined]);
  });

  it('keeps publishing when the column is missing, and puts it back on the next write if this role may', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = await seed('captions-missing', pictured, 'Tamed boar');
    await handle.db.execute(sql`ALTER TABLE article_translations DROP COLUMN captions`);

    // Reads go on without it.
    expect(await readTranslatedCaptions(handle.db, 'captions', 'es')).toBeNull();
    const before = await readCachedTranslation(handle.db, 'captions', 'es');
    expect(before).toMatchObject({ article: true, translation: { title: 'Jabalí' } });

    // The next write, from a role that may alter the table, restores it.
    const job = (await loadTranslationJob(handle.db, 'captions-missing', 'es'))!;
    const applied = applyMemory(
      job.doc,
      job.title,
      new Map([
        ['A boar', 'Un jabalí'],
        ['Tamed boar', 'Jabalí domado'],
        ['Boars roam the Meadows.', 'Los jabalíes recorren las Praderas.'],
      ]),
    );
    const saved = await saveLeased({
      pageKey: key,
      lang: 'es',
      memory: applied.memory,
      pending: applied.pending,
      publish: { title: applied.title, doc: applied.doc, model: 'test', version: job.version },
    });
    expect(saved.published).toBe(true);
    expect(await readTranslatedCaptions(handle.db, 'captions-missing', 'es')).toEqual({
      'https://example.test/boar.png': 'Un jabalí',
    });
  });
});

describe('a memory table this role may not use', () => {
  it('reads and stores complete translations without it rather than failing', async () => {
    // drizzle/0009 applied with the owner credential, and not granted to the
    // role the app runs as.
    const key = await seed('no-grant', paragraphs(['Granted later.']));
    await handle.db.execute(sql`CREATE ROLE limited_app NOLOGIN`);
    await handle.db.execute(
      sql`GRANT SELECT, INSERT, UPDATE, DELETE ON articles, pages, article_translations TO limited_app`,
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handle.db.execute(sql`SET ROLE limited_app`);
    try {
      const job = (await loadTranslationJob(handle.db, 'no-grant', 'es'))!;
      expect(job).toMatchObject({ memory: null, memoryAvailable: false });
      expect(await acquireLease(handle.db, { pageKey: key, lang: 'es', holder: 'site' })).toEqual({ kind: 'unavailable' });
      const saved = await saveTranslationWork(handle.db, {
        pageKey: key,
        lang: 'es',
        lease: null,
        release: true,
        memory: new Map([['Granted later.', 'Concedido después.']]),
        failures: new Map(),
        pending: 0,
        publish: { title: 'Concedido', doc: job.doc, model: 'test', version: job.version },
      });
      expect(saved).toEqual({ memory: 'unavailable', published: true });
      const found = await readCachedTranslation(handle.db, 'no-grant', 'es');
      expect(found).toMatchObject({ article: true, translation: { title: 'Concedido', stale: false } });
    } finally {
      await handle.db.execute(sql`RESET ROLE`);
    }
  });
});
