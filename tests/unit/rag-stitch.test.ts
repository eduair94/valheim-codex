import { describe, expect, it } from 'vitest';
import { buildContext } from '@/lib/rag/prompt';
import type { ScoredChunk } from '@/lib/rag/retrieve';
import {
  anchorsFor,
  contextTokens,
  familyKey,
  pinnedExcerpts,
  renderSection,
  stitch,
  STITCHED_KIND,
  type PinnedRow,
  type SectionMember,
} from '@/lib/rag/stitch';

/** A chunk as retrieval returns it: content starts with its breadcrumb, as the chunker writes it. */
function chunk(id: string, sectionPath: string, body: string, overrides: Partial<ScoredChunk> = {}): ScoredChunk {
  const title = overrides.title ?? 'Tin';
  const crumb = [title, ...sectionPath.split(' > ').filter(Boolean)].join(' › ');
  return {
    id,
    title,
    url: `https://valheim.fandom.com/wiki/${title}`,
    sectionPath,
    kind: 'prose',
    content: `${crumb}\n${body}`,
    source: 'fandom',
    sourceRank: 0,
    slug: title.toLowerCase(),
    pageKey: 'fandom:124',
    score: 0.5,
    ranks: { 'vector:0': 1 },
    ...overrides,
  };
}

function member(from: ScoredChunk, tokenCount = contextTokens(from.content)): SectionMember {
  return { id: from.id, sectionPath: from.sectionPath, kind: from.kind, content: from.content, tokenCount };
}

// Tin's Usage section, as stored: two chunks of 11 tokens.
const building = chunk('fandom:124:prose:2', 'Usage > Building', 'Cauldron\nMead ketill');
const crafting = chunk('fandom:124:prose:3', 'Usage > Crafting', 'Bronze\nButcher knife');
const lead = chunk('fandom:124:prose:1', '', 'Tin is a crafting material smelted from Tin ore in a Smelter.');
const infobox = chunk('fandom:124:infobox:0', '', 'Type: Material; Weight: 12.0', { kind: 'infobox' });
const other = chunk('fandom:571:prose:1', '', 'Bronze is an alloy of copper and tin.', { title: 'Bronze', pageKey: 'fandom:571' });

const tinUsage = new Map([[familyKey('fandom:124', 'Usage'), [member(building), member(crafting)]]]);
const roomy = { maxContextTokens: 6000 };

describe('anchorsFor', () => {
  it('tries the top-level section, and the direct parent of a deeper chunk', () => {
    expect(anchorsFor('Usage')).toEqual(['Usage']);
    expect(anchorsFor('Usage > Crafting')).toEqual(['Usage']);
    expect(anchorsFor('Usage > Crafting > Tools')).toEqual(['Usage', 'Usage > Crafting']);
    expect(anchorsFor('A > B > C > D')).toEqual(['A', 'A > B > C']);
  });

  it('gives a lead none', () => {
    expect(anchorsFor('')).toEqual([]);
  });
});

