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

  it('creates the recipe tables, whose migration also applies a second time', async () => {
    const tables = await handle.db.execute(sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename IN ('page_recipes', 'recipe_graph')
      ORDER BY tablename
    `);
    expect((tables as { rows: { tablename: string }[] }).rows.map((r) => r.tablename)).toEqual([
      'page_recipes',
      'recipe_graph',
    ]);

    // A page's recipes go with the page.
    const keys = await handle.db.execute(sql`
      SELECT confdeltype FROM pg_constraint WHERE conrelid = 'page_recipes'::regclass AND contype = 'f'
    `);
    expect((keys as { rows: { confdeltype: string }[] }).rows.map((r) => r.confdeltype)).toEqual(['c']);

    const indexes = await handle.db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'recipe_graph'`);
    expect((indexes as { rows: { indexname: string }[] }).rows.map((r) => r.indexname)).toContain('recipe_graph_built_idx');

    // As if it had never been recorded: every statement must accept what it already made.
    await handle.db.execute(sql`DELETE FROM _migrations WHERE name = '0010_recipes.sql'`);
    const { runMigrations } = await import('@/lib/db/migrate');
    expect(await runMigrations(handle)).toEqual(['0010_recipes.sql']);
  });

  it("lets the app's role read the recipe graph, and nothing else of the recipes", async () => {
    // The grant runs only where the role exists, which outside this test is production alone.
    await handle.db.execute(sql`CREATE ROLE valheim_app`);
    await handle.db.execute(sql`DELETE FROM _migrations WHERE name = '0010_recipes.sql'`);
    const { runMigrations } = await import('@/lib/db/migrate');
    expect(await runMigrations(handle)).toEqual(['0010_recipes.sql']);

    const res = await handle.db.execute(sql`
      SELECT has_table_privilege('valheim_app', 'recipe_graph', 'SELECT') AS read_graph,
             has_table_privilege('valheim_app', 'recipe_graph', 'INSERT, UPDATE, DELETE') AS write_graph,
             has_table_privilege('valheim_app', 'page_recipes', 'SELECT, INSERT, UPDATE, DELETE') AS use_page_recipes
    `);
    expect((res as { rows: unknown[] }).rows[0]).toEqual({ read_graph: true, write_graph: false, use_page_recipes: false });
  });

  it('is idempotent', async () => {
    const { runMigrations } = await import('@/lib/db/migrate');
    const ran = await runMigrations(handle);
    expect(ran).toEqual([]);
  });
});
