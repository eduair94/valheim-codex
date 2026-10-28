import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Assemble from '@/lib/craft/assemble';
import { redirectTitles, type AssemblyPage } from '@/lib/craft/assemble';
import { buildRecipeGraph } from '@/lib/craft/build';
import type { RecipeGraph } from '@/lib/craft/types';
import { rawQuery, type DbHandle } from '@/lib/db/create-db';
import { getLatestRecipeGraph, isRecipeGraphBehind, writePageRecipes } from '@/lib/db/recipe-repo';
import { MediaWikiClient, type FetchLike } from '@/lib/wiki/mediawiki';
import { extractRecipes, type PageRecipes } from '@/lib/wiki/recipes';
import { slugify } from '@/lib/wiki/slug';
import { SOURCES } from '@/lib/wiki/sources';
import { createTestDb } from '../helpers/db';

/**
 * The recipe graph built from what the ingest stored: every page's recipes
 * in page_recipes, the page's title and categories in pages, its article's
 * slug in articles, and the wiki asked about the redirects the recipes link
 * through. Pages are saved ones from the live wiki (tests/fixtures), read
 * through the extractor as the ingest reads them, and a few one-infobox
 * pages for what they name and the saved set lacks.
 */

let handle: DbHandle;
let nextPageId = 1;
const source = SOURCES[0]!;

beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  await handle?.close();
});
beforeEach(async () => {
  await handle.db.execute(sql`TRUNCATE pages, recipe_graph CASCADE`);
});

type Saved = { parse: { title: string; text: string; categories?: { category: string; hidden?: boolean }[] } };

/** A saved page's title, the categories the ingest keeps, and its HTML. */
function savedPage(name: string): { title: string; categories: string[]; html: string } {
  const page = (JSON.parse(readFileSync(`tests/fixtures/${name}.json`, 'utf8')) as Saved).parse;
  const categories = (page.categories ?? []).filter((c) => !c.hidden).map((c) => c.category.replace(/_/g, ' '));
  return { title: page.title, categories, html: page.text };
}

/** A labelled value of an infobox, as Fandom writes one. */
const data = (label: string, value: string) =>
  `<div class="pi-item pi-data"><h3 class="pi-data-label">${label}</h3><div class="pi-data-value">${value}</div></div>`;
const link = (title: string) => `<a href="/wiki/${title.replace(/ /g, '_')}">${title}</a>`;

/** A page of one infobox: a material, or something made from materials at a station. */
function infoboxPage(title: string, id: string, made?: { at: string; materials: [string, number][] }) {
  const values = [data('Internal ID', id)];
  if (made) {
    values.push(data('Source', link(made.at)));
    values.push(data('Crafting Materials', `<ul>${made.materials.map(([name, qty]) => `<li>${link(name)} x${qty}</li>`).join('')}</ul>`));
  }
  return { title, categories: ['Materials'], html: `<aside class="portable-infobox"><h2 class="pi-title">${title}</h2>${values.join('')}</aside>` };
}

/**
 * Stores a page as the ingest does: its row, its article when it has one
 * (under `slug`, the slug its title makes unless a test says otherwise),
 * and its recipes.
 */
