import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeGraph, GraphShapeError } from '@/lib/craft/codec';
import type { RecipeGraph } from '@/lib/craft/types';

/**
 * The planner downloads the whole recipe graph once per page
 * (`src/lib/craft/graph-client.ts`), from `/api/wiki/recipes?v=1`, which
 * answers `{ v: 1, version, graph }` with the graph in its compact form
 * (`codec.ts`). Whatever arrives — a truncated cache entry, another shape
 * from a newer server — becomes a whole graph or an error the planner can
 * offer to retry, never a half-read graph it would compute wrong numbers from.
 */

const GRAPH: RecipeGraph = {
  v: 1,
  version: 'a1b2c3d4',
  builtAt: '2026-10-27T18:00:00.000Z',
  items: [
    { id: 'SwordIron', en: 'Iron Sword', es: 'Espada de hierro', slug: 'iron-sword', kind: 'item', maxQuality: 2 },
    { id: 'Wood', en: 'Wood', es: 'Madera', slug: 'wood', kind: 'item', maxQuality: 1 },
    { id: 'Iron', en: 'Iron', es: 'Hierro', slug: 'iron', kind: 'item', maxQuality: 1 },
    { id: 'forge', en: 'Forge', es: 'Forja', slug: 'forge', kind: 'station', maxQuality: 1, station: { maxLevel: 7, extensions: [] } },
  ],
  recipes: [
    { product: 'SwordIron', quality: 1, station: 'forge', stationLevel: 2, yield: 1, yieldKnown: true, inputs: [['Wood', 2], ['Iron', 20]], method: 'craft', from: 'Iron Sword' },
    { product: 'SwordIron', quality: 2, station: 'forge', stationLevel: 3, yield: 1, yieldKnown: true, inputs: [['Wood', 1], ['Iron', 10]], method: 'craft', from: 'Iron Sword' },
  ],
};

const payload = () => ({ v: 1, version: GRAPH.version, graph: encodeGraph(GRAPH) });

describe('parseGraphResponse', () => {
  it('reads the route’s payload into the graph and its version', async () => {
    const { parseGraphResponse } = await import('@/lib/craft/graph-client');
    expect(parseGraphResponse(payload())).toEqual({ graph: GRAPH, version: GRAPH.version });
    // As it arrives over the network: JSON text, parsed.
    expect(parseGraphResponse(JSON.parse(JSON.stringify(payload()))).graph).toEqual(GRAPH);
  });

  it('refuses anything else, by throwing', async () => {
    const { parseGraphResponse } = await import('@/lib/craft/graph-client');
    const wire = encodeGraph(GRAPH);
    const bad: unknown[] = [
      null,
      'graph',
      [],
      { error: 'recipes_unavailable' },
      { v: 2, version: GRAPH.version, graph: wire },
      { v: 1, version: 7, graph: wire },
      { v: 1, version: GRAPH.version },
      { v: 1, version: GRAPH.version, graph: { ...wire, r: 'truncated' } },
      { v: 1, version: GRAPH.version, graph: GRAPH },
    ];
    for (const body of bad) expect(() => parseGraphResponse(body), JSON.stringify(body)).toThrow(GraphShapeError);
  });
});

describe('loadGraph', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** A fresh copy of the module, as a new page gets: the loaded graph is kept per page. */
  async function freshClient() {
    vi.resetModules();
    return import('@/lib/craft/graph-client');
  }

  it('downloads the graph once per page, from the versioned address', async () => {
    const client = await freshClient();
    const fetchGraph = vi.fn(async () => Response.json(payload()));
    vi.stubGlobal('fetch', fetchGraph);

    expect(client.loadedGraph()).toBeNull();
    const [first, second] = await Promise.all([client.loadGraph(), client.loadGraph()]);
    expect(first).toBe(second);
    expect(await client.loadGraph()).toBe(first);
    expect(fetchGraph).toHaveBeenCalledTimes(1);
    expect(fetchGraph).toHaveBeenCalledWith(client.GRAPH_URL);
    expect(client.GRAPH_URL).toBe('/api/wiki/recipes?v=1');

    expect(first.version).toBe(GRAPH.version);
    expect(first.graph).toEqual(GRAPH);
    // Indexed once, for every computation the planner makes.
    expect(first.index.graph).toBe(first.graph);
    expect(first.index.recipes.get('SwordIron')).toHaveLength(2);
    expect(client.loadedGraph()).toBe(first);
  });

  it('lets the next call try again after a failure', async () => {
    const client = await freshClient();
    const answers = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(Response.json({ error: 'recipes_unavailable' }, { status: 503 })),
      () => Promise.resolve(Response.json({ v: 1, version: 'x', graph: { v: 1 } })),
      () => Promise.resolve(Response.json(payload())),
    ];
    let attempt = 0;
    const fetchGraph = vi.fn(() => answers[attempt++]!());
    vi.stubGlobal('fetch', fetchGraph);

    await expect(client.loadGraph()).rejects.toThrow('Failed to fetch');
    await expect(client.loadGraph()).rejects.toThrow('503');
    // By name: the fresh module has its own copy of the error class.
    await expect(client.loadGraph()).rejects.toMatchObject({ name: 'GraphShapeError' });
    expect(client.loadedGraph()).toBeNull();

    const loaded = await client.loadGraph();
    expect(loaded.graph).toEqual(GRAPH);
    expect(client.loadedGraph()).toBe(loaded);
    expect(fetchGraph).toHaveBeenCalledTimes(4);
  });
});
