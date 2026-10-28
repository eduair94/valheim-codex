import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GraphReport, RecipeGraph } from '@/lib/craft/types';
import { rawQuery, type DbHandle } from '@/lib/db/create-db';
import {
  RECIPE_GRAPHS_KEPT,
  getLatestRecipeGraph,
  getRecipeBasis,
  getRecipeStates,
  isRecipeGraphBehind,
  writePageRecipes,
  writeRecipeGraph,
} from '@/lib/db/recipe-repo';
import type { PageRecipes } from '@/lib/wiki/recipes';
import { createTestDb } from '../helpers/db';

/**
 * Where the recipe graph is kept between ingest runs: what the extractor read
 * from each page, and the graphs assembled from all of it. Every write is a
 * single statement, because production reaches its database over Neon's HTTP
 * driver, which has no transactions.
 */

let handle: DbHandle;
let nextPageId = 1;

beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  await handle?.close();
});

async function seedPage(source = 'fandom'): Promise<{ key: string; pageId: number }> {
  const pageId = nextPageId++;
  const key = `${source}:${pageId}`;
  await handle.db.execute(sql`
    INSERT INTO pages (key, source, page_id, title, url, revid)
    VALUES (${key}, ${source}, ${pageId}, ${`Page ${pageId}`}, ${`https://example.test/Page_${pageId}`}, 1)
  `);
  return { key, pageId };
}

/** What the extractor reads from a page whose item takes `qty` Wood at a Workbench. */
function pageRecipes(title: string, qty = 2): PageRecipes {
  return {
    infoboxes: [
      {
        title,
        tab: null,
        internalId: title.replace(/\s+/g, ''),
        source: { text: 'Workbench', links: [{ title: 'Workbench', fragment: null, text: 'Workbench' }] },
        levels: [
          {
            quality: 1,
            stationLevel: 1,
            yield: null,
            entries: [{ text: 'Wood', qty, link: { title: 'Wood', fragment: null, text: 'Wood' } }],
          },
        ],
        maxLevel: null,
        improvements: [],
        upgrades: null,
        notes: [],
      },
    ],
    listRows: [],
    foodRows: [],
  };
}

/**
 * An assembled graph. `filler` adds that many generated items, each with a
 * recipe, so a test can store one as large as the real graph.
 */
function graph(version: string, builtAt: string, filler = 0): RecipeGraph {
  const items: RecipeGraph['items'] = [
    { id: 'Wood', en: 'Wood', es: 'Madera', slug: 'wood', kind: 'item', maxQuality: 1 },
    { id: 'Workbench', en: 'Workbench', slug: 'workbench', kind: 'station', maxQuality: 1, station: { maxLevel: 5, extensions: [] } },
    { id: 'Club', en: 'Club', es: 'Garrote', aliases: ['Mazo'], slug: 'club', kind: 'item', maxQuality: 4 },
  ];
  const recipes: RecipeGraph['recipes'] = [
    {
      product: 'Club',
      quality: 1,
      station: 'Workbench',
      stationLevel: 1,
      yield: 1,
      yieldKnown: true,
      inputs: [['Wood', 6]],
      method: 'craft',
      from: 'Club',
    },
  ];
  for (let i = 0; i < filler; i++) {
    items.push({
      id: `GeneratedItem${i}`,
      en: `Generated item number ${i}`,
      es: `Objeto generado número ${i}`,
      slug: `generated-item-${i}`,
      kind: 'item',
      maxQuality: 1,
    });
    recipes.push({
      product: `GeneratedItem${i}`,
      quality: 1,
      station: 'Workbench',
      stationLevel: 1 + (i % 5),
      yield: 1,
      yieldKnown: true,
      inputs: [
        ['Wood', 1 + (i % 9)],
        [`GeneratedItem${Math.max(0, i - 1)}`, 2],
      ],
      method: 'craft',
      from: `Generated item number ${i}`,
    });
  }
  return { v: 1, version, builtAt, items, recipes };
}

/** A graph of a shape a later release reads and this one does not. */
function newerShape(version: string, builtAt: string): RecipeGraph {
  return { ...graph(version, builtAt), v: 2 } as unknown as RecipeGraph;
}

/** The assembler's report on a graph, here with one unresolved name. */
function report(items: number): GraphReport {
  return {
    items,
    recipes: 1,
    products: 1,
    raw: 1,
    unresolved: [{ text: 'Dyrnwyn hilt fragment', from: 'Dyrnwyn', count: 1 }],
    cycles: [],
    levelConflicts: [],
    duplicates: [],
    yieldSuspects: [],
  };
}

async function storedGraphs(): Promise<{ version: string; built_at: string; recipes_version: number }[]> {
  return rawQuery(
    handle.db,
    sql`SELECT version, built_at::text AS built_at, recipes_version FROM recipe_graph ORDER BY built_at DESC`,
  );
}

async function clearGraphs(): Promise<void> {
  await handle.db.execute(sql`DELETE FROM recipe_graph`);
}

/** Stores a graph as the ingest does: assembled from the recipes stored when it starts. */
async function store(assembled: RecipeGraph, withReport = report(3), recipesVersion = 1): Promise<void> {
  await writeRecipeGraph(handle.db, assembled, withReport, recipesVersion, await getRecipeBasis(handle.db));
}

/** Why the database refused a write: Postgres' own message, under the error Drizzle wraps it in. */
async function refusal(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  throw new Error('the write was not refused');
}

describe('page recipes', () => {
  it('keeps one row per page: a later write replaces an earlier one', async () => {
    const page = await seedPage();
    await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 10, data: pageRecipes('Club', 6) });
    await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 2, revid: 11, data: pageRecipes('Club', 8) });

    const rows = await rawQuery<{ recipes_version: number; revid: number; data: PageRecipes }>(
      handle.db,
      sql`SELECT recipes_version, revid, data FROM page_recipes WHERE page_key = ${page.key}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipes_version: 2, revid: 11 });
    expect(rows[0]!.data).toEqual(pageRecipes('Club', 8));
  });

  it('says whether the recipes changed, and dates the row by when they last did', async () => {
    const page = await seedPage();
    const backdate = () =>
      handle.db.execute(sql`UPDATE page_recipes SET updated_at = '2026-01-01T00:00:00Z' WHERE page_key = ${page.key}`);
    const stillBackdated = async () =>
      (
        await rawQuery<{ backdated: boolean }>(
          handle.db,
          sql`SELECT updated_at = '2026-01-01T00:00:00Z'::timestamptz AS backdated
              FROM page_recipes WHERE page_key = ${page.key}`,
        )
      )[0]?.backdated;

    expect(await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 1, data: pageRecipes('Club') })).toBe(true);

    // A new revision whose edit left the recipes alone, as most edits do.
    await backdate();
    expect(await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 2, data: pageRecipes('Club') })).toBe(false);
    expect(await stillBackdated()).toBe(true);
    expect((await getRecipeStates(handle.db, 'fandom')).get(page.pageId)).toEqual({ recipesVersion: 1, revid: 2 });

    expect(await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 3, data: pageRecipes('Club', 9) })).toBe(true);
    expect(await stillBackdated()).toBe(false);
  });

  it('reports the recipe state of every page of a source, by page id', async () => {
    const withRecipes = await seedPage('states');
    const another = await seedPage('states');
    const without = await seedPage('states');
    const elsewhere = await seedPage('other-wiki');
    await writePageRecipes(handle.db, { pageKey: withRecipes.key, recipesVersion: 1, revid: 40, data: pageRecipes('Club') });
    await writePageRecipes(handle.db, { pageKey: another.key, recipesVersion: 2, revid: 41, data: pageRecipes('Torch') });
    await writePageRecipes(handle.db, { pageKey: elsewhere.key, recipesVersion: 1, revid: 42, data: pageRecipes('Club') });

    const states = await getRecipeStates(handle.db, 'states');

    expect(Object.fromEntries(states)).toEqual({
      [withRecipes.pageId]: { recipesVersion: 1, revid: 40 },
      [another.pageId]: { recipesVersion: 2, revid: 41 },
    });
    expect(states.has(without.pageId)).toBe(false);
  });

  it('goes with its page', async () => {
    const page = await seedPage();
    await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 1, data: pageRecipes('Club') });

    await handle.db.execute(sql`DELETE FROM pages WHERE key = ${page.key}`);

    const rows = await rawQuery(handle.db, sql`SELECT 1 FROM page_recipes WHERE page_key = ${page.key}`);
    expect(rows).toHaveLength(0);
  });

  it('refuses recipes for a page that is not stored', async () => {
    // The page row comes first; recipes nobody can assemble are not kept.
    expect(
      await refusal(
        writePageRecipes(handle.db, { pageKey: 'fandom:999999', recipesVersion: 1, revid: 1, data: pageRecipes('Club') }),
      ),
    ).toMatch(/foreign key/);
  });
});

