import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractArticle } from '@/lib/wiki/article';
import type { TableBlock } from '@/lib/wiki/article-types';
import { extractSections } from '@/lib/wiki/html';

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
    for (const name of ALL_FIXTURES) {
      const article = await extractArticle(await fixtureHtml(name));
      for (const block of article.blocks) {
        if (block.kind === 'paragraph') expect(block.text.length).toBeGreaterThan(0);
        if (block.kind === 'list') expect(block.items.length).toBeGreaterThan(0);
        if (block.kind === 'table') expect(block.rows.length).toBeGreaterThan(0);
      }
    }
  });

  it('never leaks markup or edit links', async () => {
    for (const name of ALL_FIXTURES) {
      const article = await extractArticle(await fixtureHtml(name));
      const text = JSON.stringify(article);
      expect(text).not.toMatch(/<[a-z]/i);
      expect(text).not.toMatch(/\[edit/i);
    }
  });
});

/** Every saved page; the five after Swords were added for the parser fixes of 2026-10, the last two for tabbers. */
const ALL_FIXTURES = [
  'Iron', 'Iron_Sword', 'Bonemass', 'Deathsquito', 'Swords',
  'Birch', 'Forge', 'Troll', 'Cape_of_Odin', 'Burning',
  'Frosted_Sweetbread', 'Bronze_Armor',
];

function tables(article: Awaited<ReturnType<typeof extractArticle>>) {
  return article.blocks.filter((b): b is TableBlock => b.kind === 'table');
}

describe('extractArticle — line breaks (BWR-02)', () => {
  it('keeps one line per entry in a table cell instead of "2 Wood20 Iron3 Leather scraps"', async () => {
    const article = await extractArticle(await fixtureHtml('Iron_Sword'));
    const crafting = tables(article)
      .flatMap((t) => t.rows)
      .find((row) => row[0] === 'Crafting');
    expect(crafting?.[1]).toBe('2 Wood\n20 Iron\n3 Leather scraps');
  });

  it('keeps a damage split on two lines', async () => {
    const article = await extractArticle(await fixtureHtml('Swords'));
    const silver = tables(article)[0]!.rows.find((row) => row[0] === 'Silver sword');
    expect(silver).toContain('Slash: 75/93\nSpirit: 30/45');
  });

  it('never glues a quantity to the name before it, anywhere', async () => {
    for (const name of ALL_FIXTURES) {
      const article = await extractArticle(await fixtureHtml(name));
      const cells = tables(article).flatMap((t) => t.rows.flat());
      for (const cell of cells) expect(cell).not.toMatch(/[a-z]{2}\d+ [A-Z]?[a-z]/);
    }
  });

  it('makes a nested list further lines of its item, not one run of text', () => {
    const html = `<div class="mw-parser-output"><h2>Usage</h2>
      <ul><li>Building:<ul><li>Black Forest Forge</li><li>Forge cooler</li></ul></li><li>Crafting</li></ul></div>`;
    return extractArticle(html).then((article) => {
      const list = article.blocks.find((b) => b.kind === 'list');
      expect(list?.kind === 'list' && list.items).toEqual(['Building:\nBlack Forest Forge\nForge cooler', 'Crafting']);
    });
  });

  it('keeps a line break inside a paragraph', async () => {
    const article = await extractArticle(
      '<div class="mw-parser-output"><h2>A</h2><p>Line one<br>Line two</p></div>',
    );
    expect(article.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'Line one\nLine two' });
  });
});

