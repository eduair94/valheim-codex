import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import type { CraftAmount, CraftObtain, CraftRef, CraftUse, CraftView } from '@/lib/craft/data';
import { ObtainWays } from '@/components/wiki/craft/obtain';
import { StationPath } from '@/components/wiki/craft/station-path';
import { UsedIn } from '@/components/wiki/craft/used-in';

/*
 * The crafting sections at the head of an article's text, rendered as the
 * server renders them: "Cómo se consigue", "Usado en" and a station's
 * upgrades. None of them ships JavaScript of its own: a busy group folds
 * into a `<details>`, and every card is a link, but to the page it is on.
 */

function ref(id: string, name: string, en = name, more: Partial<CraftRef> = {}): CraftRef {
  return { id, name, en, slug: en.toLowerCase().replace(/[^a-z0-9]+/g, '-'), anchor: null, icon: `a/a1/${en.replace(/ /g, '_')}.png?cb=1`, ...more };
}
const amount = (r: CraftRef, qty: number): CraftAmount => ({ ...r, qty });

const BONES = ref('BoneFragments', 'Fragmentos de hueso', 'Bone Fragments');
const DEER_HIDE = ref('DeerHide', 'Cuero de ciervo', 'Deer Hide');
const RESIN = ref('Resin', 'Resin');
const WORKBENCH = ref('piece_workbench', 'Banco de trabajo', 'Workbench');

function use(product: CraftRef, more: Partial<CraftUse> = {}): CraftUse {
  return {
    ...product,
    quality: 1,
    qty: 2,
    method: 'craft',
    station: WORKBENCH,
    stationLevel: 1,
    yield: 1,
    yieldKnown: true,
    ownPage: true,
    inputs: [amount(BONES, 2), amount(DEER_HIDE, 6)],
    ...more,
  };
}

const render = (element: React.ReactElement) => load(renderToString(element));

