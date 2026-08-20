import { sql } from 'drizzle-orm';
import { rawQuery, type Db } from '@/lib/db/create-db';
import { embedQuery, toVectorLiteral } from './embed';
import { reciprocalRankFusion, type RankedList } from './rrf';
import { buildTsQuery } from './tsquery';
import { translateQuery } from './glossary';

export type RetrievedChunk = {
  id: string;
  title: string;
  url: string;
  sectionPath: string;
  kind: string;
  content: string;
  source: string;
  sourceRank: number;
  /** In-app article slug, when the page has a reading document. */
  slug: string | null;
};

export type ScoredChunk = RetrievedChunk & {
  score: number;
  ranks: Record<string, number>;
};

export type RetrieveOptions = {
  /** Search strings to run. Usually the rewritten English queries. */
  queries: string[];
  /** Candidates pulled per retriever per query. */
  candidatesPerRetriever?: number;
  /** Chunks handed to the model. */
  topK?: number;
  /** Cap on context size, in estimated tokens. */
  maxContextTokens?: number;
  /** Injected in tests to avoid calling the embeddings API. */
  embedFn?: (text: string) => Promise<number[]>;
};

/**
 * Adds a glossary-translated variant of any query containing Spanish terms.
 *
 * The translated form is an extra query rather than a replacement: RRF fuses
 * both, so a query the glossary handles badly cannot make results worse than
 * the original alone. This is what keeps retrieval usable when the LLM rewrite
 * is unavailable.
 */
function expandQueries(queries: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (q: string): void => {
    const key = q.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(q.trim());
  };

  for (const query of queries) {
    add(query);
    const translated = translateQuery(query);
    if (translated) add(translated);
  }
  return out;
}

/**
 * Rank weights for {D, C, B, A}: body, unused, section, title.
 *
 * These are Postgres' defaults, stated explicitly because the whole point of
 * the weighted tsvector is this ratio — a title match counts ten times a body
 * match — and a silent default is easy to lose in a later edit.
 */
const FTS_WEIGHTS = '{0.1, 0.2, 0.4, 1.0}';

/**
 * ts_rank_cd normalisation flag 1: divide the rank by `1 + log(length)`.
 *
 * Without it, rank is a plain sum of weighted hits, so a long list page wins by
 * volume. Concretely, the *Iron* article's "Usage > Crafting" section lists
 * every iron item — including "Iron sword" — and out-ranked the *Iron Sword*
 * article itself for "iron sword materials". Dividing by document length makes
 * a short, focused chunk beat a long catalogue that merely mentions the term.
 */
const FTS_NORMALISATION = 1;

type CandidateRow = {
  id: string;
  title: string;
  url: string;
  section_path: string;
  kind: string;
  content: string;
  source: string;
  source_rank: number;
  slug: string | null;
  vector_rank: number | null;
  fts_rank: number | null;
};

/**
 * Hybrid retrieval: dense vectors and full-text, fused with RRF.
 *
 * Neither retriever is sufficient alone here. Vector search generalises across
 * languages and paraphrase, which is what makes a Spanish question find English
 * wiki text, but it blurs rare proper nouns — the exact tokens Valheim
 * questions are full of. Full-text nails those and is useless for paraphrase.
 */
