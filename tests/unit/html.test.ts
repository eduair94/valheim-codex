import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractSections, flattenTable } from '@/lib/wiki/html';
import * as cheerio from 'cheerio';

async function fixtureHtml(name: string): Promise<string> {
  const raw = await readFile(`tests/fixtures/${name}.json`, 'utf8');
  return (JSON.parse(raw) as { parse: { text: string } }).parse.text;
}

describe('extractSections', () => {
  it('emits a lead section plus one per heading, in document order', async () => {
    const sections = await extractSections(await fixtureHtml('Iron'));
    const paths = sections.map((s) => s.path);
    expect(paths[0]).toBe('');
    expect(paths).toContain('Usage');
    expect(paths).toContain('Notes');
    expect(paths).toContain('Trivia');
  });

  it('nests subheadings under their parent as a breadcrumb', async () => {
    const sections = await extractSections(await fixtureHtml('Bonemass'));
    const paths = sections.map((s) => s.path);
    expect(paths).toContain('Attacks and abilities > Punch');
    expect(paths).toContain('Aftermath > Drops');
    // A level-3 heading must not be reported as a top-level section.
    expect(paths).not.toContain('Punch');
  });

  it('keeps the lead prose and drops the infobox from it', async () => {
    const sections = await extractSections(await fixtureHtml('Iron'));
    const lead = sections.find((s) => s.path === '')!;
    expect(lead.text).toMatch(/crafting material smelted from/i);
    // "SwordIron"-style infobox internals must not leak into prose.
    expect(lead.text).not.toMatch(/Internal ID/);
  });

  it('excludes navboxes, galleries, edit links and reference markers', async () => {
    for (const name of ['Swords', 'Bonemass', 'Deathsquito', 'Iron']) {
      const sections = await extractSections(await fixtureHtml(name));
      const all = sections.map((s) => `${s.text}\n${s.tables.join('\n')}`).join('\n');
      expect(all).not.toMatch(/\[edit(\s*\|\s*edit source)?\]/i);
      expect(all).not.toMatch(/<[a-z]/i);
      expect(all).not.toMatch(/\bnavbox\b/i);
    }
  });

  it('never returns a section whose text and tables are both empty', async () => {
    for (const name of ['Swords', 'Bonemass', 'Deathsquito', 'Iron', 'Iron_Sword']) {
      const sections = await extractSections(await fixtureHtml(name));
      for (const s of sections) {
        expect(s.text.length + s.tables.join('').length).toBeGreaterThan(0);
      }
    }
  });
});

