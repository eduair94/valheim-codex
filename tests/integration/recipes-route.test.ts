import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { decodeGraph } from '@/lib/craft/codec';
import type { GraphReport, RecipeGraph } from '@/lib/craft/types';
import type { DbHandle } from '@/lib/db/create-db';
import { getRecipeBasis, writeRecipeGraph } from '@/lib/db/recipe-repo';
import { saveTranslation, upsertArticle } from '@/lib/db/wiki-repo';
import { slugify } from '@/lib/wiki/slug';
import { createTestDb } from '../helpers/db';

/**
 * `GET /api/wiki/recipes?v=1`: the whole recipe graph, compact, for the
 * planner, which keeps it for offline use. Public and cached like the title
 * index, because it is the same for every reader and changes only when the
 * wiki is ingested again; every answer that is not the graph is `no-store`,
 * so no cache keeps an outage or a missing graph after it is over.
 *
 * The graph is small and written by hand: a club made at the workbench, with
 * two of its three articles translated.
 */
const state = vi.hoisted(() => ({ db: null as unknown, failDb: false }));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) =>
      JSON.parse(JSON.stringify(await fn(...args))) as unknown,
}));
vi.mock('@/lib/db/client', () => ({
  getDb: async () => {
    if (state.failDb) throw new Error('database unavailable');
    return state.db;
  },
}));

const route = await import('@/app/api/wiki/recipes/route');
const data = await import('@/lib/craft/data');

const get = (path: string) => route.GET(new Request(`http://localhost${path}`));

const GRAPH: RecipeGraph = {
  v: 1,
  version: 'route-graph',
  builtAt: '2026-10-27T18:00:00.000Z',
  items: [
    { id: 'Wood', en: 'Wood', slug: 'wood', kind: 'item', maxQuality: 1, obtain: [{ how: 'chop', from: ['Beech'] }] },
    { id: 'Resin', en: 'Resin', slug: 'resin', kind: 'item', maxQuality: 1 },
    { id: 'piece_workbench', en: 'Workbench', slug: 'workbench', kind: 'station', maxQuality: 1, station: { maxLevel: 5, extensions: [] } },
    { id: 'Club', en: 'Club', slug: 'club', kind: 'item', maxQuality: 2 },
  ],
  recipes: [
    { product: 'Club', quality: 1, station: 'piece_workbench', stationLevel: 1, yield: 1, yieldKnown: true, inputs: [['Wood', 6]], method: 'craft', from: 'Club' },
    {
      product: 'Club',
      quality: 2,
      station: 'piece_workbench',
      stationLevel: 2,
      yield: 1,
      yieldKnown: true,
      inputs: [['Wood', 3], ['Resin', 2]],
      method: 'craft',
      from: 'Club',
    },
  ],
};

const REPORT: GraphReport = {
  items: 4,
  recipes: 2,
  products: 1,
  raw: 2,
  unresolved: [],
  cycles: [],
  levelConflicts: [],
  duplicates: [],
  yieldSuspects: [],
};

const PUBLIC = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';

describe('GET /api/wiki/recipes', () => {
  let handle: DbHandle;

  async function storeGraph(graph: RecipeGraph): Promise<void> {
    await writeRecipeGraph(handle.db, graph, REPORT, 1, await getRecipeBasis(handle.db));
  }

  beforeAll(async () => {
    handle = await createTestDb();
    for (const [i, [title, translated]] of (
      [
        ['Wood', 'Madera (Wood)'],
        ['Resin', null],
        ['Workbench', null],
        ['Club', 'Garrote (Club)'],
      ] as const
    ).entries()) {
      const pageKey = `fandom:${i + 1}`;
      const url = `https://valheim.fandom.com/wiki/${title}`;
      await handle.db.execute(sql`
        INSERT INTO pages (key, source, page_id, title, url, revid) VALUES (${pageKey}, 'fandom', ${i + 1}, ${title}, ${url}, 1)
      `);
      await upsertArticle(handle.db, {
        pageKey,
        source: 'fandom',
        title,
        slug: slugify(title),
        url,
        categories: ['Materials'],
        doc: { lead: '', blocks: [], infobox: null, images: [], facets: {} },
      });
      if (translated) {
        await saveTranslation(handle.db, {
          pageKey,
          lang: 'es',
          title: translated,
          doc: { lead: '', blocks: [], infobox: null, images: [], facets: {} },
          model: 'test',
          sourceUpdatedAt: new Date(Date.now() + 60_000),
        });
      }
    }
    await storeGraph(GRAPH);
    state.db = handle.db;
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(() => {
    state.failDb = false;
  });

  it('serves the graph at v=1, compact, cacheable like the title index', async () => {
    const response = await get('/api/wiki/recipes?v=1');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(PUBLIC);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { v: number; version: string; graph: unknown };
    expect(body.v).toBe(1);
    expect(body.version).toBe('route-graph');

    // Arrays, not objects: the planner's download.
    expect(Array.isArray((body.graph as { i: unknown }).i)).toBe(true);
    const graph = decodeGraph(body.graph);
    expect(graph).toEqual(await data.getRecipeGraphData());
    expect(graph.recipes).toEqual(GRAPH.recipes);
  });

  it('names items as their articles are named today, in one payload for both languages', async () => {
    const graph = decodeGraph(((await (await get('/api/wiki/recipes?v=1')).json()) as { graph: unknown }).graph);
    const es = Object.fromEntries(graph.items.map((item) => [item.id, item.es ?? null]));
    expect(es).toEqual({ Wood: 'Madera', Resin: null, piece_workbench: 'Banco de trabajo', Club: 'Garrote' });
  });

  it('asks for the shape it reads, and is a 400 without one', async () => {
    for (const path of ['/api/wiki/recipes', '/api/wiki/recipes?v=', '/api/wiki/recipes?v=2', '/api/wiki/recipes?v=one']) {
      const response = await get(path);
      expect(response.status, path).toBe(400);
      expect(await response.json()).toEqual({ error: 'version_required' });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('is a 503 while no graph has been written, never cached', async () => {
    await handle.db.execute(sql`DELETE FROM recipe_graph`);
    try {
      const response = await get('/api/wiki/recipes?v=1');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'recipes_unavailable' });
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await storeGraph(GRAPH);
    }
  });

  it('is a 503 for a stored graph no planner could read, rather than a payload that fails in the browser', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await storeGraph({
        ...GRAPH,
        version: 'unreadable',
        recipes: [...GRAPH.recipes, { ...GRAPH.recipes[0]!, quality: 3, inputs: [['Dyrnwyn', 1]] }],
      });
      const response = await get('/api/wiki/recipes?v=1');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'recipes_unavailable' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await storeGraph(GRAPH);
    }
    expect((await get('/api/wiki/recipes?v=1')).status).toBe(200);
  });

  it('reports a database failure as one, without caching it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.failDb = true;
    try {
      const response = await get('/api/wiki/recipes?v=1');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'recipes_unavailable' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(errors).toHaveBeenCalledWith('[wiki-recipes]', expect.stringContaining('database unavailable'));
    } finally {
      state.failDb = false;
      errors.mockRestore();
    }
  });
});