describe('extractArticle — table structure (BWR-07)', () => {
  it('merges the stacked header and drops nothing from the Birch drops table', async () => {
    const article = await extractArticle(await fixtureHtml('Birch'));
    const drops = tables(article).find((t) => t.headers.includes('Average per Tree › G1'))!;
    expect(drops.headers).toEqual([
      'Amount', 'Item', 'Chance',
      'Average per Tree › G1', 'Average per Tree › G2', 'Average per Tree › Y1', 'Average per Tree › Y2',
    ]);
    // The colspan=3 "where X equals" row keeps its values under G1–Y2.
    expect(drops.rows.at(-1)).toEqual(['...where X equals:', '', '', '2', '1', '1', '1']);
    expect(drops.groupRows).toEqual([2]);
  });

  it('lists every biome a tree grows in, not only the ones it does not', async () => {
    const article = await extractArticle(await fixtureHtml('Birch'));
    const biomes = tables(article).find((t) => t.caption === 'Allowed Biomes:')!;
    expect(biomes.headers).toEqual([]);
    expect(biomes.rows).toContainEqual(['Meadows', 'Yes']);
    expect(biomes.rows).toContainEqual(['Plains', 'Yes']);
    expect(biomes.rows).toHaveLength(7);
  });

  it('drops the icon column and keeps the Forge total under Materials', async () => {
    const article = await extractArticle(await fixtureHtml('Forge'));
    const upgrades = tables(article).find((t) => t.headers.includes('Materials'))!;
    expect(upgrades.headers).toEqual(['Name', 'Materials']);
    const total = upgrades.rows.find((row) => row[0]?.startsWith('Total'))!;
    expect(total[1]).toMatch(/^60 Wood\n25 Finewood\n/);
    // No card is left without a title.
    expect(upgrades.rows.every((row) => row[0] !== '')).toBe(true);
  });

  it('never invents column labels or leaves rows ragged', async () => {
    for (const name of ALL_FIXTURES) {
      for (const table of tables(await extractArticle(await fixtureHtml(name)))) {
        expect(table.headers.join('|')).not.toMatch(/Column \d/);
        const width = table.headers.length || table.rows[0]!.length;
        for (const row of table.rows) expect(row).toHaveLength(width);
      }
    }
  });

  it('reads tables nested in a layout table as tables of their own', async () => {
    const html = `<div class="mw-parser-output"><h2>Experience</h2>
      <table class="wikitable"><tr><th>Level 1-50</th><th>Level 51-100</th></tr><tr>
        <td><table><tr><th>Level</th><th>XP</th></tr><tr><td>1</td><td>1.0</td></tr></table></td>
        <td><table><tr><th>Level</th><th>XP</th></tr><tr><td>51</td><td>182.6</td></tr></table></td>
      </tr></table></div>`;
    const found = tables(await extractArticle(html));
    expect(found.map((t) => t.caption)).toEqual(['Level 1-50', 'Level 51-100']);
    expect(found[1]!.rows).toEqual([['51', '182.6']]);
  });
});