describe('stitch', () => {
  it('completes Tin’s Usage section from its Crafting half', () => {
    const out = stitch([lead, crafting, other], tinUsage, roomy);

    expect(out).toHaveLength(3);
    const block = out[1]!;
    expect(block).toMatchObject({
      title: 'Tin',
      sectionPath: 'Usage',
      kind: STITCHED_KIND,
      id: 'fandom:124:prose:2',
      ids: ['fandom:124:prose:2', 'fandom:124:prose:3'],
      // The place, score and ranks of the chunk that brought the section in.
      score: crafting.score,
      ranks: crafting.ranks,
    });
    expect(block.content).toBe('Tin › Usage\nBuilding: Cauldron, Mead ketill\nCrafting: Bronze, Butcher knife');
    for (const name of ['Cauldron', 'Mead ketill', 'Bronze', 'Butcher knife']) expect(block.content).toContain(name);
    expect(out[0]).toBe(lead);
    expect(out[2]).toBe(other);
  });

  it('folds siblings that were both selected into one excerpt, freeing a place', () => {
    const out = stitch([crafting, other, building], tinUsage, roomy);
    expect(out.map((c) => c.id)).toEqual(['fandom:124:prose:2', 'fandom:571:prose:1']);
    expect(out[0]!.ids).toEqual(['fandom:124:prose:2', 'fandom:124:prose:3']);
    // The best-ranked member's place and score.
    expect(out[0]!.score).toBe(crafting.score);
  });

  it('lists the members in document order, whichever of them was selected', () => {
    const [block] = stitch([crafting], tinUsage, roomy);
    expect(block!.content.indexOf('Building:')).toBeLessThan(block!.content.indexOf('Crafting:'));
    expect(block!.ids).toEqual(['fandom:124:prose:2', 'fandom:124:prose:3']);
  });

  it('leaves a section larger than the limit as it was', () => {
    const big = new Map([[familyKey('fandom:124', 'Usage'), [member(building, 300), member(crafting, 200)]]]);
    expect(stitch([crafting], big, roomy)).toEqual([crafting]);
    expect(stitch([crafting], tinUsage, { ...roomy, familyMaxTokens: 10 })).toEqual([crafting]);
  });

  it('falls back to the direct parent when the whole section is too large', () => {
    const wood = { title: 'Wood', pageKey: 'fandom:9' };
    const catalogue = chunk('fandom:9:prose:2', 'Usage > Building', 'Too many to list', wood);
    const intro = chunk('fandom:9:prose:3', 'Usage > Crafting', 'Wood is used in most early recipes.', wood);
    const tools = chunk('fandom:9:prose:4', 'Usage > Crafting > Tools', 'Club\nStone axe', wood);
    const weapons = chunk('fandom:9:prose:5', 'Usage > Crafting > Weapons', 'Wood bow', wood);
    const families = new Map([
      [familyKey('fandom:9', 'Usage'), [member(catalogue, 440), member(intro), member(tools), member(weapons)]],
      [familyKey('fandom:9', 'Usage > Crafting'), [member(intro), member(tools), member(weapons)]],
    ]);

    const [block] = stitch([tools], families, roomy);
    expect(block).toMatchObject({ sectionPath: 'Usage > Crafting', ids: [intro.id, tools.id, weapons.id] });
    expect(block!.content).toBe('Wood › Usage › Crafting\nWood is used in most early recipes.\nTools: Club, Stone axe\nWeapons: Wood bow');
  });

  it('leaves infoboxes and leads alone', () => {
    // Even with a family filed under their path, which a lead cannot have.
    const families = new Map([
      [familyKey('fandom:124', ''), [member(lead), member(building)]],
      [familyKey('fandom:124', 'Level 1'), [member(infobox), member(building)]],
    ]);
    const levelOne = { ...infobox, sectionPath: 'Level 1' };
    expect(stitch([infobox, levelOne, lead], families, roomy)).toEqual([infobox, levelOne, lead]);
  });

  it('adds nothing once the context or the stitching allowance is spent', () => {
    const selected = [lead, crafting];
    const used = selected.reduce((sum, c) => sum + contextTokens(c.content), 0);
    // The excerpt costs more than the chunk it replaces, and there is no room for the difference.
    expect(stitch(selected, tinUsage, { maxContextTokens: used })).toEqual(selected);
    expect(stitch(selected, tinUsage, { ...roomy, extraTokens: 0 })).toEqual(selected);
    // With room for it, it goes in.
    expect(stitch(selected, tinUsage, { maxContextTokens: used + 20 })[1]!.kind).toBe(STITCHED_KIND);
  });

  it('never takes the context past its ceiling', () => {
    const selected = [lead, crafting, other];
    for (let ceiling = 30; ceiling <= 80; ceiling += 1) {
      const out = stitch(selected, tinUsage, { maxContextTokens: ceiling });
      const before = selected.reduce((sum, c) => sum + contextTokens(c.content), 0);
      const after = out.reduce((sum, c) => sum + contextTokens(c.content), 0);
      expect(after <= Math.max(before, ceiling)).toBe(true);
    }
  });

  it('keeps pinned chunks as they are, and out of every other excerpt', () => {
    const pinned = { ...building, ranks: { pinned: 1 } };
    const out = stitch([pinned, crafting], tinUsage, { ...roomy, keep: new Set([building.id]) });
    // Without its pinned sibling, Crafting is a section of one: nothing to stitch.
    expect(out).toEqual([pinned, crafting]);
  });

  it('keeps the excerpts numbered 1 to n after stitching', () => {
    const out = stitch([crafting, lead, building, other], tinUsage, roomy);
    const { context, citations } = buildContext(out);
    expect(citations.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(context.match(/^\[\d+\]/gm)).toEqual(['[1]', '[2]', '[3]']);
    expect(citations[0]).toMatchObject({ title: 'Tin', sectionPath: 'Usage' });
  });
});

describe('renderSection', () => {
  const rendered = (members: ScoredChunk[], anchor = 'Usage') => renderSection('Tin', anchor, members.map((m) => member(m)));

  it('writes a pure list on one line under its label', () => {
    expect(rendered([building])).toBe('Tin › Usage\nBuilding: Cauldron, Mead ketill');
  });

  it('keeps a list whose blank lines separate groups on its lines', () => {
    // Deer Hide's uses come by biome: one line would make "Meadows" an item.
    const grouped = chunk('fandom:925:prose:2', 'Usage > Building', 'Meadows\nDeer rug\nTanning rack\n\nBlack Forest\nKarve');
    expect(rendered([grouped, crafting])).toBe(
      'Tin › Usage\nBuilding:\nMeadows\nDeer rug\nTanning rack\n\nBlack Forest\nKarve\n\nCrafting: Bronze, Butcher knife',
    );
  });

  it('keeps sentences and long lines as they are', () => {
    const prose = chunk('fandom:124:prose:5', 'Usage > Notes', 'It is used for bronze. It is light.\nAnother line');
    expect(rendered([prose])).toBe('Tin › Usage\nNotes:\nIt is used for bronze. It is light.\nAnother line');
    const long = chunk('fandom:124:prose:6', 'Usage > Building', 'A very long item name that goes on and on and on, past the limit');
    expect(rendered([long])).toBe('Tin › Usage\nBuilding: A very long item name that goes on and on and on, past the limit');
  });

  it('keeps a list on its lines when a name has a comma of its own', () => {
    const banners = chunk('fandom:579:prose:2', 'Usage > Building', 'Blue banner\nBlue, red and white banner');
    expect(rendered([banners])).toBe('Tin › Usage\nBuilding:\nBlue banner\nBlue, red and white banner');
  });

  it('heads a lead-and-section answer with the title alone', () => {
    const availability = chunk('fandom:124:prose:7', 'Availability', 'Black Forest shorelines');
    expect(renderSection('Tin', '', [member(lead), member(availability)])).toBe(
      'Tin\nTin is a crafting material smelted from Tin ore in a Smelter.\nAvailability: Black Forest shorelines',
    );
  });
});

describe('pinnedExcerpts', () => {
  const row = (from: ScoredChunk, tokenCount = contextTokens(from.content)): PinnedRow => {
    const { score: _score, ranks: _ranks, ...rest } = from;
    return { ...rest, tokenCount };
  };

  it('makes a small uses section one excerpt headed by its section', () => {
    const [excerpt, ...more] = pinnedExcerpts([row(building), row(crafting)], 'uses', 1);
    expect(more).toEqual([]);
    expect(excerpt).toMatchObject({
      id: building.id,
      ids: [building.id, crafting.id],
      sectionPath: 'Usage',
      kind: STITCHED_KIND,
      score: 0,
      ranks: { pinned: 1 },
      content: 'Tin › Usage\nBuilding: Cauldron, Mead ketill\nCrafting: Bronze, Butcher knife',
    });
    expect(excerpt).not.toHaveProperty('tokenCount');
  });

  it('heads a where answer with the title, each part with its section', () => {
    const availability = chunk('fandom:124:prose:7', 'Availability', 'Black Forest shorelines');
    const [excerpt] = pinnedExcerpts([row(lead), row(availability)], 'where', 2);
    expect(excerpt).toMatchObject({ sectionPath: '', ranks: { pinned: 2 }, ids: [lead.id, availability.id] });
    expect(excerpt!.content).toMatch(/^Tin\nTin is a crafting material/);
  });

  it('pins a section of one chunk as it is', () => {
    expect(pinnedExcerpts([row(building)], 'uses', 1)).toEqual([{ ...building, score: 0, ranks: { pinned: 1 } }]);
  });

  it('pins only the first two chunks of a section too large to show whole', () => {
    const third = chunk('fandom:124:prose:4', 'Usage > Upgrading', 'Crude bow');
    const out = pinnedExcerpts([row(building, 300), row(crafting, 200), row(third)], 'uses', 1);
    expect(out.map((c) => c.id)).toEqual([building.id, crafting.id]);
    expect(out.every((c) => c.ids === undefined)).toBe(true);
  });
});