describe('UsedIn', () => {
  const usedIn: CraftView['usedIn'] = [
    {
      station: WORKBENCH,
      items: [
        // A piece of a set, on the set's page, which opens on another piece.
        use(ref('ArmorLeatherChest', 'Túnica de cuero', 'Leather tunic', { slug: 'leather-armor', anchor: 'chest', icon: null }), {
          quality: 2,
          stationLevel: 2,
          ownPage: false,
        }),
        use(ref('BoltBone', 'Virote de hueso', 'Bone Bolt'), {
          qty: 8,
          stationLevel: 3,
          yield: 20,
          inputs: [amount(BONES, 8), amount(RESIN, 2)],
        }),
        use(ref('bonestack', 'Pila de huesos', 'Bone Stack'), { qty: 50, method: 'build', inputs: [amount(BONES, 50)] }),
      ],
    },
    { station: null, items: [use(ref('Thing', 'Cosa', 'Thing'), { station: null, inputs: [amount(BONES, 2)] })] },
  ];

  it('heads each station group with the station, linked, and how many uses it holds', () => {
    const $ = render(createElement(UsedIn, { usedIn, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es' }));
    expect($('[data-craft="used-in"] h2').text()).toBe('Usado en');
    const heads = $('h3.craft-group-head');
    // What the wiki names no station for is no station's, and not all of it is made by hand.
    expect(heads.map((_, h) => $(h).text()).get()).toEqual(['Banco de trabajo3', 'Sin estación indicada1']);
    expect(heads.first().find('a').attr('href')).toBe('/wiki/a/workbench');
  });

  it('makes each use a card: the thing, its whole recipe with the material first and marked, and where it is made', () => {
    const $ = render(createElement(UsedIn, { usedIn, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es' }));
    const bolt = $('.craft-use').filter((_, card) => $(card).find('.craft-use-link').text() === 'Virote de hueso');
    expect(bolt.find('.craft-use-link').attr('href')).toBe('/wiki/a/bone-bolt');
    expect(bolt.find('.craft-en').text()).toBe('Bone Bolt');
    // No count beside the name, where it read as how many bolts the step
    // makes; what the step makes is said in so many words instead.
    expect(bolt.find('.craft-use-head').text()).toBe('Virote de huesoBone Bolt Rinde ×20');
    const mats = bolt.find('.craft-mat');
    expect(mats.map((_, m) => $(m).text()).get()).toEqual(['Fragmentos de hueso ×8', 'Resin ×2']);
    expect(mats.first().attr('aria-current')).toBe('true');
    // The page's own material goes by its picture, its name left to a screen reader; the rest are written out.
    expect(mats.first().find('.sr-only').text()).toBe('Fragmentos de hueso');
    expect(mats.last().find('.craft-mat-name').text()).toBe('Resin');
    expect(mats.last().attr('aria-current')).toBeUndefined();
    // A Spanish reader shown an English name hears it in English.
    expect(mats.last().find('.craft-mat-name').attr('lang')).toBe('en');
    // Each material has its picture's plate.
    expect(mats.first().find('img').attr('src')).toContain('Bone_Fragments.png');
    // What the step is, with the name: its yield. Where it is made, last.
    expect(bolt.find('.craft-use-head .craft-badge').map((_, b) => $(b).text()).get()).toEqual(['Rinde ×20']);
    expect(bolt.find('.craft-use-meta').text()).toBe('Banco de trabajo · nivel 3');
    // The materials come before where they are put together, as in the game's crafting panel.
    expect(bolt.children().map((_, c) => $(c).attr('class')).get()).toEqual(['craft-use-head', 'craft-mats', 'craft-use-meta']);
  });

  it('marks a use that is an upgrade with the level it goes into, in no forge light: that is for counts and the place the reader is', () => {
    const $ = render(createElement(UsedIn, { usedIn, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es' }));
    const tunic = $('.craft-use').filter((_, card) => $(card).find('.craft-use-link').text() === 'Túnica de cuero');
    // With the thing's name, which it is about, away from the station's own level.
    expect(tunic.find('.craft-use-head .craft-badge').text()).toBe('Mejora al nivel 2');
    expect(tunic.find('.craft-use-meta').text()).toBe('Banco de trabajo · nivel 2');
    expect($('.craft-badge-lit')).toHaveLength(0);
    // An armor piece lives on its set's page, whose levels are its first
    // piece's: the link names none of them.
    expect(tunic.find('.craft-use-link').attr('href')).toBe('/wiki/a/leather-armor');
    // A thing without a picture still holds its plate.
    expect(tunic.find('.craft-use-head .craft-icon').text()).toBe('◆');
  });

  it("opens an upgrade's article at the level the material goes into, where those levels are the thing's own", () => {
    const club = use(ref('Club', 'Garrote', 'Club'), { quality: 2, qty: 5, stationLevel: 2, inputs: [amount(BONES, 5)] });
    const $ = render(
      createElement(UsedIn, { usedIn: [{ station: WORKBENCH, items: [club] }], material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es' }),
    );
    // Opened at its first level the club's card showed wood alone, where this card says five bone fragments.
    expect($('.craft-use-link').attr('href')).toBe('/wiki/a/club#level-2');
    // Making a thing new opens its article as it opens.
    expect(render(createElement(UsedIn, { usedIn, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es' }))('.craft-use-link').eq(1).attr('href')).toBe(
      '/wiki/a/bone-bolt',
    );
  });

  it('names a thing described on the page the reader is on, with no link back to that page', () => {
    const meat = ref('DeerMeat', 'Carne de ciervo', 'Deer Meat');
    const cooked = use(ref('CookedDeerMeat', 'Carne de ciervo cocida', 'Cooked deer meat', { slug: 'deer-meat', anchor: 'cooked' }), {
      qty: 1,
      method: 'cook',
      station: null,
      ownPage: false,
      inputs: [amount(meat, 1)],
    });
    const $ = render(createElement(UsedIn, { usedIn: [{ station: null, items: [cooked] }], material: 'DeerMeat', selfSlug: 'deer-meat', lang: 'es' }));
    const card = $('.craft-use');
    // A tap on it fetched the same page again and changed nothing.
    expect(card.find('a')).toHaveLength(0);
    expect(card.find('.craft-use-name').text()).toBe('Carne de ciervo cocida');
    expect(card.find('.craft-en').text()).toBe('Cooked deer meat');
  });

  it('lists the whole step even when it is the material alone, and says a piece is built near its station', () => {
    const $ = render(createElement(UsedIn, { usedIn, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es' }));
    const stack = $('.craft-use').filter((_, card) => $(card).find('.craft-use-link').text() === 'Pila de huesos');
    expect(stack.find('.craft-use-meta').text()).toBe('Cerca de Banco de trabajo');
    expect(stack.find('.craft-mat').map((_, m) => $(m).text()).get()).toEqual(['Fragmentos de hueso ×50']);
    expect(stack.find('.craft-mat').attr('aria-current')).toBe('true');
  });

  it("says what is made by hand, and speaks the reader's language", () => {
    const $ = render(createElement(UsedIn, { usedIn, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'en' }));
    expect($('h3.craft-group-head').last().text()).toBe('No station stated1');
    expect($('[data-craft="used-in"] h2').text()).toBe('Used in');
    expect($('.craft-badge').first().text()).toBe('Upgrade to level 2');
    // The words are the interface's; the station's name is the view's, here the Spanish fixture's.
    expect($('.craft-use-meta').first().text()).toBe('Banco de trabajo · level 2');
  });

  it("leaves out where a card is made when its group's heading already says it all", () => {
    // Crafted at the group's station as it is built, with no level to add.
    const plain: CraftView['usedIn'] = [{ station: WORKBENCH, items: [use(ref('Club', 'Garrote', 'Club'))] }];
    expect(render(createElement(UsedIn, { usedIn: plain, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es' }))('.craft-use-meta')).toHaveLength(0);
  });

  it('says how a thing with no station is made: by hand, or a piece with the hammer', () => {
    const none: CraftView['usedIn'] = [
      {
        station: null,
        items: [
          use(ref('Torch', 'Antorcha', 'Torch'), { station: null }),
          use(ref('bone_stack', 'Pila de huesos', 'Bone Stack'), { station: null, method: 'build', inputs: [amount(BONES, 50)] }),
        ],
      },
    ];
    const $ = render(createElement(UsedIn, { usedIn: none, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es' }));
    expect($('.craft-use-meta').map((_, m) => $(m).text()).get()).toEqual(['A mano', 'Con el martillo']);
  });

  it("gives a group's station link a thumb's height", () => {
    const $ = render(createElement(UsedIn, { usedIn, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es' }));
    expect($('h3.craft-group-head a').attr('class')).toContain('craft-group-link');
  });

  it("folds a busy group's uses past the first six into a toggle that works without JavaScript", () => {
    const many: CraftView['usedIn'] = [{ station: WORKBENCH, items: Array.from({ length: 12 }, (_, i) => use(ref(`P${i}`, `Pieza ${i}`))) }];
    const $ = render(createElement(UsedIn, { usedIn: many, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es' }));
    expect($('section.craft-group > ul.craft-uses > li.craft-use')).toHaveLength(6);
    const more = $('details.craft-more');
    // How many there are in all, which a phone that shows fewer of them first counts the same.
    expect(more.find('summary .craft-more-closed').text()).toBe('Ver todos (12)');
    expect(more.find('summary .craft-more-open').text()).toBe('Ver menos');
    expect(more.find('.craft-use')).toHaveLength(6);
    expect(render(createElement(UsedIn, { usedIn: many, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'en' }))('.craft-more-closed').text()).toBe('Show all (12)');
  });

  it('is nothing for a material that goes into nothing', () => {
    expect(renderToString(createElement(UsedIn, { usedIn: [], material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es' }))).toBe('');
  });

  it("marks the interface's words when the article around it is in English", () => {
    const $ = render(createElement(UsedIn, { usedIn, material: 'BoneFragments', selfSlug: 'bone-fragments', lang: 'es', uiLang: 'es' }));
    expect($('[data-craft="used-in"]').attr('lang')).toBe('es');
  });
});

describe('ObtainWays', () => {
  const PICKAXE = ref('PickaxeIron', 'Pico de hierro', 'Iron Pickaxe');
  const obtain: CraftObtain[] = [
    {
      how: 'drop',
      from: [
        { name: 'Esqueleto', en: 'Skeleton', slug: 'skeleton', icon: 'a/a1/Skeleton.png?cb=1' },
        { name: 'Rancid remains', en: 'Rancid remains', slug: 'rancid-remains', icon: null },
      ],
      tool: null,
    },
    { how: 'mine', from: [{ name: 'Silver vein', en: 'Silver vein', slug: null, icon: null }], tool: PICKAXE },
    { how: 'buy', from: { name: 'Haldor', en: 'Haldor', slug: 'haldor', icon: null }, coins: 50 },
  ];

  it('names each way and what it is had from, linked to their articles', () => {
    const $ = render(createElement(ObtainWays, { obtain, lang: 'es' }));
    expect($('[data-craft="obtain"] h2').text()).toBe('Cómo se consigue');
    expect($('dt').map((_, dt) => $(dt).text()).get()).toEqual(['Lo sueltan las criaturas', 'Se mina', 'Se compra']);
    const drops = $('.craft-way').first().find('.craft-source');
    // The name, beside its picture's plate (a lichen diamond where there is no picture).
    expect(drops.map((_, s) => $(s).children('span').last().text()).get()).toEqual(['Esqueleto', 'Rancid remains']);
    expect(drops.first().attr('href')).toBe('/wiki/a/skeleton');
    // A source with no Spanish name is marked as English.
    expect(drops.last().find('span[lang="en"]').text()).toBe('Rancid remains');
    // A place with no article is named, not linked.
    expect($('.craft-way').eq(1).find('.craft-source').first().is('span')).toBe(true);
  });

  it('says which tool the job needs, inside its sentence', () => {
    const $ = render(createElement(ObtainWays, { obtain, lang: 'es' }));
    const tool = $('.craft-tool');
    expect(tool.text().replace(/\s+/g, ' ')).toBe('con Pico de hierro');
    expect(tool.find('a').attr('href')).toBe('/wiki/a/iron-pickaxe');
    expect(render(createElement(ObtainWays, { obtain, lang: 'en' }))('.craft-tool > span').first().text()).toBe('with');
  });

  it("gives a trader's price", () => {
    const $ = render(createElement(ObtainWays, { obtain, lang: 'es' }));
    expect($('.craft-coins').text()).toBe('50 monedas');
    expect($('.craft-way').last().find('a').attr('href')).toBe('/wiki/a/haldor');
  });

  it('is nothing for a thing that is made', () => {
    expect(renderToString(createElement(ObtainWays, { obtain: [], lang: 'es' }))).toBe('');
  });
});

describe('StationPath', () => {
  const station: NonNullable<CraftView['station']> = {
    maxLevel: 6,
    extensions: [
      { ...ref('cauldron_ext1_spice', 'Especiero', 'Spice Rack'), inputs: [amount(ref('Dandelion', 'Diente de león', 'Dandelion'), 3)] },
      { ...ref('cauldron_ext3_butchertable', "Butcher's Table", "Butcher's Table"), inputs: [amount(ref('Silver', 'Plata', 'Silver'), 2)] },
    ],
  };

  it('states the rule, the highest level and each upgrade with what it costs', () => {
    const $ = render(createElement(StationPath, { station, facet: 'Cauldron', selfSlug: 'cauldron', lang: 'es' }));
    expect($('[data-craft="station-path"] h2').text()).toBe('Mejoras de la estación');
    expect($('p').first().text()).toContain('Nivel máximo: 6');
    const cards = $('.craft-use');
    expect(cards.map((_, c) => $(c).find('.craft-use-link').text()).get()).toEqual(['Especiero', "Butcher's Table"]);
    expect(cards.first().find('.craft-use-link').attr('href')).toBe('/wiki/a/spice-rack');
    expect(cards.first().find('.craft-mat').text()).toBe('Diente de león ×3');
    // The rule above says each adds a level: no card repeats it.
    expect($('.craft-badge')).toHaveLength(0);
    // Nothing on these cards is the page's own material.
    expect($('.craft-mat-self')).toHaveLength(0);
  });

  it("names an extension described on the station's own page, with no link back to it", () => {
    const smoker = { ...ref('piece_smoker', 'Ahumador', 'Smoker', { slug: 'cauldron', anchor: 'smoker' }), inputs: [amount(ref('Wood', 'Madera', 'Wood'), 10)] };
    const $ = render(
      createElement(StationPath, { station: { ...station, extensions: [...station.extensions, smoker] }, facet: 'Cauldron', selfSlug: 'cauldron', lang: 'es' }),
    );
    const card = $('.craft-use').last();
    expect(card.find('a')).toHaveLength(0);
    expect(card.find('.craft-use-name').text()).toBe('Ahumador');
    expect($('.craft-use-link')).toHaveLength(2);
  });

  it('links to what is made at the station by the name the lists filter by, and leaves the link out without one', () => {
    const $ = render(createElement(StationPath, { station, facet: 'Black forge', selfSlug: 'black-forge', lang: 'es' }));
    expect($('a.craft-action').attr('href')).toBe('/wiki/c/all?station=Black+forge');
    expect($('a.craft-action').text()).toContain('Qué se fabrica acá');
    expect(render(createElement(StationPath, { station, facet: null, selfSlug: 'cauldron', lang: 'es' }))('a.craft-action')).toHaveLength(0);
  });
});
