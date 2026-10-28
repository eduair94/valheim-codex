import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { encodeGraph } from '@/lib/craft/codec';
import { CRAFT_PLANNER_LIVE } from '@/lib/craft/feature';
import type { GraphItem, GraphRecipe, ItemId, RecipeGraph } from '@/lib/craft/types';
import { extractArticle } from '@/lib/wiki/article';
import type { ArticleInfobox, InfoboxGroup } from '@/lib/wiki/article-types';
import { buildLinker } from '@/lib/wiki/links';
import { expandIcon } from '@/lib/wiki/title-search';
import { thumbnailImageUrl } from '@/lib/wiki/image-url';
import type { CraftCardData } from '@/components/wiki/craft/card-model';
import { CraftCard } from '@/components/wiki/craft/craft-card';
import { iconUrl } from '@/components/wiki/craft/icon';
import { Infobox } from '@/components/wiki/article/infobox';
import { LevelProvider } from '@/components/wiki/article/level-context';
import { StatGroup } from '@/components/wiki/article/stat-group';
import { withLang } from '../helpers/lang';

/*
 * The craft card as the server renders it (`craft-card.tsx`), and in its
 * place in the infobox: the recipe at the first level, this level's step,
 * one craft, so a reader without JavaScript still sees it; the recipe rows
 * it replaces gone; and nothing that leads to the planner while the planner
 * is shut.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/wiki/a/iron-sword',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {} }),
}));

function step(product: ItemId, quality: number, station: ItemId | null, level: number, inputs: [ItemId, number][], more: Partial<GraphRecipe> = {}): GraphRecipe {
  return { product, quality, station, stationLevel: level, yield: 1, yieldKnown: true, inputs, method: 'craft', from: product, ...more };
}

const item = (id: ItemId, en: string, es: string | null, more: Partial<GraphItem> = {}): GraphItem => ({
  id,
  en,
  ...(es ? { es } : {}),
  slug: en.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  icon: `a/a1/${en.replace(/ /g, '_')}.png?cb=1`,
  kind: 'item',
  maxQuality: 1,
  ...more,
});

/** The sword's slice of the graph, as the page hands it to the card, in Spanish. */
const GRAPH: RecipeGraph = {
  v: 1,
  version: 'card',
  builtAt: '2026-10-28T00:00:00.000Z',
  items: [
    item('SwordIron', 'Iron Sword', 'Espada de hierro', { maxQuality: 4 }),
    item('Wood', 'Wood', 'Madera'),
    item('Iron', 'Iron', 'Hierro'),
    item('IronScrap', 'Scrap Iron', 'Chatarra de hierro'),
    item('LeatherScraps', 'Leather Scraps', 'Recortes de cuero'),
    item('Coal', 'Coal', 'Carbón'),
    // No Spanish name anywhere: shown in English, and marked so.
    item('Resin', 'Resin', null),
    item('forge', 'Forge', 'Forja', { kind: 'station' }),
    item('smelter', 'Smelter', 'Fundidora', { kind: 'station' }),
  ],
  recipes: [
    step('SwordIron', 1, 'forge', 2, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 3]]),
    step('SwordIron', 2, 'forge', 3, [['Wood', 1], ['Iron', 10], ['LeatherScraps', 2]]),
    step('SwordIron', 3, 'forge', 4, [['Wood', 2], ['Iron', 20], ['LeatherScraps', 4], ['Resin', 1]]),
    step('SwordIron', 4, 'forge', 5, [['Wood', 3], ['Iron', 30], ['LeatherScraps', 6]]),
    step('Iron', 1, 'smelter', 1, [['IronScrap', 1]], { method: 'smelt', fuel: ['Coal', 2] }),
  ],
};

const DATA: CraftCardData = {
  item: { id: 'SwordIron', name: 'Espada de hierro', en: 'Iron Sword', slug: 'iron-sword', anchor: null, icon: null, kind: 'item', maxQuality: 4 },
  closure: encodeGraph(GRAPH),
};

