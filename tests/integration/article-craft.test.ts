import { readFile } from 'node:fs/promises';
import { renderToString } from 'react-dom/server';
import { load } from 'cheerio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { GraphItem, GraphRecipe, GraphReport, ItemId, RecipeGraph } from '@/lib/craft/types';
import type { Db, DbHandle } from '@/lib/db/create-db';
import { getRecipeBasis, writeRecipeGraph } from '@/lib/db/recipe-repo';
import { upsertArticle } from '@/lib/db/wiki-repo';
import { extractArticle } from '@/lib/wiki/article';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import { slugify } from '@/lib/wiki/slug';
import { createTestDb } from '../helpers/db';
import { withLang } from '../helpers/lang';

/**
 * The article route with the recipe graph, on PGlite: the page loads the
 * article and the item's slice side by side, and renders the craft card in
 * place of the recipe rows, "Cómo se consigue" and "Usado en" for a raw
 * material, a station's upgrades; an article the graph does not know is the
 * page it always was.
 *
 * The route's own module runs, with its request (cookies, headers, sign-in)
 * stood in for and the data cache running every function, as in the other
 * loaders' tests.
 */
const state = vi.hoisted(() => ({ db: null as unknown, lang: 'es' }));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) =>
      JSON.parse(JSON.stringify(await fn(...args))) as unknown,
}));
vi.mock('@/lib/db/client', () => ({ getDb: async () => state.db }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'wv_lang' ? { value: state.lang } : undefined) }),
  headers: async () => new Headers({ 'user-agent': 'test' }),
}));
vi.mock('@/lib/auth/principal-server', () => ({ getChatPrincipal: async () => null }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  usePathname: () => '/wiki/a/iron-sword',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {} }),
}));

const { default: ArticleRoutePage } = await import('@/app/wiki/a/[slug]/page');

/* -------------------------------------------------------------------------- */
/* The graph                                                                   */
/* -------------------------------------------------------------------------- */

function step(product: ItemId, quality: number, station: ItemId | null, level: number, inputs: [ItemId, number][], more: Partial<GraphRecipe> = {}): GraphRecipe {
  return { product, quality, station, stationLevel: level, yield: 1, yieldKnown: true, inputs, method: 'craft', from: product, ...more };
}
const article = (id: ItemId, en: string, more: Partial<GraphItem> = {}): GraphItem => ({ id, en, slug: slugify(en), kind: 'item', maxQuality: 1, ...more });

const GRAPH: RecipeGraph = {
  v: 1,
  version: 'article-craft',
  builtAt: '2026-10-28T00:00:00.000Z',
  items: [
    article('SwordIron', 'Iron Sword', { maxQuality: 4 }),
    article('Wood', 'Wood'),
    article('Iron', 'Iron'),
    article('LeatherScraps', 'Leather Scraps'),
    article('BoneFragments', 'Bone Fragments', { obtain: [{ how: 'drop', from: ['Skeleton'] }] }),
    article('Club', 'Club', { maxQuality: 2 }),
    article('forge', 'Forge', { kind: 'station', station: { maxLevel: 2, extensions: ['forge_ext1'] } }),
    article('forge_ext1', 'Forge Cooler', { kind: 'extension', extends: 'forge' }),
    article('piece_workbench', 'Workbench', { kind: 'station' }),
    article('FineWood', 'Finewood'),
    article('Copper', 'Copper'),
    // Described on the page of what it is made of, as a cooked meat is on the raw meat's.
    { id: 'bone_stack', en: 'Bone Stack', slug: 'bone-fragments', anchor: 'bone-stack', kind: 'piece', maxQuality: 1 },
  ],
  recipes: [
    step('SwordIron', 1, 'forge', 2, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 3]]),
    step('SwordIron', 2, 'forge', 3, [['Wood', 1], ['Iron', 10], ['LeatherScraps', 2]]),
    step('SwordIron', 3, 'forge', 4, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 4]]),
    step('SwordIron', 4, 'forge', 5, [['Wood', 3], ['Iron', 30], ['LeatherScraps', 6]]),
    step('Club', 1, 'piece_workbench', 1, [['Wood', 6]]),
    step('Club', 2, 'piece_workbench', 2, [['Wood', 3], ['BoneFragments', 4]]),
    step('forge', 1, 'piece_workbench', 1, [['Wood', 10], ['Copper', 6]], { method: 'build' }),
    step('forge_ext1', 1, 'forge', 1, [['FineWood', 25], ['Copper', 10]], { method: 'build' }),
    step('bone_stack', 1, null, 1, [['BoneFragments', 50]], { method: 'build' }),
  ],
};

