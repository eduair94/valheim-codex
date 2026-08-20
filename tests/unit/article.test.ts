import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractArticle } from '@/lib/wiki/article';

async function fixtureHtml(name: string): Promise<string> {
  const raw = await readFile(`tests/fixtures/${name}.json`, 'utf8');
  return (JSON.parse(raw) as { parse: { text: string } }).parse.text;
}

describe('extractArticle — blocks', () => {
  it('puts the lead summary first and keeps it out of the blocks', async () => {
    const article = await extractArticle(await fixtureHtml('Iron'));
    expect(article.lead).toMatch(/crafting material smelted from/i);
    // The lead is rendered on its own, so repeating it as a block would show
    // the same sentence twice.
    expect(article.blocks.some((b) => b.kind === 'paragraph' && b.text === article.lead)).toBe(false);
  });

  it('preserves document order across paragraphs, lists and tables', async () => {
    const article = await extractArticle(await fixtureHtml('Swords'));
    const sections = article.blocks.map((b) => b.section);
    // Sections must appear in the order the article presents them, never
    // grouped by block kind.
    const firstList = sections.indexOf('List of swords');
    const firstProps = sections.indexOf('Properties');
    expect(firstList).toBeGreaterThanOrEqual(0);
    expect(firstProps).toBeGreaterThan(firstList);
  });

  it('keeps lists as items rather than flattening them into prose', async () => {
    const article = await extractArticle(await fixtureHtml('Iron'));
    const lists = article.blocks.filter((b) => b.kind === 'list');
    expect(lists.length).toBeGreaterThan(0);
    if (lists[0]?.kind !== 'list') throw new Error('unreachable');
    expect(lists[0].items.length).toBeGreaterThan(1);
    expect(lists[0].items.every((i) => i.length > 0)).toBe(true);
  });

  it('keeps table headers separate from rows', async () => {
    const article = await extractArticle(await fixtureHtml('Swords'));
    const tables = article.blocks.filter((b) => b.kind === 'table');
    expect(tables.length).toBeGreaterThan(0);
    if (tables[0]?.kind !== 'table') throw new Error('unreachable');

    expect(tables[0].headers).toContain('Name');
    expect(tables[0].headers).toContain('Damage');
    expect(tables[0].rows.length).toBeGreaterThan(1);
    // Every row must line up with the header, or a sticky-column table shifts.
    for (const row of tables[0].rows) {
      expect(row).toHaveLength(tables[0].headers.length);
    }
  });

  it('never emits an empty block', async () => {
    for (const name of ['Iron', 'Iron_Sword', 'Bonemass', 'Deathsquito', 'Swords']) {
      const article = await extractArticle(await fixtureHtml(name));
      for (const block of article.blocks) {
        if (block.kind === 'paragraph') expect(block.text.length).toBeGreaterThan(0);
        if (block.kind === 'list') expect(block.items.length).toBeGreaterThan(0);
        if (block.kind === 'table') expect(block.rows.length).toBeGreaterThan(0);
      }
    }
  });

  it('never leaks markup or edit links', async () => {
    for (const name of ['Iron', 'Iron_Sword', 'Bonemass']) {
      const article = await extractArticle(await fixtureHtml(name));
      const text = JSON.stringify(article);
      expect(text).not.toMatch(/<[a-z]/i);
      expect(text).not.toMatch(/\[edit/i);
    }
  });
});

describe('extractArticle — infobox', () => {
  it('splits shared rows from per-level tabs', async () => {
    const article = await extractArticle(await fixtureHtml('Iron_Sword'));
    const box = article.infobox!;
    expect(box.title).toBe('Iron sword');
    expect(box.tabs.map((t) => t.label)).toEqual(['1', '2', '3', '4']);

    // "Type: Sword" holds for every level, so it belongs to common, not to a tab.
    const commonRows = box.common.flatMap((g) => g.rows);
    expect(commonRows).toContainEqual({ label: 'Type', value: 'Sword' });
  });

  it('keeps each stat paired with its label inside a tab', async () => {
    const article = await extractArticle(await fixtureHtml('Iron_Sword'));
    const level1 = article.infobox!.tabs.find((t) => t.label === '1')!;
    const rows = level1.groups.flatMap((g) => g.rows);

    expect(rows).toContainEqual({ label: 'Weight', value: '0.8' });
    expect(rows).toContainEqual({ label: 'Durability', value: '200' });
    expect(rows.find((r) => r.label === 'Crafting Materials')?.value).toMatch(/Iron x20/);
  });

  it('labels the groups so stats can be shown under headings', async () => {
    const article = await extractArticle(await fixtureHtml('Iron_Sword'));
    const level1 = article.infobox!.tabs.find((t) => t.label === '1')!;
    expect(level1.groups.map((g) => g.label)).toContain('Properties');
  });

  it('extracts the infobox image, which is how an item is recognised', async () => {
    const article = await extractArticle(await fixtureHtml('Iron_Sword'));
    expect(article.infobox!.image?.url).toMatch(/^https:\/\/static\.wikia\.nocookie\.net\/.+/);
    expect(article.infobox!.image?.alt).toBeTruthy();
  });

  it('returns null for a page with no infobox', async () => {
    const article = await extractArticle(await fixtureHtml('Swords'));
    expect(article.infobox).toBeNull();
  });

  it('handles a creature infobox tabbed by star level', async () => {
    const article = await extractArticle(await fixtureHtml('Deathsquito'));
    expect(article.infobox!.tabs.map((t) => t.label)).toContain('0★');
  });
});

describe('extractArticle — facets', () => {
  it('lifts the crafting station out of the infobox', async () => {
    const article = await extractArticle(await fixtureHtml('Iron_Sword'));
    expect(article.facets.station).toBe('Forge');
    expect(article.facets.type).toBe('Sword');
    expect(article.facets.internalId).toBe('SwordIron');
  });

  it('lifts the biome for a creature', async () => {
    const article = await extractArticle(await fixtureHtml('Deathsquito'));
    expect(article.facets.biome).toBe('Plains');
  });

  it('omits facets a page does not state rather than inventing them', async () => {
    const article = await extractArticle(await fixtureHtml('Swords'));
    expect(article.facets.biome).toBeUndefined();
    expect(article.facets.station).toBeUndefined();
  });
});

describe('extractArticle — images', () => {
  it('collects article images with absolute urls', async () => {
    const article = await extractArticle(await fixtureHtml('Iron_Sword'));
    expect(article.images.length).toBeGreaterThan(0);
    for (const image of article.images) {
      expect(image.url).toMatch(/^https:\/\//);
    }
  });

  it('does not repeat the infobox image in the gallery', async () => {
    const article = await extractArticle(await fixtureHtml('Iron_Sword'));
    const main = article.infobox?.image?.url;
    if (main) expect(article.images.map((i) => i.url)).not.toContain(main);
  });
});

describe('extractArticle — station facet', () => {
  it('reads the crafting station from Source when the item is craftable', async () => {
    // "Source: Forge" on an item with crafting materials means the station.
    const article = await extractArticle(await fixtureHtml('Iron_Sword'));
    expect(article.facets.station).toBe('Forge');
  });

  it('does not read a station from Source on something that is not crafted', async () => {
    // On a creature, "Source" names an origin. Treating it as a station filled
    // "browse by crafting station" with biomes and village names.
    const html = `
      <div class="mw-parser-output">
        <aside class="portable-infobox">
          <h2 class="pi-title">Fuling</h2>
          <div class="pi-item pi-data"><h3 class="pi-data-label">Source</h3>
            <div class="pi-data-value">Fuling Village in the Plains biome</div></div>
          <div class="pi-item pi-data"><h3 class="pi-data-label">Main biome</h3>
            <div class="pi-data-value">Plains</div></div>
        </aside>
      </div>`;
    const article = await extractArticle(html);
    expect(article.facets.station).toBeUndefined();
    expect(article.facets.biome).toBe('Plains');
  });

  it('rejects a value too long to be a facet', async () => {
    const html = `
      <div class="mw-parser-output">
        <aside class="portable-infobox">
          <h2 class="pi-title">Thing</h2>
          <div class="pi-item pi-data"><h3 class="pi-data-label">Crafting Materials</h3>
            <div class="pi-data-value">Wood x2</div></div>
          <div class="pi-item pi-data"><h3 class="pi-data-label">Source</h3>
            <div class="pi-data-value">A very long sentence that describes where this comes from in detail</div></div>
        </aside>
      </div>`;
    const article = await extractArticle(html);
    expect(article.facets.station).toBeUndefined();
  });
});