/**
 * The sword's card as the server renders it, under the infobox's level
 * switcher (`LevelProvider`) as on the sword's page, or with none (`null`),
 * as on a page whose infobox shows no levels.
 */
const card = (lang: 'es' | 'en' = 'es', qualities: number[] | null = [1, 2, 3, 4]) => {
  const element = createElement(CraftCard, { data: DATA, lang });
  return load(renderToString(withLang(lang, qualities ? createElement(LevelProvider, { qualities }, element) : element)));
};

describe('CraftCard, as the server renders it', () => {
  it('shows the first level, this level only, one craft', () => {
    const $ = card();
    const root = $('[data-craft="card"]');
    expect(root.attr('data-level')).toBe('1');
    expect(root.find('h3').text()).toBe('Fabricar');
    expect(root.find('[aria-pressed="true"]').text()).toBe('Este nivel');
    // No "levels 1 to N" at the first level, where it is this level.
    expect(root.find('.craft-mode').map((_, b) => $(b).text()).get()).toEqual(['Este nivel', 'Materias primas']);
    expect(root.find('input').attr('value')).toBe('1');
    expect(root.text()).toContain('Necesitás:');
  });

  it('calls the step its recipe where the page shows no levels to pick, whatever levels the item has', () => {
    // A Spanish page whose translation was made before its infobox had level
    // tabs: the card stays at the first level, and no level is named anywhere.
    const $ = card('es', null);
    expect($('[data-craft="card"]').attr('data-level')).toBe('1');
    expect($('.craft-mode').map((_, b) => $(b).text()).get()).toEqual(['Receta', 'Materias primas']);
    expect(card('en', null)('.craft-mode').first().text()).toBe('Recipe');
  });

  it("lists the materials as the recipe row's tiles: the reader's name, the English one, the count", () => {
    const $ = card();
    const tiles = $('.craft-tiles li');
    expect(tiles.map((_, t) => $(t).find('.craft-name').text()).get()).toEqual(['Madera', 'Hierro', 'Recortes de cuero']);
    expect(tiles.map((_, t) => $(t).find('.craft-en').text()).get()).toEqual(['Wood', 'Iron', 'Leather Scraps']);
    expect(tiles.map((_, t) => $(t).find('.craft-qty').text()).get()).toEqual(['×2', '×20', '×3']);
    // The count closes the tile, on its own, so in a column of tiles the counts line up.
    expect(tiles.first().find('.craft-tile > .craft-qty')).toHaveLength(1);
    // A link's name still reads in order: "Madera Wood ×2".
    expect(tiles.first().find('a').text().replace(/\s+/g, ' ').trim()).toBe('Madera Wood ×2');
    expect(tiles.first().find('a').attr('href')).toBe('/wiki/a/wood');
    // Asked for at the size it is drawn, from the icon path the graph keeps; never enlarged.
    const img = tiles.first().find('img');
    expect(img.attr('src')).toBe(thumbnailImageUrl(expandIcon('a/a1/Wood.png?cb=1'), 32));
    expect(img.attr('class')).toContain('object-scale-down');
    expect(img.attr('referrerpolicy')).toBe('no-referrer');
  });

  it('names where it is made, linked to the station', () => {
    const chip = card()('.craft-chip');
    expect(chip.text()).toBe('Forja · nivel 2');
    expect(chip.attr('href')).toBe('/wiki/a/forge');
    expect(card('en')('.craft-chip').text()).toBe('Forge · level 2');
  });

  it('says the totals once, politely, for a screen reader', () => {
    const live = card()('[aria-live="polite"]');
    expect(live.text()).toBe('Necesitás: Madera ×2, Hierro ×20, Recortes de cuero ×3.');
    expect(live.attr('class')).toContain('sr-only');
  });

  it('names its stepper buttons and keeps the count field numeric', () => {
    const $ = card();
    expect($('.craft-bump').map((_, b) => $(b).attr('aria-label')).get()).toEqual(['Uno menos', 'Uno más']);
    // At one craft, "one fewer" is unavailable but stays in the tab order.
    expect($('.craft-bump').first().attr('aria-disabled')).toBe('true');
    expect($('input').attr('inputmode')).toBe('numeric');
    expect($(`label[for="${$('input').attr('id')}"]`).text()).toBe('Cantidad');
  });

  it('leads nowhere near the planner while the planner is shut', () => {
    expect(CRAFT_PLANNER_LIVE).toBe(false);
    const $ = card();
    expect($('a[href^="/wiki/craft"]')).toHaveLength(0);
    expect($('button').filter((_, b) => $(b).text().includes('Agregar al taller'))).toHaveLength(0);
  });

  it('calls the step of a thing with no levels its recipe, not "this level"', () => {
    const bronze: RecipeGraph = {
      ...GRAPH,
      items: [
        item('Bronze', 'Bronze', 'Bronce'),
        item('Copper', 'Copper', 'Cobre'),
        item('CopperOre', 'Copper Ore', 'Mineral de cobre'),
        item('Coal', 'Coal', 'Carbón'),
        item('forge', 'Forge', 'Forja', { kind: 'station' }),
        item('smelter', 'Smelter', 'Fundidora', { kind: 'station' }),
      ],
      recipes: [
        step('Bronze', 1, 'forge', 1, [['Copper', 2]]),
        step('Copper', 1, 'smelter', 1, [['CopperOre', 1]], { method: 'smelt', fuel: ['Coal', 2] }),
      ],
    };
    const data: CraftCardData = {
      item: { id: 'Bronze', name: 'Bronce', en: 'Bronze', slug: 'bronze', anchor: null, icon: null, kind: 'item', maxQuality: 1 },
      closure: encodeGraph(bronze),
    };
    const $ = load(renderToString(withLang('es', createElement(CraftCard, { data, lang: 'es' }))));
    expect($('.craft-mode').map((_, b) => $(b).text()).get()).toEqual(['Receta', 'Materias primas']);
    const en = load(renderToString(withLang('en', createElement(CraftCard, { data, lang: 'en' }))));
    expect(en('.craft-mode').first().text()).toBe('Recipe');
  });

  it("names the piece it is for on a set's page, whose own name is the set's", () => {
    const set: CraftCardData = {
      item: {
        ...DATA.item,
        name: 'Casco de cuero',
        en: 'Leather helmet',
        slug: 'leather-armor',
        anchor: 'head',
        icon: 'a/a1/Leather_Helmet.png?cb=1',
      },
      closure: encodeGraph({
        ...GRAPH,
        items: GRAPH.items.map((i) => (i.id === 'SwordIron' ? { ...i, es: 'Casco de cuero', en: 'Leather helmet', slug: 'leather-armor', anchor: 'head' } : i)),
      }),
    };
    const $ = load(renderToString(withLang('es', createElement(CraftCard, { data: set, lang: 'es' }))));
    const piece = $('.craft-card-item');
    expect(piece.find('.craft-card-item-name').text()).toBe('Casco de cuero');
    expect(piece.find('.craft-en').text()).toBe('Leather helmet');
    expect(piece.find('img').attr('src')).toBe(iconUrl('a/a1/Leather_Helmet.png?cb=1', 32));
    // The page's own item needs no such line: the page's title names it.
    expect(card()('.craft-card-item')).toHaveLength(0);
  });

  it("shows an English reader the English names alone, whatever the slice carries", () => {
    const $ = card('en');
    expect($('.craft-tiles .craft-name').map((_, n) => $(n).text()).get()).toEqual(['Wood', 'Iron', 'Leather Scraps']);
    // Nothing to mark and nothing to put beside: it is all English.
    expect($('.craft-name[lang]')).toHaveLength(0);
    expect($('.craft-en')).toHaveLength(0);
    expect($('h3').text()).toBe('Craft');
  });
});

