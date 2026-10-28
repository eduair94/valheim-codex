import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load, type CheerioAPI } from 'cheerio';
import type { Lang } from '@/lib/i18n/strings';
import type { GuideLinks } from '@/components/wiki/guide/guide-links';
import { slugify } from '@/lib/wiki/slug';

/*
 * The request slot is server-only (it reads the database); the page fills it
 * before rendering, and so does `render` below.
 */
const request = vi.hoisted(() => ({ lang: 'es' as Lang, links: new Map() as GuideLinks }));
vi.mock('@/components/wiki/guide/guide-request', () => ({
  guideRequest: () => request,
  prepareGuide: async () => undefined,
}));

const { GuideContent, guideToc } = await import('@/components/wiki/guide/guide-content');
const { buildGuideLinks, FANDOM_SEARCH } = await import('@/components/wiki/guide/guide-links');
const { EXTERNAL_HINT_ID } = await import('@/components/wiki/guide/guide-ui');

function render(lang: Lang, links: GuideLinks = new Map()): CheerioAPI {
  request.lang = lang;
  request.links = links;
  return load(renderToStaticMarkup(createElement(GuideContent, { lang })));
}

const SAMPLE_CHIP = 'span.g-item';

/**
 * The guide exists twice, once per language, over one shared structure. These
 * checks are what keeps "shared" true: a translation that drops a checklist
 * item, renames an anchor or forgets an item chip fails here rather than on a
 * reader's screen.
 */
describe('the guide in both languages', () => {
  let es: CheerioAPI;
  let en: CheerioAPI;

  beforeAll(() => {
    es = render('es');
    en = render('en');
  });

  const ids = ($: CheerioAPI, selector: string) => $(selector).map((_, el) => $(el).attr('id')).get();

  it('has the same checklist, item for item, in the same order', () => {
    const boxes = ids(es, 'input[type="checkbox"]');
    expect(boxes.length).toBeGreaterThan(50);
    expect(ids(en, 'input[type="checkbox"]')).toEqual(boxes);
  });

  it('never repeats an id', () => {
    for (const $ of [es, en]) {
      const all = ids($, '[id]');
      expect(new Set(all).size, all.join(' ')).toBe(all.length);
    }
  });

  it('links every table-of-contents entry to an anchor that exists, under the same id in both languages', () => {
    const flat = (lang: Lang) =>
      guideToc(lang).flatMap((entry) => [entry.id, ...(entry.children ?? []).map((child) => child.id)]);
    expect(flat('en')).toEqual(flat('es'));
    for (const [lang, $] of [['es', es], ['en', en]] as const) {
      for (const id of flat(lang)) expect($(`#${id}`).length, `${lang} #${id}`).toBe(1);
    }
  });

  it('mentions the same items in both languages', () => {
    const chips = ($: CheerioAPI) =>
      $('.g-item')
        .not(SAMPLE_CHIP)
        .map((_, el) => $(el).text())
        .get()
        .sort();
    const esChips = chips(es);
    expect(esChips.length).toBeGreaterThan(250);
    expect(chips(en)).toEqual(esChips);
  });

  it('marks the page language, and the English names inside Spanish text', () => {
    expect(es('#guide').attr('lang')).toBe('es');
    expect(en('#guide').attr('lang')).toBe('en');
    expect(es('a.g-item').first().attr('lang')).toBe('en');
    expect(en('a.g-item[lang]').length).toBe(0);
  });

  it('keeps uppercase tracked labels to label length', () => {
    for (const $ of [es, en]) {
      $('.label').each((_, el) => {
        const text = $(el).text().trim();
        expect(text.length, text).toBeLessThanOrEqual(30);
      });
    }
  });

  it('labels every value of every table, so a phone card never shows a bare value', () => {
    for (const $ of [es, en]) {
      $('table').each((_, table) => {
        const headers = $(table).find('thead th').map((_, th) => $(th).text()).get();
        $(table)
          .find('tbody tr')
          .each((_, tr) => {
            $(tr)
              .find('td')
              .each((j, td) => {
                expect($(td).attr('data-label')).toBe(headers[j + 1]);
              });
          });
      });
      // The tables wrap rather than scroll, so they need no tab stop of their own.
      expect($('.stack-scroller[tabindex]').length).toBe(0);
    }
  });
});