export async function retrieve(db: Db, options: RetrieveOptions): Promise<ScoredChunk[]> {
  const {
    queries,
    candidatesPerRetriever = 20,
    topK = 8,
    maxContextTokens = 6000,
    embedFn = embedQuery,
  } = options;

  const cleaned = expandQueries(queries);
  if (cleaned.length === 0) return [];

  const lists: RankedList<RetrievedChunk>[] = [];

  for (const [i, query] of cleaned.entries()) {
    const vector = toVectorLiteral(await embedFn(query));
    const tsQuery = buildTsQuery(query);

    const rows = await rawQuery<CandidateRow>(
      db,
      sql`
        WITH vec AS (
          SELECT id, row_number() OVER (ORDER BY embedding <=> ${vector}::vector) AS rank
          FROM chunks
          WHERE embedding IS NOT NULL
          ORDER BY embedding <=> ${vector}::vector
          LIMIT ${candidatesPerRetriever}
        ),
        fts AS (
          SELECT c.id,
                 row_number() OVER (
                   ORDER BY ts_rank_cd(${FTS_WEIGHTS}, c.fts, q, ${FTS_NORMALISATION}) DESC
                 ) AS rank
          FROM chunks c, websearch_to_tsquery('simple', ${tsQuery}) q
          WHERE ${tsQuery} <> '' AND c.fts @@ q
          ORDER BY ts_rank_cd(${FTS_WEIGHTS}, c.fts, q, ${FTS_NORMALISATION}) DESC
          LIMIT ${candidatesPerRetriever}
        )
        SELECT c.id, c.title, c.url, c.section_path, c.kind, c.content, c.source, c.source_rank,
               a.slug,
               vec.rank AS vector_rank, fts.rank AS fts_rank
        FROM chunks c
        LEFT JOIN vec ON vec.id = c.id
        LEFT JOIN fts ON fts.id = c.id
        -- The reading document may not exist yet on a partially ingested
        -- index, so this join must not drop the chunk.
        LEFT JOIN articles a ON a.page_key = c.page_key
        WHERE vec.rank IS NOT NULL OR fts.rank IS NOT NULL
      `,
    );

    const toChunk = (r: CandidateRow): RetrievedChunk => ({
      id: r.id,
      title: r.title,
      url: r.url,
      sectionPath: r.section_path,
      kind: r.kind,
      content: r.content,
      source: r.source,
      sourceRank: Number(r.source_rank),
      slug: r.slug,
    });

    const vectorHits = rows
      .filter((r) => r.vector_rank !== null)
      .sort((a, b) => Number(a.vector_rank) - Number(b.vector_rank))
      .map(toChunk);
    const ftsHits = rows
      .filter((r) => r.fts_rank !== null)
      .sort((a, b) => Number(a.fts_rank) - Number(b.fts_rank))
      .map(toChunk);

    if (vectorHits.length > 0) lists.push({ name: `vector:${i}`, items: vectorHits });
    if (ftsHits.length > 0) lists.push({ name: `fts:${i}`, items: ftsHits });
  }

  /*
   * Give each retriever the same total influence, however many query variants
   * it ran.
   *
   * A question and its glossary translation produce near-identical vector
   * lists, so counting each list equally let the vector side vote twice while
   * full-text — which only matched the translated form — voted once. That is
   * how "¿qué hace la comida en Valheim?" kept returning the *Valheim* article
   * even after full-text ranked *Food* first.
   */
  const countByRetriever = new Map<string, number>();
  for (const list of lists) {
    const kind = list.name.split(':')[0]!;
    countByRetriever.set(kind, (countByRetriever.get(kind) ?? 0) + 1);
  }
  for (const list of lists) {
    const kind = list.name.split(':')[0]!;
    list.weight = 1 / (countByRetriever.get(kind) ?? 1);
  }

  const fused = reciprocalRankFusion(lists, {
    key: (c) => c.id,
    sourceRank: (c) => c.sourceRank,
  });

  // Take the best chunks, then trim to the context budget rather than to a
  // fixed count, so a page of short infobox rows is not starved by one long
  // prose section.
  const selected: ScoredChunk[] = [];
  let budget = maxContextTokens;
  for (const entry of fused.slice(0, topK * 2)) {
    if (selected.length >= topK) break;
    const cost = Math.ceil(entry.item.content.length / 4);
    if (cost > budget && selected.length > 0) continue;
    budget -= cost;
    selected.push({ ...entry.item, score: entry.score, ranks: entry.ranks });
  }
  return selected;
}