describe('recipe graphs', () => {
  it('has none to serve before the first is written', async () => {
    await clearGraphs();
    expect(await getLatestRecipeGraph(handle.db)).toBeNull();
  });

  it('stores a graph and its report, dated when it was built, under its version', async () => {
    await clearGraphs();
    await store(graph('aaa', '2026-10-27T10:00:00.000Z'));

    expect(await getLatestRecipeGraph(handle.db)).toEqual({
      graph: graph('aaa', '2026-10-27T10:00:00.000Z'),
      report: report(3),
    });
    const [row] = await rawQuery<{ stamped: boolean; recipes_version: number; shape: number }>(
      handle.db,
      sql`SELECT built_at = '2026-10-27T10:00:00.000Z'::timestamptz AS stamped, recipes_version, shape FROM recipe_graph`,
    );
    expect(row).toEqual({ stamped: true, recipes_version: 1, shape: 1 });
  });

  it('keeps one row per version, and a graph built again is the newest again', async () => {
    await clearGraphs();
    await store(graph('aaa', '2026-10-27T10:00:00.000Z'));
    await store(graph('bbb', '2026-10-27T11:00:00.000Z'));
    expect((await getLatestRecipeGraph(handle.db))?.graph.version).toBe('bbb');

    // The wiki went back to what it said at ten: the same content, so the same
    // version, and it is what the wiki says now.
    await store(graph('aaa', '2026-10-27T12:00:00.000Z'), report(4), 2);

    expect((await storedGraphs()).map((g) => [g.version, g.recipes_version])).toEqual([
      ['aaa', 2],
      ['bbb', 1],
    ]);
    expect(await getLatestRecipeGraph(handle.db)).toEqual({
      graph: graph('aaa', '2026-10-27T12:00:00.000Z'),
      report: report(4),
    });
  });

  it(`keeps the newest ${RECIPE_GRAPHS_KEPT}`, async () => {
    await clearGraphs();
    for (const [version, hour] of [['v1', 10], ['v2', 11], ['v3', 12], ['v4', 13]] as const) {
      await store(graph(version, `2026-10-27T${hour}:00:00.000Z`));
    }

    expect((await storedGraphs()).map((g) => g.version)).toEqual(['v4', 'v3', 'v2']);
    expect((await getLatestRecipeGraph(handle.db))?.graph.version).toBe('v4');
  });

  it('serves the graph written last, whatever time its builder stamped on it', async () => {
    // Two runs on machines whose clocks disagree, or a test that stamps every
    // graph with the same time: the order they were written in still decides.
    await clearGraphs();
    await store(graph('zzz', '2026-10-27T10:00:00.000Z'));
    await store(graph('yyy', '2026-10-27T10:00:00.000Z'));
    expect((await getLatestRecipeGraph(handle.db))?.graph.version).toBe('yyy');

    await store(graph('xxx', '2026-10-27T09:00:00.000Z'));
    expect((await getLatestRecipeGraph(handle.db))?.graph.version).toBe('xxx');
    expect((await storedGraphs()).map((g) => g.version)).toEqual(['xxx', 'yyy', 'zzz']);
  });

  it('stores a graph as large as the real one whole', async () => {
    await clearGraphs();
    const large = graph('large', '2026-10-27T10:00:00.000Z', 1_300);
    expect(JSON.stringify(large).length).toBeGreaterThan(250_000);

    await store(large, report(large.items.length));

    expect((await getLatestRecipeGraph(handle.db))?.graph).toEqual(large);
  });

  it('writes a graph whole or not at all, and prunes nothing when the write fails', async () => {
    await clearGraphs();
    for (const [version, hour] of [['v1', 10], ['v2', 11], ['v3', 12]] as const) {
      await store(graph(version, `2026-10-27T${hour}:00:00.000Z`));
    }
    // jsonb refuses a NUL, on PGlite and on Neon alike.
    const broken = graph('v4', '2026-10-27T13:00:00.000Z');
    broken.items[0]!.en = 'Wo\u0000od';

    expect(await refusal(store(broken))).toMatch(/Unicode escape/);

    expect((await storedGraphs()).map((g) => g.version)).toEqual(['v3', 'v2', 'v1']);
    expect((await getLatestRecipeGraph(handle.db))?.graph.version).toBe('v3');
  });

  it('has none to serve where the table is missing or its role may not read it, and says so in the log', async () => {
    // Deploys here are a pull and a rebuild, and nothing runs migrations: a
    // server can start before drizzle/0010 is applied, or under an app role
    // created without the grant. Item pages must keep working meanwhile.
    await clearGraphs();
    await store(graph('aaa', '2026-10-27T10:00:00.000Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await handle.db.execute(sql`CREATE ROLE reader_without_grant`);
      await handle.db.execute(sql`SET ROLE reader_without_grant`);
      try {
        expect(await getLatestRecipeGraph(handle.db)).toBeNull();
      } finally {
        await handle.db.execute(sql`RESET ROLE`);
      }

      await handle.db.execute(sql`ALTER TABLE recipe_graph RENAME TO recipe_graph_aside`);
      try {
        expect(await getLatestRecipeGraph(handle.db)).toBeNull();
      } finally {
        await handle.db.execute(sql`ALTER TABLE recipe_graph_aside RENAME TO recipe_graph`);
      }

      expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
        expect.stringContaining('may not read recipe_graph'),
        expect.stringContaining('recipe_graph does not exist'),
      ]);
      // Nothing was lost on the way: with the table back, the graph is served again.
      expect((await getLatestRecipeGraph(handle.db))?.graph.version).toBe('aaa');
    } finally {
      warn.mockRestore();
    }
  });

  it('serves the newest graph of the shape this code reads, however many of a newer shape follow it', async () => {
    // A newer ingest may store graphs of a newer shape before the server that
    // reads them is deployed, a few times over while its overrides are tuned.
    // Each write makes room only among graphs of its own shape, so the server
    // keeps the newest graph it understands.
    await clearGraphs();
    await store(graph('old', '2026-10-27T10:00:00.000Z'));
    for (const [version, hour] of [['n1', 11], ['n2', 12], ['n3', 13], ['n4', 14]] as const) {
      await store(newerShape(version, `2026-10-27T${hour}:00:00.000Z`), report(3), 2);
    }

    expect((await storedGraphs()).map((g) => g.version)).toEqual(['n4', 'n3', 'n2', 'old']);
    expect((await getLatestRecipeGraph(handle.db))?.graph.version).toBe('old');

    // And the other way round: this shape's writes leave the newer shape's graphs alone.
    for (const [version, hour] of [['a1', 15], ['a2', 16], ['a3', 17]] as const) {
      await store(graph(version, `2026-10-27T${hour}:00:00.000Z`));
    }
    expect((await storedGraphs()).map((g) => g.version)).toEqual(['a3', 'a2', 'a1', 'n4', 'n3', 'n2']);
    expect((await getLatestRecipeGraph(handle.db))?.graph.version).toBe('a3');
  });
});