describe('item chips', () => {
  const links = buildGuideLinks([
    { match: 'Wood', slug: 'wood', title: 'Wood' },
    { match: 'Burial Chambers', slug: 'burial-chambers', title: 'Burial Chambers' },
  ]);

  it('link to the Codex article when there is one, and to the original wiki otherwise', () => {
    const $ = render('en', links);
    const wood = $('a.g-item').filter((_, el) => $(el).text() === 'Wood');
    expect(wood.attr('href')).toBe('/wiki/a/wood');
    expect(wood.attr('target')).toBeUndefined();

    const chamber = $('a.g-item').filter((_, el) => $(el).text() === 'Burial Chamber');
    expect(chamber.first().attr('href')).toBe('/wiki/a/burial-chambers');

    const vegvisir = $('a.g-item').filter((_, el) => $(el).text() === 'Vegvisir').first();
    expect(vegvisir.attr('href')).toBe(`${FANDOM_SEARCH}Vegvisir`);
    expect(vegvisir.attr('target')).toBe('_blank');
    expect(vegvisir.attr('rel')).toBe('noopener noreferrer');
    expect(vegvisir.attr('aria-describedby')).toBe(EXTERNAL_HINT_ID);
    expect($(`#${EXTERNAL_HINT_ID}`).text().length).toBeGreaterThan(0);
  });

  it('stay one short element each: no code wrapper, no per-chip title', () => {
    const $ = render('es', links);
    expect($('code').length).toBe(0);
    expect($('.g-item[title]').length).toBe(0);
    $('a.g-item').each((_, el) => {
      expect($(el).children().length).toBe(0);
    });
  });

  /*
   * A chip never breaks inside (guide.css), so two chips with nothing
   * breakable between them make one run the width of both: three names joined
   * by bare slashes once pushed the whole page sideways on a phone.
   */
  it('leave the line a place to break between any two names in a row, in both languages', () => {
    for (const lang of ['es', 'en'] as const) {
      const $ = render(lang);
      let pairs = 0;
      let slashes = 0;
      $('.g-item').each((_, el) => {
        const between = el.next;
        if (!between) return;
        const after = between.type === 'text' ? between.next : between;
        if (!after || after.type !== 'tag' || !$(after).hasClass('g-item')) return;
        pairs += 1;
        const text = between.type === 'text' ? between.data : '';
        const where = `${lang}: ${$(el).text()} ⟨${text}⟩ ${$(after).text()}`;
        // A real space: a no-break space is exactly what does not count.
        expect(text, where).toMatch(/[ \n]/);
        if (text.trim() === '/') {
          slashes += 1;
          // The slash stays with the name before it, the break comes after it.
          expect(text, where).toMatch(/^ \/[ \n]$/);
        }
      });
      expect(pairs).toBeGreaterThan(100);
      expect(slashes).toBeGreaterThanOrEqual(8);
    }
  });

  it('are names short enough to sit whole on the narrowest phone line', () => {
    // About 33 monospace characters fit beside a checkbox at 320px.
    const $ = render('en');
    const names = $('.g-item').map((_, el) => $(el).text()).get();
    const longest = names.reduce((a, b) => (b.length > a.length ? b : a), '');
    expect(longest.length, longest).toBeLessThanOrEqual(24);
  });

  it('open the Codex for every name it has an article for (real titles), and the original wiki for the rest', async () => {
    const titles = JSON.parse(await readFile('tests/fixtures/guide/corpus-titles.json', 'utf8')) as string[];
    const real = buildGuideLinks(titles.map((title) => ({ match: title, slug: slugify(title), title })));
    for (const lang of ['es', 'en'] as const) {
      const $ = render(lang, real);
      const outward = $('a.g-item[target="_blank"]').map((_, el) => $(el).text()).get();
      // Each was checked: the Codex has no page for it (Elakingar and Gammeltroll are not in the game yet).
      expect([...new Set(outward)].sort(), lang).toEqual([
        'Elakingar',
        'Fuling Archer',
        'Gammeltroll',
        'Raw Meat',
        'Vegvisir',
      ]);
      expect($('a.g-item:not([target])').length, lang).toBeGreaterThan(280);
    }
  });
});
