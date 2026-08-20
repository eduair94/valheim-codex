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
});
