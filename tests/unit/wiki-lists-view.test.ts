import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load, type CheerioAPI } from 'cheerio';
import type { ArticleSummary, CompareTable } from '@/lib/db/wiki-repo';
import { CategoryGrid } from '@/components/wiki/category-grid';
import { contentDescription, type CategoryContent } from '@/components/wiki/category-view';
import { CategoryList } from '@/components/wiki/lists/category-list';
import { shownColumnsOnly } from '@/components/wiki/lists/compare-model';
import { CompareView } from '@/components/wiki/lists/compare-view';
import { withLang } from '../helpers/lang';

const render = (element: ReturnType<typeof createElement>): CheerioAPI => load(renderToStaticMarkup(element));

/**
 * Tailwind utilities that set `display` at the base breakpoint. `line-clamp-*`
 * is a display of its own (`-webkit-box`), and any of these on the same
 * element comes after it in the stylesheet and switches the clamp off: the
 * compare view's Description cells ran to ten lines that way.
 */
const DISPLAY = new Set(['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'table', 'contents']);

function clampsThatHold($: CheerioAPI): { clamped: number; overridden: string[] } {
  const overridden: string[] = [];
  const clamped = $('[class*="line-clamp-"]').each((_, el) => {
    const classes = ($(el).attr('class') ?? '').split(/\s+/);
    if (classes.some((name) => DISPLAY.has(name))) overridden.push(classes.join(' '));
  }).length;
  return { clamped, overridden };
}

const table: CompareTable = {
  columns: ['Damage', 'Description'],
  columnLabels: { Damage: 'Daño', Description: 'Descripción' },
  rows: [
    {
      slug: 'bronze-sword',
      title: 'Espada de bronce',
      icon: null,
      values: {
        Damage: '35',
        Description: 'A sturdy blade of bronze. '.repeat(12),
        'Internal ID': 'SwordBronze',
        Usage: 'Hit things',
      },
      valuesTranslated: false,
    },
    { slug: 'iron-sword', title: 'Espada de hierro', icon: null, values: { Damage: '55' }, shownTab: '3' },
  ],
};

describe('shownColumnsOnly', () => {
  it('keeps only the values of the columns the table shows', () => {
    // The rest of an infobox used to travel to every reader and never be drawn.
    const shown = shownColumnsOnly(table);
    expect(shown.rows[0]?.values).toEqual({ Damage: '35', Description: table.rows[0]?.values.Description });
    expect(shown.rows[1]?.values).toEqual({ Damage: '55' });
  });

  it('keeps everything else about the table and its rows', () => {
    const shown = shownColumnsOnly(table);
    expect(shown.columns).toEqual(table.columns);
    expect(shown.columnLabels).toEqual(table.columnLabels);
    expect(shown.rows[1]).toMatchObject({ slug: 'iron-sword', title: 'Espada de hierro', shownTab: '3' });
    expect(shown.rows[0]?.valuesTranslated).toBe(false);
  });

  it('reads own values only, and leaves the table it was given alone', () => {
    const odd: CompareTable = { columns: ['constructor'], rows: [{ slug: 'a', title: 'A', icon: null, values: {} }] };
    expect(shownColumnsOnly(odd).rows[0]?.values).toEqual({});
    shownColumnsOnly(table);
    expect(Object.keys(table.rows[0]?.values ?? {})).toHaveLength(4);
  });
});

describe('contentDescription', () => {
  const list: CategoryContent = { view: 'list', articles: [{} as ArticleSummary, {} as ArticleSummary] };
  const compared = (rows: number, listed: number | null): CategoryContent => ({
    view: 'compare',
    table: { columns: ['Damage'], rows: Array.from({ length: rows }, () => table.rows[1]!) },
    tabs: [],
    tab: null,
    listed,
  });

  it('counts a list’s articles', () => {
    expect(contentDescription(list, 'Armas', 'es')).toBe(
      'Armas: 2 artículos de la wiki de Valheim, con la fuente original a la vista.',
    );
  });

  it('counts the items a comparison has stats for, not "artículos"', () => {
    expect(contentDescription(compared(138, null), 'Armas', 'es')).toBe(
      'Comparación de Armas: 138 con stats, lado a lado, de la wiki de Valheim.',
    );
    expect(contentDescription(compared(1027, null), 'Weapons', 'en')).toBe(
      'Weapons compared: 1,027 with stats, side by side, from the Valheim wiki.',
    );
  });

  it('describes a comparison with no stats as its list', () => {
    // "Guías: 0 artículos", of a category with ten.
    expect(contentDescription(compared(0, 10), 'Guías', 'es')).toBe(
      'Guías: 10 artículos de la wiki de Valheim, con la fuente original a la vista.',
    );
    expect(contentDescription(compared(0, 1), 'Guides', 'en')).toContain('Guides: 1 article from');
  });
});

describe('line clamps', () => {
  it('hold on the compare view’s prose cells', () => {
    const $ = render(withLang('es', createElement(CompareView, { lang: 'es', title: 'Armas', table, levels: null })));
    const { clamped, overridden } = clampsThatHold($);
    expect(clamped).toBeGreaterThan(0);
    expect(overridden).toEqual([]);
    expect($('td[lang="en"] .line-clamp-3').text()).toContain('A sturdy blade of bronze.');
  });

  it('hold on the list’s names and leads, and never cut a name to one line', () => {
    const articles: ArticleSummary[] = [
      {
        slug: 'gourmet-bowl',
        title: 'Cuenco gourmet de las Tierras Cenicientas',
        englishTitle: 'Ashlands gourmet bowl',
        lead: 'A rich bowl.',
        translated: false,
        icon: null,
        facets: {},
      } as unknown as ArticleSummary,
    ];
    const $ = render(createElement(CategoryList, { articles, lang: 'es' }));
    const { clamped, overridden } = clampsThatHold($);
    expect(clamped).toBe(2);
    expect(overridden).toEqual([]);
    const name = $('span').filter((_, el) => $(el).text() === 'Cuenco gourmet de las Tierras Cenicientas');
    expect(name.attr('class')).toContain('line-clamp-2');
    expect(name.attr('class')).not.toContain('truncate');
  });
});

describe('CategoryGrid pictures', () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    name: `Biome ${index}`,
    count: 10,
    icon: `https://static.wikia.nocookie.net/valheim/images/a/a${index}/B.png/revision/latest?cb=1`,
  }));

  it('fetches the first screen’s pictures with the page, the first ahead of the rest', () => {
    // A lazy biome card was the desktop home's largest paint. All eight
    // biomes are on the first screen from 360×740 to 1440×900.
    const $ = render(createElement(CategoryGrid, { items, axis: 'biome', lang: 'es', ordinals: true, firstScreen: true }));
    const images = $('img').toArray();
    expect(images.map((img) => $(img).attr('loading'))).toEqual([
      ...Array.from({ length: 8 }, () => 'eager'),
      'lazy',
      'lazy',
    ]);
    expect(images.map((img) => $(img).attr('fetchpriority') ?? null)).toEqual([
      'high',
      ...Array.from({ length: 9 }, () => null),
    ]);
  });

  it('leaves every picture lazy in a grid further down', () => {
    const $ = render(createElement(CategoryGrid, { items, axis: 'category', lang: 'es' }));
    expect(new Set($('img').map((_, img) => $(img).attr('loading')).get())).toEqual(new Set(['lazy']));
    expect($('img[fetchpriority]')).toHaveLength(0);
  });
});
