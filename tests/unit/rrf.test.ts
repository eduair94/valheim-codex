import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '@/lib/rag/rrf';

type Doc = { id: string; sourceRank?: number };
const key = (d: Doc): string => d.id;
const docs = (...ids: string[]): Doc[] => ids.map((id) => ({ id }));

describe('reciprocalRankFusion', () => {
  it('preserves a single list order', () => {
    const fused = reciprocalRankFusion([{ name: 'v', items: docs('a', 'b', 'c') }], { key });
    expect(fused.map((f) => f.item.id)).toEqual(['a', 'b', 'c']);
  });

  it('promotes an item that both retrievers found over one either found alone', () => {
    const fused = reciprocalRankFusion(
      [
        { name: 'vector', items: docs('a', 'shared', 'c') },
        { name: 'fts', items: docs('d', 'shared', 'f') },
      ],
      { key },
    );
    expect(fused[0]!.item.id).toBe('shared');
  });

  it('records the rank each list gave an item', () => {
    const fused = reciprocalRankFusion(
      [
        { name: 'vector', items: docs('a', 'shared') },
        { name: 'fts', items: docs('shared') },
      ],
      { key },
    );
    const shared = fused.find((f) => f.item.id === 'shared')!;
    expect(shared.ranks).toEqual({ vector: 2, fts: 1 });
  });

  it('keeps items only one retriever found — the point of a hybrid', () => {
    const fused = reciprocalRankFusion(
      [
        { name: 'vector', items: docs('a', 'b') },
        { name: 'fts', items: docs('rare-name') },
      ],
      { key },
    );
    expect(fused.map((f) => f.item.id)).toContain('rare-name');
  });

  it('honours list weights', () => {
    const light = reciprocalRankFusion(
      [
        { name: 'vector', items: docs('v'), weight: 1 },
        { name: 'fts', items: docs('f'), weight: 1 },
      ],
      { key },
    );
    expect(light[0]!.score).toBeCloseTo(light[1]!.score);

    const heavy = reciprocalRankFusion(
      [
        { name: 'vector', items: docs('v'), weight: 3 },
        { name: 'fts', items: docs('f'), weight: 1 },
      ],
      { key },
    );
    expect(heavy[0]!.item.id).toBe('v');
  });

  it('penalises lower-ranked sources on otherwise equal footing', () => {
    const items: Doc[] = [
      { id: 'preferred', sourceRank: 0 },
      { id: 'secondary', sourceRank: 1 },
    ];
    const fused = reciprocalRankFusion(
      [
        { name: 'a', items: [items[1]!, items[0]!] },
        { name: 'b', items: [items[1]!, items[0]!] },
      ],
      { key, sourceRank: (d) => d.sourceRank ?? 0, sourceRankPenalty: 5 },
    );
    // 'secondary' is ranked first by both retrievers, yet the penalty must
    // still hand the win to the preferred wiki.
    expect(fused[0]!.item.id).toBe('preferred');
  });

  it('applies no penalty when every item is from the preferred source', () => {
    const withPenalty = reciprocalRankFusion([{ name: 'a', items: docs('x') }], {
      key,
      sourceRank: () => 0,
      sourceRankPenalty: 10,
    });
    const without = reciprocalRankFusion([{ name: 'a', items: docs('x') }], { key });
    expect(withPenalty[0]!.score).toBeCloseTo(without[0]!.score);
  });

  it('is deterministic when scores tie', () => {
    const run = () =>
      reciprocalRankFusion(
        [
          { name: 'a', items: docs('b') },
          { name: 'b', items: docs('a') },
        ],
        { key },
      ).map((f) => f.item.id);
    expect(run()).toEqual(run());
    expect(run()).toEqual(['a', 'b']);
  });

  it('returns an empty array for empty input', () => {
    expect(reciprocalRankFusion<Doc>([], { key })).toEqual([]);
    expect(reciprocalRankFusion<Doc>([{ name: 'a', items: [] }], { key })).toEqual([]);
  });

  it('deduplicates an item repeated within one list, keeping the best rank', () => {
    const fused = reciprocalRankFusion([{ name: 'a', items: docs('x', 'y', 'x') }], { key });
    expect(fused.filter((f) => f.item.id === 'x')).toHaveLength(1);
    expect(fused.find((f) => f.item.id === 'x')!.ranks['a']).toBe(1);
  });
});
