/** An item as ranked by one retriever. Position 0 in the array is rank 1. */
export type RankedList<T> = {
  /** Label kept for debugging and for the eval harness. */
  name: string;
  items: T[];
  /** Relative influence of this list. Defaults to 1. */
  weight?: number;
};

export type FusionOptions<T> = {
  /** Stable identity of an item across lists. */
  key: (item: T) => string;
  /**
   * Rank-smoothing constant. 60 is the value from the original RRF paper; it
   * keeps the top of each list from dominating so completely that a result
   * found by only one retriever can never surface.
   */
  k?: number;
  /** Source penalty: the fused score is divided by `1 + penalty * rank(item)`. */
  sourceRank?: (item: T) => number;
  sourceRankPenalty?: number;
};

export type FusedResult<T> = {
  item: T;
  score: number;
  /** Which lists found it, and at what rank. Useful when debugging recall. */
  ranks: Record<string, number>;
};

/**
 * Reciprocal Rank Fusion.
 *
 * Chosen over score normalisation because cosine similarity and `ts_rank_cd`
 * are not on comparable scales, and any attempt to map them onto one is a
 * tuning exercise that drifts. RRF only reads positions, so it needs no
 * calibration when either retriever changes.
 *
 * When the same item appears in several lists its contributions add up, which
 * is what makes a chunk found by both vector and full-text search outrank one
 * found by either alone.
 */
export function reciprocalRankFusion<T>(
  lists: RankedList<T>[],
  options: FusionOptions<T>,
): FusedResult<T>[] {
  const { key, k = 60, sourceRank, sourceRankPenalty = 0.5 } = options;

  const byKey = new Map<string, FusedResult<T>>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.items.forEach((item, index) => {
      const rank = index + 1;
      const id = key(item);
      const existing = byKey.get(id);
      const contribution = weight / (k + rank);
      if (existing) {
        existing.score += contribution;
        // Keep the best rank seen for this list.
        const previous = existing.ranks[list.name];
        if (previous === undefined || rank < previous) existing.ranks[list.name] = rank;
      } else {
        byKey.set(id, { item, score: contribution, ranks: { [list.name]: rank } });
      }
    });
  }

  const fused = [...byKey.values()];

  if (sourceRank) {
    for (const entry of fused) {
      const penalty = 1 + sourceRankPenalty * sourceRank(entry.item);
      entry.score /= penalty;
    }
  }

  // Ties broken by key for a deterministic order.
  return fused.sort((a, b) => b.score - a.score || key(a.item).localeCompare(key(b.item)));
}
