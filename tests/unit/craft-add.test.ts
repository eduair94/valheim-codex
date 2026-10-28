import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { prerenderToNodeStream } from 'react-dom/static';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { encodeGraph } from '@/lib/craft/codec';
import type { RecipeGraph } from '@/lib/craft/types';
import type { CraftCardData } from '@/components/wiki/craft/card-model';
import { withLang } from '../helpers/lang';

/*
 * The craft card's "Agregar al taller", as it will render once the planner
 * is live (`CRAFT_PLANNER_LIVE`, held open here; `craft-card.test.ts` pins
 * the card as it is while the gate is shut). Before the page hydrates the
 * list on the device is unknown, so the server and the first render agree on
 * the button; the store decides "En tu taller · Ver" afterwards.
 */

vi.mock('@/lib/craft/feature', () => ({ CRAFT_PLANNER_LIVE: true }));

const { CraftCard } = await import('@/components/wiki/craft/craft-card');
const { CraftAdd } = await import('@/components/wiki/craft/craft-add');

const GRAPH: RecipeGraph = {
  v: 1,
  version: 'add',
  builtAt: '2026-10-28T00:00:00.000Z',
  items: [
    { id: 'BronzeNails', en: 'Bronze Nails', es: 'Clavos de bronce', slug: 'bronze-nails', kind: 'item', maxQuality: 1 },
    { id: 'Bronze', en: 'Bronze', es: 'Bronce', slug: 'bronze', kind: 'item', maxQuality: 1 },
    { id: 'forge', en: 'Forge', es: 'Forja', slug: 'forge', kind: 'station', maxQuality: 1 },
  ],
  recipes: [
    { product: 'BronzeNails', quality: 1, station: 'forge', stationLevel: 1, yield: 20, yieldKnown: true, inputs: [['Bronze', 1]], method: 'craft', from: 'Bronze Nails' },
  ],
};

const DATA: CraftCardData = {
  item: { id: 'BronzeNails', name: 'Clavos de bronce', en: 'Bronze Nails', slug: 'bronze-nails', anchor: null, icon: null, kind: 'item', maxQuality: 1 },
  closure: encodeGraph(GRAPH),
};

/** The page as the server sends it, once everything that loads on its own (the button's chunk) has: what `renderToString` would leave as a fallback. */
async function prerendered(element: ReactElement): Promise<string> {
  const { prelude } = await prerenderToNodeStream(element);
  let html = '';
  for await (const chunk of prelude) html += String(chunk);
  return html;
}

describe('Agregar al taller, once the planner is live', () => {
  it('ends the card, under the yield it adds, in the page the server sends', async () => {
    const $ = load(await prerendered(withLang('es', createElement(CraftCard, { data: DATA, lang: 'es' }))));
    expect($('[data-craft="card"] button').last().text()).toBe('Agregar al taller');
    expect($('[data-craft="card"]').text()).toContain('Rinde ×20 · 20 en total');
  });

  it('is a button before the page hydrates, with a polite line for what it did', () => {
    const $ = load(
      renderToString(withLang('en', createElement(CraftAdd, { target: { id: 'BronzeNails', level: 1, from: 0, qty: 20 }, lang: 'en' }))),
    );
    expect($('button').text()).toBe('Add to Craft');
    expect($('[aria-live="polite"]')).toHaveLength(1);
    expect($('a[href="/wiki/craft"]')).toHaveLength(0);
  });
});