describe('extractArticle — notice banners (BWR-06)', () => {
  it('drops a maintenance banner and takes the real opening paragraph as the lead', async () => {
    const article = await extractArticle(await fixtureHtml('Birch'));
    expect(article.lead).toMatch(/^Birch is a type of tree/);
    expect(JSON.stringify(article)).not.toMatch(/work in progress/i);
  });

  it('keeps a banner that says something about the game, as a marked paragraph', async () => {
    const article = await extractArticle(await fixtureHtml('Cape_of_Odin'));
    expect(article.lead).toMatch(/^Cape of Odin is a DLC armor piece/);
    const banner = article.blocks.find((b) => b.kind === 'paragraph' && b.notice);
    expect(banner).toEqual({
      kind: 'paragraph',
      section: '',
      text: 'This article is for a DLC item or feature.\nIt may no longer be available or requires an additional code to unlock.',
      notice: 'dlc',
    });
    expect(tables(article).some((t) => t.rows.some((r) => r.join(' ').includes('DLC item')))).toBe(false);
  });

  it('does not take the tab labels of a tabbed infobox for the lead', async () => {
    // Every meat article opens with Raw / Cooked infoboxes in tabs; their
    // labels were all that remained once the infoboxes were lifted out.
    const html = `<div class="mw-parser-output">
      <div class="infobox-tabber"><div class="tabber wds-tabber">
        <div class="wds-tabs__wrapper"><ul class="wds-tabs"><li><div class="wds-tabs__tab-label"><a href="#">Raw</a></div></li>
          <li><div class="wds-tabs__tab-label"><a href="#">Cooked</a></div></li></ul></div>
        <div class="wds-tab__content"><aside class="portable-infobox"><h2 class="pi-title">Bear Meat</h2></aside></div>
      </div></div>
      <p><b>Bear meat</b> is a basic food source.</p></div>`;
    const article = await extractArticle(html);
    expect(article.lead).toBe('Bear meat is a basic food source.');
    expect(article.blocks).toEqual([]);
  });

  it('does not take the tab labels of a tabbed infobox for the lead, whatever wraps it', async () => {
    // Frosted Sweetbread floats its Baked / Unbaked infoboxes in a plain
    // div, not in the wiki's `.infobox-tabber`: its lead was "Baked\n\nUnbaked".
    const html = `<div class="mw-parser-output"><div style="float: right; margin: 0 1em;">
      <div class="tabber wds-tabber">
        <div class="wds-tabs__wrapper"><ul class="wds-tabs">
          <li data-hash="Baked"><div class="wds-tabs__tab-label"><a href="#">Baked</a></div></li>
          <li data-hash="Unbaked"><div class="wds-tabs__tab-label"><a href="#">Unbaked</a></div></li></ul></div>
        <div class="wds-tab__content"><p class="mw-empty-elt"></p><aside class="portable-infobox"><h2 class="pi-title">Frosted Sweetbread</h2></aside></div>
        <div class="wds-tab__content"><aside class="portable-infobox"><h2 class="pi-title">Unbaked sweetbread</h2></aside></div>
      </div></div>
      <p><b>Frosted sweetbread</b> is a Plains-tier food.</p></div>`;
    const article = await extractArticle(html);
    expect(article.lead).toBe('Frosted sweetbread is a Plains-tier food.');
    expect(article.blocks).toEqual([]);
  });

  it('does not take the labels of a tabber of text for the lead, and takes the first real paragraph', async () => {
    const html = `<div class="mw-parser-output">
      <div class="tabber wds-tabber">
        <div class="wds-tabs__wrapper"><ul class="wds-tabs">
          <li><div class="wds-tabs__tab-label"><a href="#">Raw</a></div></li>
          <li><div class="wds-tabs__tab-label"><a href="#">Cooked</a></div></li></ul></div>
        <div class="wds-tab__content"><p>Eaten raw, it restores little.</p></div>
        <div class="wds-tab__content"><p>Cooked, it restores more.</p></div>
      </div>
      <p><b>Fish</b> is caught with a rod.</p></div>`;
    const article = await extractArticle(html);
    expect(article.lead).toBe('Fish is caught with a rod.');
    // Each tab's text under its label, as a heading of its own.
    expect(article.blocks).toEqual([
      { kind: 'paragraph', section: 'Raw', text: 'Eaten raw, it restores little.' },
      { kind: 'paragraph', section: 'Cooked', text: 'Cooked, it restores more.' },
    ]);
  });
});