describe('whether the graph is behind the recipes', () => {
  it('is behind while there is no graph', async () => {
    await clearGraphs();
    expect(await isRecipeGraphBehind(handle.db)).toBe(true);

    await store(graph('aaa', '2026-10-27T10:00:00.000Z'));

    expect(await isRecipeGraphBehind(handle.db)).toBe(false);
  });

  it('stays behind after a run that stored new recipes and stopped before assembling them', async () => {
    // The next run finds nothing new on the wiki and writes the same recipes
    // again, or none at all: what it wrote cannot tell it that the graph is
    // behind, and only the graph's basis still can.
    await clearGraphs();
    const page = await seedPage();
    await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 100, data: pageRecipes('Club', 6) });
    await store(graph('six-wood', '2026-10-27T10:00:00.000Z'));
    expect(await isRecipeGraphBehind(handle.db)).toBe(false);

    // The wiki changed the recipe; the run stored it and stopped, or its assembly failed.
    expect(
      await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 101, data: pageRecipes('Club', 8) }),
    ).toBe(true);
    expect(await isRecipeGraphBehind(handle.db)).toBe(true);

    expect(
      await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 101, data: pageRecipes('Club', 8) }),
    ).toBe(false);
    expect(await isRecipeGraphBehind(handle.db)).toBe(true);
    expect((await getLatestRecipeGraph(handle.db))?.graph.version).toBe('six-wood');

    await store(graph('eight-wood', '2026-10-27T11:00:00.000Z'));
    expect(await isRecipeGraphBehind(handle.db)).toBe(false);
  });

  it('dates the basis from before the assembly read the recipes, so a change made meanwhile is not missed', async () => {
    await clearGraphs();
    const page = await seedPage();
    await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 1, data: pageRecipes('Club', 6) });
    const basis = await getRecipeBasis(handle.db);

    // Another run stores a change while this one fetches redirects and assembles.
    await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 2, data: pageRecipes('Club', 7) });
    await writeRecipeGraph(handle.db, graph('aaa', '2026-10-27T10:00:00.000Z'), report(3), 1, basis);

    expect(await isRecipeGraphBehind(handle.db)).toBe(true);
  });

  it('is behind once a page is read at a new revision or removed, and not for a newer extractor reading the same', async () => {
    await clearGraphs();
    const page = await seedPage();
    await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 1, data: pageRecipes('Club') });
    await store(graph('aaa', '2026-10-27T10:00:00.000Z'));

    // A newer extractor read the page and found the same recipes: the graph would come out the same.
    await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 2, revid: 1, data: pageRecipes('Club') });
    expect(await isRecipeGraphBehind(handle.db)).toBe(false);

    // A new revision with the same recipes may still be a move to a new title,
    // and the graph links the item to its article by the old one's slug.
    await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 2, revid: 2, data: pageRecipes('Club') });
    expect(await isRecipeGraphBehind(handle.db)).toBe(true);
    await store(graph('aaa', '2026-10-27T11:00:00.000Z'));
    expect(await isRecipeGraphBehind(handle.db)).toBe(false);

    await handle.db.execute(sql`DELETE FROM pages WHERE key = ${page.key}`);
    expect(await isRecipeGraphBehind(handle.db)).toBe(true);
  });

  it('asks only about the graph of the shape this code serves', async () => {
    // A newer ingest's graph, however current, is not one this server can serve.
    await clearGraphs();
    await store(graph('old', '2026-10-27T10:00:00.000Z'));
    const page = await seedPage();
    await writePageRecipes(handle.db, { pageKey: page.key, recipesVersion: 1, revid: 1, data: pageRecipes('Club') });
    await store(newerShape('new', '2026-10-27T11:00:00.000Z'), report(3), 2);

    expect(await isRecipeGraphBehind(handle.db)).toBe(true);
  });
});