const REPORT: GraphReport = { items: 0, recipes: 0, products: 0, raw: 0, unresolved: [], cycles: [], levelConflicts: [], duplicates: [], yieldSuspects: [] };

/* -------------------------------------------------------------------------- */
/* The articles                                                                */
/* -------------------------------------------------------------------------- */

let nextPageId = 1;

async function seed(db: Db, title: string, doc: ArticleDoc): Promise<void> {
  const pageId = nextPageId++;
  const pageKey = `fandom:${pageId}`;
  const url = `https://valheim.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  await db.execute(sql`INSERT INTO pages (key, source, page_id, title, url, revid) VALUES (${pageKey}, 'fandom', ${pageId}, ${title}, ${url}, 1)`);
  await upsertArticle(db, { pageKey, source: 'fandom', title, slug: slugify(title), url, categories: ['Materials'], doc });
}

async function fixture(name: string): Promise<ArticleDoc> {
  const raw = await readFile(`tests/fixtures/${name}.json`, 'utf8');
  return extractArticle((JSON.parse(raw) as { parse: { text: string } }).parse.text);
}

/** A short article: a lead, an infobox of plain rows, one paragraph. */
function plain(title: string, rows: [string, string][]): ArticleDoc {
  return {
    lead: `${title} is an item.`,
    blocks: [{ kind: 'paragraph', section: 'Usage', text: `What the wiki says of ${title}.` }],
    infobox: { title, image: null, common: [{ label: '', rows: rows.map(([label, value]) => ({ label, value })) }], tabs: [] },
    images: [],
    facets: {},
  };
}

/** The route's page for one article, rendered as the server sends it. */
async function page(slug: string, lang: 'es' | 'en' = 'es') {
  state.lang = lang;
  const element = await ArticleRoutePage({ params: Promise.resolve({ slug }) });
  return load(renderToString(withLang(lang, element)));
}

describe('the article route with the recipe graph', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
    state.db = handle.db;
    await seed(handle.db, 'Iron Sword', await fixture('Iron_Sword'));
    await seed(handle.db, 'Forge', await fixture('Forge'));
    await seed(handle.db, 'Bone Fragments', plain('Bone Fragments', [['Source', 'Skeleton'], ['Weight', '0.5']]));
    // An item the graph does not know, with a recipe row of its own.
    await seed(handle.db, 'Bronze', plain('Bronze', [['Crafting Materials', 'Copper x2\nTin x1'], ['Weight', '1']]));
    await seed(handle.db, 'Skeleton', plain('Skeleton', [['Type', 'Creature']]));
    await writeRecipeGraph(handle.db, GRAPH, REPORT, 1, await getRecipeBasis(handle.db));
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
  });

  it("shows the Iron Sword's craft card in place of its four recipe rows, at its first level", async () => {
    const $ = await page('iron-sword');
    expect($('.stat-row-recipe')).toHaveLength(0);
    const card = $('[data-craft="card"]');
    expect(card).toHaveLength(1);
    expect(card.attr('data-level')).toBe('1');
    expect(card.find('.craft-tiles li').map((_, li) => $(li).find('.craft-qty').text()).get()).toEqual(['×2', '×20', '×3']);
    expect(card.find('.craft-chip').text()).toBe('Forja · nivel 2');
    // Under the level switcher, above the level's own rows.
    const order = $('[role="tablist"], [data-craft="card"], [role="tabpanel"]')
      .toArray()
      .map((node) => $(node).attr('role') ?? 'card');
    expect(order.slice(0, 3)).toEqual(['tablist', 'card', 'tabpanel']);
    // A weapon is nobody's material and no raw one: the text opens with nothing new.
    expect($('[data-craft="used-in"], [data-craft="obtain"], [data-craft="station-path"]')).toHaveLength(0);
  });

  it("marks the top of an item's article as each of its levels, where a link to one lands", async () => {
    const $ = await page('iron-sword');
    const targets = $('article [id^="level-"]');
    expect(targets.map((_, target) => $(target).attr('id')).get()).toEqual(['level-2', 'level-3', 'level-4']);
    // Ahead of the title: a link to a level opens the article at its top, as any link does.
    const order = $('article [id^="level-"], article h1')
      .toArray()
      .map((node) => (node.tagName === 'h1' ? 'title' : 'target'));
    expect(order).toEqual(['target', 'target', 'target', 'title']);
    // Empty, and nothing a screen reader reads.
    expect(targets.text()).toBe('');
    // An item of one level has nothing to mark.
    expect((await page('bone-fragments'))('[id^="level-"]')).toHaveLength(0);
  });

  it('leaves an article the graph does not know exactly as it was', async () => {
    const $ = await page('bronze');
    expect($('[data-craft]')).toHaveLength(0);
    expect($('.stat-row-recipe')).toHaveLength(1);
  });

  it('opens a raw material\'s text with how it is had, then what it goes into, before the wiki\'s own', async () => {
    const $ = await page('bone-fragments');
    const sections = $('[data-craft], [data-testid="article-body"]')
      .toArray()
      .map((node) => $(node).attr('data-craft') ?? 'body');
    expect(sections).toEqual(['obtain', 'used-in', 'body']);
    // Named as the search names it: Skeleton has no translation, and the vocabulary's word for it.
    expect($('[data-craft="obtain"] .craft-source > span').last().text()).toBe('Esqueleto');
    expect($('[data-craft="obtain"] .craft-source').attr('href')).toBe('/wiki/a/skeleton');
    const club = $('[data-craft="used-in"] .craft-use').first();
    // Opened at the level the bones go into, whose step its own card then shows.
    expect(club.find('.craft-use-link').attr('href')).toBe('/wiki/a/club#level-2');
    expect(club.find('.craft-en').text()).toBe('Club');
    // An upgrade, said with the club's name; and the step listed whole though it is bone alone.
    expect(club.find('.craft-use-head .craft-badge').text()).toBe('Mejora al nivel 2');
    expect(club.find('.craft-mat').first().attr('aria-current')).toBe('true');
    // A raw material has no card: nothing to make.
    expect($('[data-craft="card"]')).toHaveLength(0);
  });

  it('names a thing the article itself describes, with no link back to the article', async () => {
    const $ = await page('bone-fragments');
    const stack = $('[data-craft="used-in"] .craft-use').last();
    expect(stack.find('.craft-use-name').text()).toBe('Bone Stack');
    expect(stack.find('a')).toHaveLength(0);
  });

  it("gives a station its card and its upgrades, with the way to what is made at it", async () => {
    const $ = await page('forge', 'en');
    expect($('[data-craft="card"] h3').text()).toBe('Build');
    expect($('[data-craft="card"] .craft-chip').text()).toBe('Near Workbench');
    const path = $('[data-craft="station-path"]');
    expect(path.find('.craft-use-link').text()).toBe('Forge Cooler');
    // What it takes to build; that each adds a level is said once, above the cards.
    expect(path.find('.craft-mat').length).toBeGreaterThan(0);
    expect(path.find('.craft-badge')).toHaveLength(0);
    // The sword's article names its station "Forge": the list the browse page opens.
    expect(path.find('a.craft-action').attr('href')).toBe('/wiki/c/all?station=Forge');
  });

  it('keeps the article up when the graph cannot be read', async () => {
    await handle.db.execute(sql`DELETE FROM recipe_graph`);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const $ = await page('iron-sword');
      expect($('[data-craft]')).toHaveLength(0);
      expect($('.stat-row-recipe')).toHaveLength(4);
    } finally {
      errors.mockRestore();
      await writeRecipeGraph(handle.db, GRAPH, REPORT, 1, await getRecipeBasis(handle.db));
    }
  });
});