describe('extractArticle — a tabber in the body', () => {
  // An armor set's "Armor pieces": one tab per quality level, each opening
  // with its own heading. The tabber used to be one paragraph — "1\n\n2\n\n3
  // \n\n4\n\nQuality 1\n\nForge level: 1…" with its tables read as lines.
  const html = `<div class="mw-parser-output"><p><b>Bronze Armor</b> is a Black Forest-tier armor.</p>
    <h2><span class="mw-headline">Armor pieces</span></h2>
    <p>This set has three pieces.</p>
    <div class="tabber wds-tabber">
      <div class="wds-tabs__wrapper"><ul class="wds-tabs">
        <li><div class="wds-tabs__tab-label"><a href="#">1</a></div></li>
        <li><div class="wds-tabs__tab-label"><a href="#">2</a></div></li></ul></div>
      <div class="wds-tab__content"><p class="mw-empty-elt"></p>
        <h3><span class="mw-headline">Quality 1</span></h3>
        <p>Forge level: 1<br>Durability per piece: 1000</p>
        <table class="wikitable"><tr><th>Armor piece</th><th>Armor</th></tr><tr><td>Bronze helmet</td><td>8</td></tr></table></div>
      <div class="wds-tab__content">
        <h3><span class="mw-headline">Quality 2</span></h3>
        <p>Forge level: 2</p>
        <table class="wikitable"><tr><th>Armor piece</th><th>Armor</th></tr><tr><td>Bronze helmet</td><td>10</td></tr></table></div>
    </div>
    <p>All three pieces together weigh 23.</p>
    <h2><span class="mw-headline">Set bonus</span></h2><p>None.</p></div>`;

  it('reads it tab by tab, its headings, paragraphs and tables as they are', async () => {
    const article = await extractArticle(html);
    expect(article.lead).toBe('Bronze Armor is a Black Forest-tier armor.');
    expect(article.blocks.map((b) => [b.kind, b.section])).toEqual([
      ['paragraph', 'Armor pieces'],
      ['paragraph', 'Armor pieces > Quality 1'],
      ['table', 'Armor pieces > Quality 1'],
      ['paragraph', 'Armor pieces > Quality 2'],
      ['table', 'Armor pieces > Quality 2'],
      // After the tabber the text is the section's again, not the last tab's.
      ['paragraph', 'Armor pieces'],
      ['paragraph', 'Set bonus'],
    ]);
    expect(article.blocks[1]).toMatchObject({ text: 'Forge level: 1\nDurability per piece: 1000' });
    expect(tables(article)[1]!.rows).toEqual([['Bronze helmet', '10']]);
  });

  it('never reads its labels as text, nor those of one inside a wrapper', async () => {
    const wrapped = `<div class="mw-parser-output"><h2>Notes</h2><div class="box"><div class="tabber wds-tabber">
      <div class="wds-tabs__wrapper"><ul class="wds-tabs"><li><div class="wds-tabs__tab-label"><a href="#">Before</a></div></li>
        <li><div class="wds-tabs__tab-label"><a href="#">After</a></div></li></ul></div>
      <div class="wds-tab__content">Old value.</div><div class="wds-tab__content">New value.</div></div></div></div>`;
    for (const page of [html, wrapped]) {
      const text = JSON.stringify(await extractArticle(page));
      expect(text).not.toMatch(/"1\\n|\\n2\\n|Before|After/);
    }
    const article = await extractArticle(wrapped);
    expect(article.blocks).toEqual([{ kind: 'paragraph', section: 'Notes', text: 'Old value.\n\nNew value.' }]);
  });

  it('reads a tabber laid out some other way as text rather than losing it, still without its labels', async () => {
    // The panels are not where a tabber keeps them, so there are no tabs to walk.
    const odd = `<div class="mw-parser-output"><h2>Notes</h2><div class="tabber wds-tabber">
      <div class="wds-tabs__wrapper"><ul class="wds-tabs"><li><div class="wds-tabs__tab-label"><a href="#">Before</a></div></li></ul></div>
      <div class="layout"><div class="wds-tab__content">Old value.</div></div></div></div>`;
    for (const read of [extractArticle(odd), extractSections(odd)]) {
      const text = JSON.stringify(await read);
      expect(text).toContain('Old value.');
      expect(text).not.toContain('Before');
    }
  });

  it('reads the saved pages that have them', async () => {
    const sweetbread = await extractArticle(await fixtureHtml('Frosted_Sweetbread'));
    expect(sweetbread.lead).toMatch(/^Frosted sweetbread is a Plains-tier/);

    const bronze = await extractArticle(await fixtureHtml('Bronze_Armor'));
    expect(bronze.lead).toMatch(/^Bronze Armor is a Black Forest-tier armor/);
    expect(tables(bronze).map((t) => t.section)).toEqual(
      ['1', '2', '3', '4'].map((level) => `Armor pieces > Quality ${level}`),
    );
    expect(JSON.stringify(bronze.blocks)).not.toMatch(/"1\\n/);
  });
});

describe('extractSections — tabbers, as the reading document reads them', () => {
  it('neither indexes tab labels nor loses which tab a table belongs to', async () => {
    const html = `<div class="mw-parser-output"><div style="float: right;"><div class="tabber wds-tabber">
        <div class="wds-tabs__wrapper"><ul class="wds-tabs"><li><div class="wds-tabs__tab-label"><a href="#">Baked</a></div></li>
          <li><div class="wds-tabs__tab-label"><a href="#">Unbaked</a></div></li></ul></div>
        <div class="wds-tab__content"><aside class="portable-infobox"><h2 class="pi-title">Bread</h2></aside></div>
        <div class="wds-tab__content"><aside class="portable-infobox"><h2 class="pi-title">Dough</h2></aside></div></div></div>
      <p><b>Bread</b> is a Plains-tier food baked in a Stone oven.</p>
      <h2><span class="mw-headline">Armor pieces</span></h2>
      <div class="tabber wds-tabber"><div class="wds-tabs__wrapper"><ul class="wds-tabs">
          <li><div class="wds-tabs__tab-label"><a href="#">1</a></div></li></ul></div>
        <div class="wds-tab__content"><h3><span class="mw-headline">Quality 1</span></h3><p>Forge level: 1</p>
          <table class="wikitable"><tr><th>Armor piece</th><th>Armor</th></tr><tr><td>Bronze helmet</td><td>8</td></tr></table></div></div>
      <p>Weighs 23 in all.</p></div>`;
    const sections = await extractSections(html);
    expect(sections.map((s) => [s.path, s.text, s.tables.length])).toEqual([
      ['', 'Bread is a Plains-tier food baked in a Stone oven.', 0],
      ['Armor pieces > Quality 1', 'Forge level: 1', 1],
      ['Armor pieces', 'Weighs 23 in all.', 0],
    ]);
  });
});

describe('extractArticle — the level tabs of an infobox', () => {
  it('keeps them when a tabber with only the picture comes first', async () => {
    // Every armor piece: an "Icon" tabber, then the quality levels. The
    // levels went to the first tabber, which has no data, and were lost.
    const html = `<div class="mw-parser-output"><aside class="portable-infobox">
      <h2 class="pi-title">Ashen cape</h2>
      <section class="pi-item pi-panel wds-tabber"><div class="wds-tabs__wrapper"><ul class="wds-tabs">
        <li><div class="wds-tabs__tab-label">Icon</div></li></ul></div>
        <div class="wds-tab__content"><figure class="pi-image"><img src="https://static.example/Ashen_cape.png"></figure></div></section>
      <div class="pi-item pi-data"><h3 class="pi-data-label">Type</h3><div class="pi-data-value">Cape</div></div>
      <section class="pi-item pi-panel wds-tabber"><div class="wds-tabs__wrapper"><ul class="wds-tabs">
        <li><div class="wds-tabs__tab-label">1</div></li><li><div class="wds-tabs__tab-label">2</div></li></ul></div>
        <div class="wds-tab__content"><div class="pi-item pi-data"><h3 class="pi-data-label">Durability</h3><div class="pi-data-value">1200</div></div></div>
        <div class="wds-tab__content"><div class="pi-item pi-data"><h3 class="pi-data-label">Durability</h3><div class="pi-data-value">1400</div></div></div></section>
    </aside><p>The Ashen cape is a cape.</p></div>`;
    const box = (await extractArticle(html)).infobox!;
    expect(box.common.flatMap((g) => g.rows)).toEqual([{ label: 'Type', value: 'Cape' }]);
    expect(box.tabs).toEqual([
      { label: '1', groups: [{ label: '', rows: [{ label: 'Durability', value: '1200' }] }] },
      { label: '2', groups: [{ label: '', rows: [{ label: 'Durability', value: '1400' }] }] },
    ]);
    // One infobox on the page: nothing to say about others.
    expect(box.variants).toBeUndefined();
  });
});

describe('extractArticle — a page with one infobox per tab', () => {
  it("names the tabs, so a reader can tell the set's piece from the page's own", async () => {
    // An armor set: the infobox read is the helmet's, one of three.
    const bronze = (await extractArticle(await fixtureHtml('Bronze_Armor'))).infobox!;
    expect(bronze.title).toBe('Bronze helmet');
    expect(bronze.variants).toEqual(['Head', 'Chest', 'Legs']);

    // A bread: the infobox read is the baked bread, the page's own.
    const sweetbread = (await extractArticle(await fixtureHtml('Frosted_Sweetbread'))).infobox!;
    expect(sweetbread.title).toBe('Frosted Sweetbread');
    expect(sweetbread.variants).toEqual(['Baked', 'Unbaked']);

    for (const name of ['Iron_Sword', 'Troll', 'Cape_of_Odin']) {
      expect((await extractArticle(await fixtureHtml(name))).infobox!.variants).toBeUndefined();
    }
  });

  it('counts only the tabs that hold an infobox', async () => {
    const html = `<div class="mw-parser-output"><div class="tabber wds-tabber">
      <div class="wds-tabs__wrapper"><ul class="wds-tabs"><li><div class="wds-tabs__tab-label"><a href="#">Raw</a></div></li>
        <li><div class="wds-tabs__tab-label"><a href="#">Notes</a></div></li></ul></div>
      <div class="wds-tab__content"><aside class="portable-infobox"><h2 class="pi-title">Neck tail</h2>
        <div class="pi-item pi-data"><h3 class="pi-data-label">Weight</h3><div class="pi-data-value">0.5</div></div></aside></div>
      <div class="wds-tab__content"><p>Cook it first.</p></div></div><p>Neck tail is a food.</p></div>`;
    expect((await extractArticle(html)).infobox!.variants).toBeUndefined();
  });
});

describe('extractArticle — notice banners (BWR-06), continued', () => {
  it('does not take a figure caption for the lead', async () => {
    const html = `<div class="mw-parser-output">
      <figure><a><img src="https://static.example/Crafting.png" width="300" height="200"></a><figcaption>A group of players</figcaption></figure>
      <p>Crafting is the process of combining materials.</p></div>`;
    const article = await extractArticle(html);
    expect(article.lead).toBe('Crafting is the process of combining materials.');
    expect(article.blocks).toEqual([]);
    expect(article.images).toEqual([{ url: 'https://static.example/Crafting.png', alt: '', caption: 'A group of players' }]);
  });
});

describe('extractArticle — gallery (BWR-10)', () => {
  it('keeps item icons out of the gallery', async () => {
    for (const name of ALL_FIXTURES) {
      const article = await extractArticle(await fixtureHtml(name));
      for (const image of article.images) {
        const scaled = /scale-to-width-down\/(\d+)/.exec(image.url)?.[1];
        if (scaled) expect(Number(scaled)).toBeGreaterThan(64);
      }
    }
  });

  it('keeps the pictures the editors put in a gallery', async () => {
    const article = await extractArticle(await fixtureHtml('Forge'));
    expect(article.images.length).toBeGreaterThanOrEqual(2);
    expect(article.images[0]).toMatchObject({ caption: 'Beta version' });
  });

  it('drops an icon that sits inline in prose', async () => {
    const html = `<div class="mw-parser-output"><h2>Sale</h2><p>Sold for 5
      <span><a href="/wiki/Coins"><img alt="Coins" src="https://static.example/Coins.png/revision/latest/scale-to-width-down/30" width="30" height="30"></a></span> Coins.</p></div>`;
    expect((await extractArticle(html)).images).toEqual([]);
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

  it('takes the first entry of a value that lists several, one per line', async () => {
    const html = `
      <div class="mw-parser-output">
        <aside class="portable-infobox">
          <h2 class="pi-title">Seeker</h2>
          <div class="pi-item pi-data"><h3 class="pi-data-label">Biome</h3>
            <div class="pi-data-value"><ul><li>Mistlands</li><li>Ashlands</li></ul></div></div>
        </aside>
      </div>`;
    const article = await extractArticle(html);
    expect(article.infobox!.common[0]!.rows[0]).toEqual({ label: 'Biome', value: 'Mistlands\nAshlands' });
    expect(article.facets.biome).toBe('Mistlands');
  });

  it('skips the heading a value puts over its entries', async () => {
    // Muddy Scrap Pile: once values kept their lines, the facet became the
    // heading, "Inside Sunken Crypts:".
    const html = `
      <div class="mw-parser-output">
        <aside class="portable-infobox">
          <h2 class="pi-title">Muddy scrap pile</h2>
          <div class="pi-item pi-data"><h3 class="pi-data-label">Internal ID</h3>
            <div class="pi-data-value">Inside Sunken Crypts:<ul><li>mudpile2 <small>(whole)</small></li><li>mudpile2_frac</li></ul></div></div>
          <div class="pi-item pi-data"><h3 class="pi-data-label">Biome</h3>
            <div class="pi-data-value">Spawns in:<br>Swamp</div></div>
        </aside>
      </div>`;
    const article = await extractArticle(html);
    expect(article.facets.internalId).toBe('mudpile2 (whole)');
    expect(article.facets.biome).toBe('Swamp');
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

  /**
   * An item infobox as the wiki lays them out: the picture's tabber, the
   * shared rows, then one tab per quality level. Rows are [label, value].
   */
  const itemInfobox = (title: string, shared: [string, string][], level: [string, string][]) => {
    const rows = (pairs: [string, string][]) =>
      pairs
        .map(([label, value]) => `<div class="pi-item pi-data"><h3 class="pi-data-label">${label}</h3><div class="pi-data-value">${value}</div></div>`)
        .join('');
    return `<div class="mw-parser-output"><aside class="portable-infobox"><h2 class="pi-title">${title}</h2>
      <section class="pi-item pi-panel wds-tabber"><div class="wds-tabs__wrapper"><ul class="wds-tabs">
        <li><div class="wds-tabs__tab-label">Icon</div></li></ul></div>
        <div class="wds-tab__content"><figure class="pi-image"><img src="https://static.example/${title}.png"></figure></div></section>
      ${rows(shared)}
      <section class="pi-item pi-panel wds-tabber"><div class="wds-tabs__wrapper"><ul class="wds-tabs">
        <li><div class="wds-tabs__tab-label">1</div></li></ul></div>
        <div class="wds-tab__content">${rows(level)}</div></section>
    </aside><p>${title} is an item.</p></div>`;
  };

  it('does not take a trader who sells the item for its station, however its rows read', async () => {
    // Hildir's clothes: repairable at the workbench, sold by Hildir, crafted nowhere.
    const dress = await extractArticle(
      itemInfobox('Beaded dress blue', [['Type', 'Body'], ['Source', 'Hildir']], [
        ['Weight', '1.0'], ['Durability', '200'], ['Repair Level', '1'], ['Repair Station', 'Workbench'], ['Armor', '1'],
      ]),
    );
    expect(dress.infobox!.tabs.map((t) => t.label)).toEqual(['1']);
    expect(dress.facets).toEqual({ type: 'Body' });

    // Haldor's: a recipe row that says there is none.
    for (const none of ['N/A', 'n/a']) {
      const circlet = await extractArticle(
        itemInfobox('Dverger Circlet', [['Type', 'Head'], ['Source', 'Haldor']], [['Crafting Materials', none], ['Weight', '1.0']]),
      );
      expect(circlet.facets.station).toBeUndefined();
    }

    // A crafting level that is no number: the Sparkler, the console-only shields.
    const sparkler = await extractArticle(
      itemInfobox('Sparkler', [['Source', 'Hildir']], [['Crafting Level', 'nil'], ['Repair Level', 'nil']]),
    );
    expect(sparkler.facets.station).toBeUndefined();
  });

  it('still reads the bench of an item whose level states its recipe', async () => {
    const fishingHat = await extractArticle(
      itemInfobox('Fishing hat', [['Type', 'Head'], ['Source', 'Workbench']], [
        ['Crafting Level', '1'], ['Repair Level', '1'], ['Crafting Materials', 'Perch x1<br>Pike x1'],
      ]),
    );
    expect(fishingHat.facets).toEqual({ type: 'Head', station: 'Workbench' });

    // A crafting level alone is enough, and so are materials alone.
    const cap = await extractArticle(itemInfobox('Celebratory cap', [['Source', 'Workbench']], [['Crafting Level', '2']]));
    expect(cap.facets.station).toBe('Workbench');
    const torch = await extractArticle(itemInfobox('Torch', [['Source', 'Workbench']], [['Crafting Materials', 'Wood x1']]));
    expect(torch.facets.station).toBe('Workbench');
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
