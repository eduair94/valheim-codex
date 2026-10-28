import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { LEVEL_FRAGMENT, LevelProvider, levelFromHash, levelHash, useLevel } from '@/components/wiki/article/level-context';
import { levelQualities } from '@/components/wiki/article/infobox-model';
import { LevelTabs } from '@/components/wiki/article/level-tabs';
import { articleLevelHref } from '@/lib/routes';

/*
 * One selected level per article (`level-context.tsx`): the level switcher
 * and the craft card follow it, and `#level-4` in the address picks it.
 *
 * What runs only in a browser (the address read once hydrated, a level
 * written back with `replaceState`, Back and Forward) is checked there; this
 * pins the rules it runs on and what the server renders.
 */

describe('levelFromHash', () => {
  it('finds the tab a level fragment names', () => {
    expect(levelFromHash('#level-4', [1, 2, 3, 4])).toBe(3);
    expect(levelFromHash('#level-1', [1, 2, 3, 4])).toBe(0);
  });

  it('reads the tabs by their numbers, not their places', () => {
    expect(levelFromHash('#level-3', [2, 3, 4])).toBe(1);
  });

  it('ignores a level the article does not have, and every other fragment', () => {
    for (const hash of ['#level-9', '#level-x', '', '#', '#level-', '#level-004', '#main', 'level-4', '#level-4 ', '#LEVEL-4']) {
      expect(levelFromHash(hash, [1, 2, 3, 4]), hash).toBeNull();
    }
  });

  it('reads the fragments the article links write', () => {
    for (const level of [2, 3, 4]) {
      const hash = articleLevelHref('iron-sword', level).slice('/wiki/a/iron-sword'.length);
      expect(hash).toMatch(LEVEL_FRAGMENT);
      expect(levelFromHash(hash, [1, 2, 3, 4])).toBe(level - 1);
    }
  });
});

describe('levelHash', () => {
  it('writes no fragment for the first level, where the article opens anyway', () => {
    expect(levelHash([1, 2, 3, 4], 0)).toBe('');
  });

  it("writes a level's own number, as an article link does", () => {
    expect(levelHash([1, 2, 3, 4], 3)).toBe('#level-4');
    expect(levelHash([2, 3, 4], 2)).toBe('#level-4');
    expect(`/wiki/a/iron-sword${levelHash([1, 2, 3, 4], 2)}`).toBe(articleLevelHref('iron-sword', 3));
  });

  it('writes nothing for a tab that is not there', () => {
    expect(levelHash([1, 2], 5)).toBe('');
  });
});

describe('levelQualities', () => {
  it('reads upgrade levels as their numbers', () => {
    expect(levelQualities(['1', '2', '3', '4'])).toEqual([1, 2, 3, 4]);
    expect(levelQualities([' 1 ', '2'])).toEqual([1, 2]);
  });

  it('gives a star set or a set of variants no levels, so the address never moves their switcher', () => {
    expect(levelQualities(['0★', '1★'])).toBeNull();
    expect(levelQualities(['0★', '1★', '2★', 'Trophy'])).toBeNull();
    expect(levelQualities(['Raw', 'Cooked'])).toBeNull();
    expect(levelQualities([])).toBeNull();
  });
});

/** What a component inside the provider sees. */
function Probe() {
  const level = useLevel();
  return createElement('p', { 'data-index': level ? String(level.index) : 'none', 'data-qualities': level?.qualities.join(',') });
}

const TABS = ['Nivel 1', 'Nivel 2', 'Nivel 3', 'Nivel 4'].map((text) => ({ text }));
const panels = TABS.map((tab, i) => createElement('div', { key: i, 'data-panel': String(i) }, tab.text));

describe('LevelProvider', () => {
  it('starts at the first level on the server, whatever the address will say, so hydration agrees', () => {
    const $ = load(renderToString(createElement(LevelProvider, { qualities: [1, 2, 3, 4] }, createElement(Probe))));
    expect($('p').attr('data-index')).toBe('0');
    expect($('p').attr('data-qualities')).toBe('1,2,3,4');
  });

  it('is nothing outside an article with levels', () => {
    expect(load(renderToString(createElement(Probe)))('p').attr('data-index')).toBe('none');
  });

  it("drives the level tabs inside it, with the card's slot between the switcher and the rows it changes", () => {
    const html = renderToString(
      createElement(
        LevelProvider,
        { qualities: [1, 2, 3, 4] },
        createElement(LevelTabs, {
          label: 'Niveles de mejora',
          hint: 'Cada nivel…',
          tabs: TABS,
          panels,
          before: createElement('section', { id: 'card' }, 'card'),
        }),
      ),
    );
    const $ = load(html);
    expect($('[role="tab"][aria-selected="true"]').text()).toBe('Nivel 1');
    expect($('[role="tabpanel"]:not([hidden])').text()).toBe('Nivel 1');

    // Document order: the switcher, its hint, the card, then the level's rows.
    const order = $('[role="tablist"], p, #card, [role="tabpanel"]')
      .toArray()
      .map((node) => ($(node).attr('role') ?? $(node).attr('id') ?? node.tagName));
    expect(order.indexOf('tablist')).toBeLessThan(order.indexOf('card'));
    expect(order.indexOf('card')).toBeLessThan(order.indexOf('tabpanel'));
    // Outside the panels' columns, so that spread it spans all three.
    expect($('#card').closest('[role="tabpanel"]')).toHaveLength(0);
  });

  it('leaves a switcher with no provider to keep its own level, as stars and variants do', () => {
    const $ = load(renderToString(createElement(LevelTabs, { label: 'Niveles de estrella', tabs: TABS, panels })));
    expect($('[role="tab"][aria-selected="true"]').text()).toBe('Nivel 1');
    expect($('#card')).toHaveLength(0);
  });
});
