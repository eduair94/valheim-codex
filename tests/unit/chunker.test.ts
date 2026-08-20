import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { chunkPage, MAX_CHUNK_TOKENS } from '@/lib/wiki/chunker';
import { extractSections } from '@/lib/wiki/html';
import { extractInfobox } from '@/lib/wiki/infobox';
import type { FetchedPage, ParsedPage } from '@/lib/wiki/types';

async function parseFixture(name: string, title: string): Promise<ParsedPage> {
  const raw = await readFile(`tests/fixtures/${name}.json`, 'utf8');
  const parsed = JSON.parse(raw) as { parse: { text: string; revid: number } };
  const page: FetchedPage = {
    source: 'fandom',
    pageId: 1,
    title,
    url: `https://valheim.fandom.com/wiki/${name}`,
    revid: parsed.parse.revid,
    categories: [],
    html: parsed.parse.text,
  };
  return {
    page,
    infobox: extractInfobox(page.html),
    sections: await extractSections(page.html),
  };
}

describe('chunkPage', () => {
  it('emits one infobox chunk per upgrade level', async () => {
    const chunks = chunkPage(await parseFixture('Iron_Sword', 'Iron Sword'), { sourceRank: 0 });
    const infoboxes = chunks.filter((c) => c.kind === 'infobox');
    expect(infoboxes).toHaveLength(4);
    expect(infoboxes.map((c) => c.sectionPath)).toEqual([
      'Level 1', 'Level 2', 'Level 3', 'Level 4',
    ]);
  });

  it('repeats the shared infobox data in every level chunk so each stands alone', async () => {
    const chunks = chunkPage(await parseFixture('Iron_Sword', 'Iron Sword'), { sourceRank: 0 });
    for (const c of chunks.filter((c) => c.kind === 'infobox')) {
      expect(c.content).toMatch(/Type: Sword/);
      expect(c.content).toMatch(/Source: Forge/);
    }
  });

  it('keeps different levels genuinely different', async () => {
    const chunks = chunkPage(await parseFixture('Iron_Sword', 'Iron Sword'), { sourceRank: 0 });
    const [l1, l2] = chunks.filter((c) => c.kind === 'infobox');
    expect(l1!.content).not.toBe(l2!.content);
    expect(l1!.content).toMatch(/Level 1/);
    expect(l2!.content).toMatch(/Level 2/);
  });

  it('emits a single infobox chunk when the page has no tabs', async () => {
    const chunks = chunkPage(await parseFixture('Iron', 'Iron'), { sourceRank: 0 });
    expect(chunks.filter((c) => c.kind === 'infobox')).toHaveLength(1);
  });

  it('prefixes every chunk with the page title so it reads standalone', async () => {
    const chunks = chunkPage(await parseFixture('Bonemass', 'Bonemass'), { sourceRank: 0 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.content.startsWith('Bonemass')).toBe(true);
    }
  });

  it('respects the token budget', async () => {
    for (const [file, title] of [['Bonemass', 'Bonemass'], ['Iron', 'Iron'], ['Swords', 'Swords']] as const) {
      const chunks = chunkPage(await parseFixture(file, title), { sourceRank: 0 });
      for (const c of chunks) {
        // A single unsplittable line may overshoot; anything else must not.
        expect(c.tokenCount).toBeLessThanOrEqual(MAX_CHUNK_TOKENS * 1.5);
      }
    }
  });

  it('produces unique, deterministic ids', async () => {
    const parsed = await parseFixture('Bonemass', 'Bonemass');
    const a = chunkPage(parsed, { sourceRank: 0 });
    const b = chunkPage(parsed, { sourceRank: 0 });
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
    expect(a.map((c) => c.contentHash)).toEqual(b.map((c) => c.contentHash));
  });

  it('carries source rank and page key onto every chunk', async () => {
    const chunks = chunkPage(await parseFixture('Iron', 'Iron'), { sourceRank: 2 });
    for (const c of chunks) {
      expect(c.sourceRank).toBe(2);
      expect(c.pageKey).toBe('fandom:1');
      expect(c.source).toBe('fandom');
    }
  });

  it('drops chunks too small to be worth retrieving', async () => {
    const parsed = await parseFixture('Deathsquito', 'Deathsquito');
    for (const c of chunkPage(parsed, { sourceRank: 0 })) {
      if (c.kind === 'prose') expect(c.tokenCount).toBeGreaterThan(8);
    }
  });

  it('splits long prose with overlap so a fact is never orphaned at a boundary', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) =>
      `Paragraph ${i} ${'filler words to make this long enough to matter '.repeat(12)}`,
    );
    const parsed: ParsedPage = {
      page: {
        source: 'fandom', pageId: 9, title: 'Long', url: 'https://example.test/Long',
        revid: 1, categories: [], html: '',
      },
      infobox: null,
      sections: [{ path: 'Body', text: paragraphs.join('\n\n'), tables: [] }],
    };
    const chunks = chunkPage(parsed, { sourceRank: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i += 1) {
      const previousTail = chunks[i - 1]!.content.split('\n\n').at(-1)!;
      expect(chunks[i]!.content).toContain(previousTail.slice(0, 40));
    }
  });

  it('emits table chunks separately from prose', async () => {
    const chunks = chunkPage(await parseFixture('Swords', 'Swords'), { sourceRank: 0 });
    const tables = chunks.filter((c) => c.kind === 'table');
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.some((c) => /Bronze sword/.test(c.content))).toBe(true);
  });
});
