import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db/create-db';
import { createTestDb } from '../helpers/db';

describe('migrations', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('installs pgvector', async () => {
    const res = await handle.db.execute(sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
    const rows = (res as { rows: { extversion: string }[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.extversion).toMatch(/^\d+\.\d+/);
  });

  it('creates every table', async () => {
    const res = await handle.db.execute(sql`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    const names = (res as { rows: { tablename: string }[] }).rows.map((r) => r.tablename);
    expect(names).toEqual(
      expect.arrayContaining([
        '_migrations', 'chunks', 'conversations', 'ingest_runs', 'locks', 'login_attempts', 'messages', 'pages',
      ]),
    );
  });

  it('creates the hnsw and gin indexes', async () => {
    const res = await handle.db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'chunks'
    `);
    const names = (res as { rows: { indexname: string }[] }).rows.map((r) => r.indexname);
    expect(names).toContain('chunks_embedding_idx');
    expect(names).toContain('chunks_fts_idx');
  });

  it('populates the generated fts column from title, section and content', async () => {
    await handle.db.execute(sql`
      INSERT INTO pages (key, source, page_id, title, url, revid)
      VALUES ('fandom:1', 'fandom', 1, 'Yagluth', 'https://example.test/Yagluth', 10)
    `);
    await handle.db.execute(sql`
      INSERT INTO chunks (id, page_key, source, title, url, section_path, kind, content, token_count, content_hash)
      VALUES ('c1', 'fandom:1', 'fandom', 'Yagluth', 'https://example.test/Yagluth', 'Combat',
              'prose', 'The fifth boss of the Plains biome.', 8, 'h1')
    `);
    const res = await handle.db.execute(sql`
      SELECT id FROM chunks, websearch_to_tsquery('simple', 'Yagluth') q WHERE fts @@ q
    `);
    expect((res as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('is idempotent', async () => {
    const { runMigrations } = await import('@/lib/db/migrate');
    const ran = await runMigrations(handle);
    expect(ran).toEqual([]);
  });
});