describe('icons', () => {
  it('builds the address the title index would, at the size drawn', () => {
    for (const icon of ['a/a1/Wood.png?cb=1', "1/19/Smith%27s_Anvil.png?cb=20210215131621", 'b/b5/Antler_Pickaxe.png']) {
      expect(iconUrl(icon, 32)).toBe(thumbnailImageUrl(expandIcon(icon), 32));
    }
    const full = 'https://static.wikia.nocookie.net/valheim/images/d/df/Wood.png/revision/latest?cb=1';
    expect(iconUrl(full, 24)).toBe(thumbnailImageUrl(full, 24));
  });
});

describe('the card in the infobox', () => {
  const linker = buildLinker([]);
  const ask = { href: '/', locked: false, lockedNote: '' };

  async function sword(): Promise<ArticleInfobox> {
    const raw = await readFile('tests/fixtures/Iron_Sword.json', 'utf8');
    return (await extractArticle((JSON.parse(raw) as { parse: { text: string } }).parse.text)).infobox!;
  }

  const infobox = (box: ArticleInfobox, craft: CraftCardData | null, layout: 'side' | 'spread' = 'side') =>
    load(
      renderToString(
        withLang(
          'es',
          createElement(Infobox, { infobox: box, lang: 'es', linker, ingredientTargets: {}, recipeSources: {}, ask, layout, craft }),
        ),
      ),
    );

  it("takes the recipe rows' place, under the level switcher and above the level's rows", async () => {
    const $ = infobox(await sword(), DATA);
    expect($('.stat-row-recipe')).toHaveLength(0);
    const order = $('[role="tablist"], [data-craft="card"], [role="tabpanel"]')
      .toArray()
      .map((node) => $(node).attr('role') ?? 'card');
    expect(order.slice(0, 3)).toEqual(['tablist', 'card', 'tabpanel']);
    // The switcher names the level, so the card's step is this level's.
    expect($('.craft-mode').first().text()).toBe('Este nivel');
  });

  it('leaves an infobox the graph has no card for exactly as it was, recipe rows and all', async () => {
    const box = await sword();
    const $ = infobox(box, null);
    expect($('[data-craft="card"]')).toHaveLength(0);
    expect($('.stat-row-recipe')).toHaveLength(4);
  });

  it('leads an infobox with no levels, spanning a spread box', () => {
    const box: ArticleInfobox = {
      title: 'Bronze',
      image: null,
      common: [
        { label: 'Crafting', rows: [{ label: 'Crafting Materials', value: 'Copper x2\nTin x1' }] },
        { label: 'Properties', rows: [{ label: 'Weight', value: '1' }] },
      ],
      tabs: [],
    };
    const $ = infobox(box, DATA, 'spread');
    const first = $('aside > div').first().children().first();
    expect(first.find('[data-craft="card"]')).toHaveLength(1);
    expect(first.attr('class')).toContain('lg:[column-span:all]');
    // The group that held only the recipe is gone; the rest stay.
    expect($('.stat-group h3').map((_, h) => $(h).text()).get()).toEqual(['Properties']);
    expect($('.stat-row-recipe')).toHaveLength(0);
    // The sword has levels, but this box names none: its card's step is the recipe.
    expect($('.craft-mode').first().text()).toBe('Receta');
  });
});

describe('StatGroup with a card', () => {
  const linker = buildLinker([]);
  const group = (rows: InfoboxGroup['rows']): InfoboxGroup => ({ label: 'Crafting', rows });
  const render = (g: InfoboxGroup, hideRecipe: boolean) =>
    renderToString(createElement(StatGroup, { group: g, lang: 'es', ingredientTargets: {}, recipeSources: {}, linker, hideRecipe }));

  it('renders nothing for a group whose only row is the recipe', () => {
    expect(render(group([{ label: 'Crafting Materials', value: 'Wood x2' }]), true)).toBe('');
  });

  it('keeps the other rows, and the recipe where there is no card', () => {
    const rows = [
      { label: 'Crafting Materials', value: 'Wood x2' },
      { label: 'Crafting Level', value: '2' },
    ];
    expect(load(render(group(rows), true))('.stat-row').length).toBe(1);
    expect(load(render(group(rows), false))('.stat-row-recipe').length).toBe(1);
  });
});