describe('flattenTable', () => {
  it('binds each cell to its column header', async () => {
    const html = await fixtureHtml('Swords');
    const $ = cheerio.load(html);
    const table = $('table.fandom-table').first();
    const text = flattenTable($, table);

    expect(text).toMatch(/Name: Bronze sword/);
    expect(text).toMatch(/Damage: Slash: 35\/53/);
    expect(text).toMatch(/Stamina \(primary\): 8/);
    // Headers must not be emitted as a bare run of words.
    expect(text).not.toMatch(/Name Icon Damage/);
  });

  it('carries a colspan sub-header down onto the rows it groups', async () => {
    const html = await fixtureHtml('Swords');
    const $ = cheerio.load(html);
    const text = flattenTable($, $('table.fandom-table').first());
    const bronze = text.split('\n').find((l) => l.includes('Bronze sword'))!;
    expect(bronze).toMatch(/One-handed/);
  });

  it('drops image-only cells rather than emitting empty labels', async () => {
    const html = await fixtureHtml('Swords');
    const $ = cheerio.load(html);
    const text = flattenTable($, $('table.fandom-table').first());
    expect(text).not.toMatch(/Icon:\s*(;|$)/m);
  });

  it('returns an empty string for a table with no data rows', () => {
    const $ = cheerio.load('<table><tbody><tr><th>A</th><th>B</th></tr></tbody></table>');
    expect(flattenTable($, $('table').first())).toBe('');
  });

  it('pairs each value with its own header once spans are applied', async () => {
    // Read by position, Birch's drops told the index that G1 was "Large
    // Birch Logs" and that the chance was a tree variant.
    const $ = cheerio.load(await fixtureHtml('Birch'));
    const drops = $('table.article-table').first();
    const lines = flattenTable($, drops).split('\n');
    expect(lines[0]).toBe(
      'Amount: 2; Item: Large Birch Logs; Chance: 100%; Average per Tree › G1: 2; Average per Tree › G2: 2; ' +
        'Average per Tree › Y1: 2; Average per Tree › Y2: 2',
    );
    expect(lines).toContain(
      '50% chance to drop between X and 2 of: — Amount: 1-2; Item: Resin; Chance: 25%; Average per Tree › G1: 0.375; ' +
        'Average per Tree › G2: 0.1875; Average per Tree › Y1: 0.1875; Average per Tree › Y2: 0.1875',
    );
  });

  it('joins a cell’s lines with commas, keeping one line per row', async () => {
    const $ = cheerio.load(await fixtureHtml('Iron_Sword'));
    const text = flattenTable($, $('table.article-table').first());
    expect(text).toMatch(/Quality: Crafting; 1: 2 Wood, 20 Iron, 3 Leather scraps; 2: 1 Wood, 10 Iron, 2 Leather scraps/);
    expect(text).not.toMatch(/Wood\d|Iron\d/);
  });

  it('joins a cell’s sentences with a space, not a comma', () => {
    const $ = cheerio.load(
      '<table><tr><th>Event</th><th>Line</th></tr><tr><td>Welcome</td><td><p>I am Hugin.</p><p>The stones are Sacrificial Stones</p></td></tr></table>',
    );
    expect(flattenTable($, $('table'))).toBe('Event: Welcome; Line: I am Hugin. The stones are Sacrificial Stones');
  });

  it('heads each line of a one-column table with the th row above it', () => {
    // Hugin's dialogue: "Welcome: Vegvisirs" told the index the wrong event.
    const $ = cheerio.load(
      '<table><tr><th>Welcome</th></tr><tr><td>Welcome to the tenth world</td></tr><tr><th>Vegvisirs</th></tr><tr><td>This stone is a Vegvisir</td></tr></table>',
    );
    expect(flattenTable($, $('table')).split('\n')).toEqual([
      'Welcome — Welcome to the tenth world',
      'Vegvisirs — This stone is a Vegvisir',
    ]);
  });

  it('flattens a notice banner to nothing', async () => {
    const $ = cheerio.load(await fixtureHtml('Birch'));
    expect(flattenTable($, $('table').first())).toBe('');
  });
});

describe('extractSections — banners and nested tables', () => {
  it('leaves maintenance banners out and keeps a status banner as prose', async () => {
    const birch = await extractSections(await fixtureHtml('Birch'));
    expect(JSON.stringify(birch)).not.toMatch(/work in progress/i);
    expect(birch[0]!.text).toMatch(/^Birch is a type of tree/);

    const cape = await extractSections(await fixtureHtml('Cape_of_Odin'));
    expect(cape[0]!.text).toMatch(/This article is for a DLC item or feature\.\nIt may no longer be available/);
    expect(cape[0]!.tables.join('\n')).not.toMatch(/DLC item/);
  });

  it('indexes a table nested in a layout table once, as its own table', async () => {
    const html = `<div class="mw-parser-output"><h2>Experience</h2>
      <table><tr><th>Level 1-50</th><th>Level 51-100</th></tr><tr>
        <td><table><tr><th>Level</th><th>XP</th></tr><tr><td>1</td><td>1.0</td></tr></table></td>
        <td><table><tr><th>Level</th><th>XP</th></tr><tr><td>51</td><td>182.6</td></tr></table></td>
      </tr></table>
      <div><table><tr><th>A</th></tr><tr><td><table><tr><th>B</th></tr><tr><td>inner</td></tr></table></td></tr></table></div>
    </div>`;
    const [section] = await extractSections(html);
    expect(section!.tables).toEqual(['Level: 1; XP: 1.0', 'Level: 51; XP: 182.6', 'B: inner']);
  });

  it('keeps a line break inside a paragraph', async () => {
    const [section] = await extractSections('<div class="mw-parser-output"><p>Line one<br>Line two</p></div>');
    expect(section!.text).toBe('Line one\nLine two');
  });
});