async function store(
  page: { title: string; categories: string[]; html: string },
  options: { article?: string | null; recipesVersion?: number; revid?: number } = {},
): Promise<string> {
  const pageId = nextPageId++;
  const key = `fandom:${pageId}`;
  await handle.db.execute(sql`
    INSERT INTO pages (key, source, page_id, title, url, revid, categories)
    VALUES (${key}, 'fandom', ${pageId}, ${page.title}, ${`https://valheim.fandom.com/wiki/${pageId}`},
            ${options.revid ?? 1}, ${JSON.stringify(page.categories)}::jsonb)
  `);
  const slug = options.article === undefined ? slugify(page.title) : options.article;
  if (slug !== null) {
    await handle.db.execute(sql`
      INSERT INTO articles (page_key, source, title, slug, url)
      VALUES (${key}, 'fandom', ${page.title}, ${slug}, ${`https://valheim.fandom.com/wiki/${pageId}`})
    `);
  }
  await writePageRecipes(handle.db, {
    pageKey: key,
    recipesVersion: options.recipesVersion ?? 1,
    revid: options.revid ?? 1,
    data: extractRecipes(page.html, { title: page.title }),
  });
  return key;
}

/** What the wiki answers for redirects: these, by the title asked. */
const REDIRECTS: Record<string, { to: string; tofragment?: string }> = {
  'Deer trophy': { to: 'Trophies', tofragment: 'Meadows' },
  'Bronze nails': { to: 'Bronze Nails' },
};

/** A wiki that answers redirect questions, and records every title it was asked about. */
function fakeWiki(answer: (titles: string[]) => Promise<Response> | Response = redirectsFor) {
  const asked: string[][] = [];
  const fetchImpl: FetchLike = async (url) => {
    const params = new URL(url).searchParams;
    if (params.get('redirects') !== '1') throw new Error(`unexpected request: ${url}`);
    const titles = params.get('titles')!.split('|');
    asked.push(titles);
    return answer(titles);
  };
  return { asked, client: new MediaWikiClient({ contact: 'test@example.com', fetchImpl, sleep: async () => {} }) };
}

function redirectsFor(titles: string[]): Response {
  const redirects = titles.flatMap((from) => (REDIRECTS[from] ? [{ from, ...REDIRECTS[from] }] : []));
  return new Response(JSON.stringify({ query: { redirects } }), { headers: { 'content-type': 'application/json' } });
}

/** The pages most tests build from: the Iron Sword and what it is made of and at, and a Stagbreaker that needs a Deer trophy. */
async function storeWorld(): Promise<void> {
  await store(savedPage('Iron_Sword'));
  await store(savedPage('Iron'));
  await store({ ...savedPage('Forge'), categories: ['Crafting structures'] });
  await store(infoboxPage('Wood', 'Wood'));
  await store(infoboxPage('Leather Scraps', 'LeatherScraps'));
  await store(infoboxPage('Stagbreaker', 'SledgeStagbreaker', { at: 'Workbench', materials: [['Wood', 20], ['Deer trophy', 1]] }));
  // A page that describes no one thing: its recipes are none, and its row says it was read.
  await store({ title: 'Trophies', categories: ['Trophies'], html: '<p>Trophies are dropped by creatures.</p>' });
}

const BUILT_AT = '2026-10-28T09:00:00.000Z';

const steps = (graph: RecipeGraph, id: string) => graph.recipes.filter((r) => r.product === id && !r.alt);

describe('buildRecipeGraph', () => {
  it("assembles every page's stored recipes and stores the graph readers are served", async () => {
    await storeWorld();
    const { client } = fakeWiki();

    const built = await buildRecipeGraph(handle.db, client, source, BUILT_AT);

    const stored = (await getLatestRecipeGraph(handle.db))!;
    expect(stored.graph.version).toBe(built.version);
    expect(stored.graph.builtAt).toBe(BUILT_AT);
    expect(stored.report).toEqual(built.report);
    expect(steps(stored.graph, 'SwordIron').map((r) => [r.quality, r.station, r.stationLevel, r.inputs])).toEqual([
      [1, 'forge', 2, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 3]]],
      [2, 'forge', 3, [['Wood', 1], ['Iron', 10], ['LeatherScraps', 2]]],
      [3, 'forge', 4, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 4]]],
      [4, 'forge', 5, [['Wood', 3], ['Iron', 30], ['LeatherScraps', 6]]],
    ]);
    // Its kind comes from the categories the ingest stored with the page.
    expect(stored.graph.items.find((i) => i.id === 'forge')).toMatchObject({ kind: 'station', slug: 'forge' });
    expect(built.report).toMatchObject({ items: stored.graph.items.length, recipes: stored.graph.recipes.length });
    expect(await isRecipeGraphBehind(handle.db)).toBe(false);
  });

  it('asks the wiki about the titles the recipes name, and follows its redirects', async () => {
    await storeWorld();
    const { client, asked } = fakeWiki();

    await buildRecipeGraph(handle.db, client, source, BUILT_AT);

    const pages = await rawQuery<{ title: string; categories: string[]; slug: string; data: PageRecipes }>(
      handle.db,
      sql`SELECT p.title, p.categories, a.slug, r.data FROM page_recipes r
          JOIN pages p ON p.key = r.page_key LEFT JOIN articles a ON a.page_key = p.key`,
    );
    const assembly: AssemblyPage[] = pages.map((p) => ({ slug: p.slug, title: p.title, categories: p.categories, recipes: p.data }));
    expect(asked.flat().sort()).toEqual(redirectTitles(assembly));
    // "Deer trophy" leads to a section of the Trophies page: a trophy described there, not an unknown name.
    const graph = (await getLatestRecipeGraph(handle.db))!.graph;
    expect(steps(graph, 'SledgeStagbreaker')[0]!.inputs).toEqual([['Wood', 20], ['page:trophies#deer-trophy', 1]]);
  });

  it('links each item to the article readers have, or to the one its title will make', async () => {
    // An article stored before its page was renamed is still where readers find it.
    await store(savedPage('Iron_Sword'), { article: 'sword-of-iron' });
    // A page `--recipes` found before any ordinary run derived its article.
    await store(savedPage('Iron'), { article: null });
    await store(infoboxPage('Wood', 'Wood'));
    const { client } = fakeWiki();

    await buildRecipeGraph(handle.db, client, source, BUILT_AT);

    const items = (await getLatestRecipeGraph(handle.db))!.graph.items;
    expect(items.find((i) => i.id === 'SwordIron')?.slug).toBe('sword-of-iron');
    expect(items.find((i) => i.id === 'Iron')?.slug).toBe('iron');
  });

  it('records the oldest extractor that read any page as the graph’s own', async () => {
    await store(savedPage('Iron_Sword'), { recipesVersion: 3 });
    await store(savedPage('Iron'), { recipesVersion: 2 });
    const { client } = fakeWiki();

    await buildRecipeGraph(handle.db, client, source, BUILT_AT);

    const [row] = await rawQuery<{ recipes_version: number }>(handle.db, sql`SELECT recipes_version FROM recipe_graph`);
    expect(Number(row!.recipes_version)).toBe(2);
  });

  it('stores nothing when the wiki cannot be asked about redirects, and readers keep the graph they have', async () => {
    await storeWorld();
    const first = await buildRecipeGraph(handle.db, fakeWiki().client, source, BUILT_AT);
    await store(infoboxPage('Antler Pickaxe', 'PickaxeAntler', { at: 'Workbench', materials: [['Wood', 10]] }));

    const down = fakeWiki(() => new Response('unavailable', { status: 503 }));
    await expect(buildRecipeGraph(handle.db, down.client, source, BUILT_AT)).rejects.toThrow(/503/);

    expect((await getLatestRecipeGraph(handle.db))!.graph.version).toBe(first.version);
    expect(await isRecipeGraphBehind(handle.db)).toBe(true);
  });

  it('stores no graph of nothing', async () => {
    await expect(buildRecipeGraph(handle.db, fakeWiki().client, source, BUILT_AT)).rejects.toThrow(/no recipes/);
    await store({ title: 'Trophies', categories: [], html: '<p>No infobox here.</p>' });
    await expect(buildRecipeGraph(handle.db, fakeWiki().client, source, BUILT_AT)).rejects.toThrow(/no recipes/);
    expect(await getLatestRecipeGraph(handle.db)).toBeNull();
  });

  it('counts recipes stored while it assembles as newer than the graph it stores', async () => {
    await storeWorld();
    // Another run stores a new page's recipes while this one waits for the wiki's answer.
    let meanwhile: Promise<string> | null = null;
    const busy = fakeWiki(async (titles) => {
      meanwhile ??= store(infoboxPage('Antler Pickaxe', 'PickaxeAntler', { at: 'Workbench', materials: [['Wood', 10]] }));
      await meanwhile;
      return redirectsFor(titles);
    });

    await buildRecipeGraph(handle.db, busy.client, source, BUILT_AT);

    expect((await getLatestRecipeGraph(handle.db))!.graph.items.some((i) => i.id === 'PickaxeAntler')).toBe(false);
    expect(await isRecipeGraphBehind(handle.db)).toBe(true);
    await buildRecipeGraph(handle.db, fakeWiki().client, source, BUILT_AT);
    expect(await isRecipeGraphBehind(handle.db)).toBe(false);
  });

  it('stores no graph a reader could not decode', async () => {
    await storeWorld();
    const first = await buildRecipeGraph(handle.db, fakeWiki().client, source, BUILT_AT);

    // An assembly that names an item its graph lacks, as a slip in it could.
    vi.resetModules();
    vi.doMock('@/lib/craft/assemble', async (importOriginal) => {
      const real = await importOriginal<typeof Assemble>();
      return {
        ...real,
        assembleGraph: (...args: Parameters<typeof real.assembleGraph>) => {
          const out = real.assembleGraph(...args);
          out.graph.recipes[0]!.inputs.push(['NoSuchItem', 1]);
          return out;
        },
      };
    });
    try {
      const { buildRecipeGraph: build } = await import('@/lib/craft/build');
      await expect(build(handle.db, fakeWiki().client, source, '2026-10-28T10:00:00.000Z')).rejects.toThrow(/NoSuchItem/);
    } finally {
      vi.doUnmock('@/lib/craft/assemble');
      vi.resetModules();
    }
    expect((await getLatestRecipeGraph(handle.db))!.graph.version).toBe(first.version);
  });
});
