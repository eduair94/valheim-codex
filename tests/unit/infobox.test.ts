import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractInfobox, renderInfobox } from '@/lib/wiki/infobox';

async function fixtureHtml(name: string): Promise<string> {
  const raw = await readFile(`tests/fixtures/${name}.json`, 'utf8');
  return (JSON.parse(raw) as { parse: { text: string } }).parse.text;
}

describe('extractInfobox', () => {
  it('returns null when the page has no infobox', async () => {
    expect(extractInfobox(await fixtureHtml('Swords'))).toBeNull();
  });

  it('reads the title and the top-level data pairs', async () => {
    const box = extractInfobox(await fixtureHtml('Iron_Sword'));
    expect(box).not.toBeNull();
    expect(box!.title).toBe('Iron sword');

    const top = box!.nodes.filter((n) => n.kind === 'data');
    const byLabel = new Map(top.map((n) => [n.label, n.value]));
    expect(byLabel.get('Internal ID')).toBe('SwordIron');
    expect(byLabel.get('Type')).toBe('Sword');
    expect(byLabel.get('Source')).toBe('Forge');
    expect(byLabel.get('Usage')).toBe('Weapon');
  });

  it('captures upgrade tabs as separate labelled branches', async () => {
    const box = extractInfobox(await fixtureHtml('Iron_Sword'));
    const tabs = box!.nodes.find((n) => n.kind === 'tabs');
    expect(tabs).toBeDefined();
    expect(tabs!.kind).toBe('tabs');
    if (tabs?.kind !== 'tabs') throw new Error('unreachable');
    expect(tabs.tabs.map((t) => t.label)).toEqual(['1', '2', '3', '4']);
  });
});

describe('renderInfobox', () => {
  it('pairs horizontal-group labels with their values instead of running them together', async () => {
    const box = extractInfobox(await fixtureHtml('Iron_Sword'));
    const rendered = renderInfobox(box!);

    // The naive text extraction produces "Weight Durability 0.8 200"; the whole
    // point of the extractor is that each number stays attached to its label.
    expect(rendered).toMatch(/Weight: 0\.8/);
    expect(rendered).toMatch(/Durability: 200/);
    expect(rendered).not.toMatch(/Weight Durability/);
  });

  it('keeps per-level values under their own level heading', async () => {
    const box = extractInfobox(await fixtureHtml('Iron_Sword'));
    const perTab = renderInfobox(box!, { tab: '1' });
    expect(perTab).toMatch(/Level 1/);
    expect(perTab).toMatch(/Crafting Level: 2/);
    expect(perTab).toMatch(/Repair Level: 2/);
  });

  it('renders crafting materials as a readable list', async () => {
    const box = extractInfobox(await fixtureHtml('Iron_Sword'));
    const rendered = renderInfobox(box!, { tab: '1' });
    expect(rendered).toMatch(/Crafting Materials:/);
    expect(rendered).toMatch(/Iron x20/);
    expect(rendered).toMatch(/Wood x2/);
    expect(rendered).toMatch(/Leather scraps x3/);
  });

  it('works on a creature infobox', async () => {
    const box = extractInfobox(await fixtureHtml('Deathsquito'));
    expect(box).not.toBeNull();
    const rendered = renderInfobox(box!);
    expect(rendered.length).toBeGreaterThan(50);
    expect(rendered).toContain('Deathsquito');
  });

  it('never emits raw html or collapsed whitespace', async () => {
    for (const name of ['Iron_Sword', 'Bonemass', 'Deathsquito', 'Iron']) {
      const box = extractInfobox(await fixtureHtml(name));
      if (!box) continue;
      const rendered = renderInfobox(box);
      expect(rendered).not.toMatch(/<[a-z]/i);
      expect(rendered).not.toMatch(/&(nbsp|#160|amp);/);
      expect(rendered).not.toMatch(/ {2,}/);
    }
  });
});

describe('renderInfobox tab headings', () => {
  it('prefixes numeric tabs with the tab word', async () => {
    const box = extractInfobox(await fixtureHtml('Iron_Sword'));
    expect(renderInfobox(box!, { tab: '3' })).toMatch(/Level 3/);
  });

  it('leaves non-numeric tabs alone rather than producing "Level Trophy"', async () => {
    const box = extractInfobox(await fixtureHtml('Deathsquito'));
    const rendered = renderInfobox(box!);
    expect(rendered).not.toMatch(/Level Trophy/);
    expect(rendered).not.toMatch(/Level 0★/);
    expect(rendered).toMatch(/0★/);
  });

  it('merges consecutive lines that share a breadcrumb', async () => {
    const box = extractInfobox(await fixtureHtml('Iron_Sword'));
    const rendered = renderInfobox(box!, { tab: '1' });
    const propertyLines = rendered.split('\n').filter((l) => l.startsWith('Level 1 › Properties:'));
    expect(propertyLines).toHaveLength(1);
    // ...and merging must not lose any of the merged values.
    expect(propertyLines[0]).toMatch(/Weight: 0\.8/);
    expect(propertyLines[0]).toMatch(/Iron x20/);
  });
});
