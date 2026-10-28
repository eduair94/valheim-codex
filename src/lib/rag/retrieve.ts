import { sql } from 'drizzle-orm';
import { clampText } from '@/lib/chat-server/text';
import { rawQuery, type Db } from '@/lib/db/create-db';
import { getSearchIndex } from '@/lib/db/wiki-repo';
import { describeError, logWarn } from '@/lib/log';
import { embedQueries, MAX_QUERY_CHARS, toVectorLiteral } from './embed';
import {
  detectIntent,
  INTENT_SECTIONS,
  MAX_PINNED_PAGES,
  pinCandidates,
  titleLinker,
  type IntentKind,
  type LinkerSource,
} from './intent';
import { reciprocalRankFusion, type RankedList } from './rrf';
import { contextTokens, pinnedExcerpts, stitchSections, textArray, type PinnedRow } from './stitch';
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
  /**
   * The article's lead picture, for `[img:n]`. Read by the retrieval query
   * itself, which already joins the article, instead of a second round trip
   * once retrieval is done.
   */
  image?: { url: string; alt: string } | null;
  /**
   * The page the chunk belongs to, which is what its section is completed
   * from (`stitch.ts`). Every chunk retrieval returns has one; a chunk made by
   * hand, as a prompt test makes them, need not.
   */
  pageKey?: string;
};

export type ScoredChunk = RetrievedChunk & {
  score: number;
  ranks: Record<string, number>;
  /**
   * Every chunk an excerpt is made of, in document order, when it is more
   * than one: a whole section (`stitch.ts`). `id` is then the first of them.
   */
  ids?: string[];
};

export type RetrieveOptions = {
  /** Search strings to run. Usually the rewritten English queries. */
  queries: string[];
  /**
   * The reader's question, as asked. Given, a question that asks what a thing
   * is for or where it is gets that thing's section pinned at the head of the
   * context (`intent.ts`); left out, retrieval ranks the queries alone.
   */
  question?: string;
  /**
   * Whether a model wrote `queries` (`plan.ts`). A model's queries name in
   * English what the question may name in a way the index does not ("Zinn"
   * is Tin), and a uses question pins those things too. Left out, the queries
   * are taken to be the question's own (`deterministicQueries`), which on a
   * follow-up carry the previous question: only what the question itself
   * names is pinned.
   */
  rewritten?: boolean;
  /**
   * The title index the question's names are linked through. Pass the cached
   * one where there is one — the app's is `getSearchIndexData` — so a turn
   * that plans and retrieves reads it once. Left out, it is read from `db`,
   * and only for a question that asks what a thing is for or where it is.
   */
  linker?: LinkerSource;
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
    /*
     * Capped before anything else touches it. The embedding model reads 512
     * tokens at most, but its tokenizer scans the whole string first, on the
     * main thread, in worse than quadratic time on text without spaces: 32 KB
     * took 11 s and stalled every other request on the server. A raw question
     * reaches this point whenever the rewrite fails.
     */
    const capped = clampText(query, MAX_QUERY_CHARS);
    add(capped);
    const translated = translateQuery(capped);
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

type ChunkRow = {
  id: string;
  title: string;
  url: string;
  section_path: string;
  kind: string;
  content: string;
  source: string;
  source_rank: number;
  page_key: string;
  slug: string | null;
  image_url: string | null;
  image_alt: string | null;
};

type CandidateRow = ChunkRow & {
  vector_rank: number | null;
  fts_rank: number | null;
};

function candidatesFor(db: Db, vector: string, tsQuery: string, limit: number): Promise<CandidateRow[]> {
  return rawQuery<CandidateRow>(
    db,
    sql`
      WITH vec AS (
        SELECT id, row_number() OVER (ORDER BY embedding <=> ${vector}::vector) AS rank
        FROM chunks
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${vector}::vector
        LIMIT ${limit}
      ),
      fts AS (
        SELECT c.id,
               row_number() OVER (
                 ORDER BY ts_rank_cd(${FTS_WEIGHTS}, c.fts, q, ${FTS_NORMALISATION}) DESC
               ) AS rank
        FROM chunks c, websearch_to_tsquery('simple', ${tsQuery}) q
        WHERE ${tsQuery} <> '' AND c.fts @@ q
        ORDER BY ts_rank_cd(${FTS_WEIGHTS}, c.fts, q, ${FTS_NORMALISATION}) DESC
        LIMIT ${limit}
      )
      SELECT c.id, c.title, c.url, c.section_path, c.kind, c.content, c.source, c.source_rank, c.page_key,
             a.slug,
             -- The picture an image marker in the answer resolves to: the
             -- infobox's, else the article's first, as on the article page.
             COALESCE(a.infobox -> 'image' ->> 'url', a.images -> 0 ->> 'url') AS image_url,
             COALESCE(a.infobox -> 'image' ->> 'alt', a.images -> 0 ->> 'alt') AS image_alt,
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
}

function toChunk(r: ChunkRow): RetrievedChunk {
  return {
    id: r.id,
    title: r.title,
    url: r.url,
    sectionPath: r.section_path,
    kind: r.kind,
    content: r.content,
    source: r.source,
    sourceRank: Number(r.source_rank),
    slug: r.slug,
    image: r.image_url ? { url: r.image_url, alt: r.image_alt ?? '' } : null,
    pageKey: r.page_key,
  };
}

/**
 * The section an intent asks for on each article named: one list of chunks
 * per article that has it, in the order the articles were named, each in
 * document order. An article without the section is left out.
 *
 * Joined through the slug because the title index the names were linked
 * through carries slugs, not page keys; `articles_slug_idx` and the chunks'
 * page index make it two index lookups per article. Never an infobox: the
 * lead's repeats the item's stats, not its uses or its whereabouts. A where
 * answer reads prose only, as it was measured.
 */
export async function fetchPinnedSections(
  db: Db,
  slugs: readonly string[],
  kind: IntentKind,
): Promise<PinnedRow[][]> {
  if (slugs.length === 0) return [];
  const rows = await rawQuery<ChunkRow & { slug: string; token_count: number }>(
    db,
    sql`
      SELECT c.id, c.title, c.url, c.section_path, c.kind, c.content, c.source, c.source_rank, c.page_key,
             c.token_count, a.slug,
             COALESCE(a.infobox -> 'image' ->> 'url', a.images -> 0 ->> 'url') AS image_url,
             COALESCE(a.infobox -> 'image' ->> 'alt', a.images -> 0 ->> 'alt') AS image_alt
      FROM articles a
      JOIN chunks c ON c.page_key = a.page_key
      WHERE a.slug = ANY(${textArray(slugs)})
        AND c.kind <> 'infobox'
        AND c.section_path ~ ${INTENT_SECTIONS[kind]}
        ${kind === 'where' ? sql`AND c.kind = 'prose'` : sql``}
      ORDER BY array_position(${textArray(slugs)}, a.slug), split_part(c.id, ':', 4)::int
    `,
  );

  const sections: PinnedRow[][] = [];
  let article: string | undefined;
  for (const row of rows) {
    if (row.slug !== article) {
      sections.push([]);
      article = row.slug;
    }
    sections.at(-1)!.push({ ...toChunk(row), tokenCount: Number(row.token_count) });
  }
  return sections;
}

/**
 * The excerpts a question pins: for a uses or where question, the section it
 * asks for on each article it names, at most `MAX_PINNED_PAGES` of the
 * articles that have one, in the order they were named. `rewrites` are the
 * queries a model wrote for it, if one did.
 *
 * Never fails a retrieval. The pin makes a good answer more likely; ranking
 * alone still answers, as it did before there were pins, so a failure here
 * is said and the answer goes ahead without.
 */
async function pinnedFor(
  db: Db,
  question: string,
  rewrites: string[],
  linker: LinkerSource,
): Promise<ScoredChunk[]> {
  const intent = detectIntent(question);
  if (!intent) return [];
  try {
    const titles = await linker();
    if (!titles) return [];
    // Room for named articles that turn out to have no such section, which
    // only the database knows; a question naming a dozen things is not
    // asking about three.
    const slugs = pinCandidates(intent, question, rewrites, titles)
      .slice(0, MAX_PINNED_PAGES * 4)
      .map((title) => title.slug);
    const sections = await fetchPinnedSections(db, slugs, intent.kind);
    return sections.slice(0, MAX_PINNED_PAGES).flatMap((rows, i) => pinnedExcerpts(rows, intent.kind, i + 1));
  } catch (error) {
    logWarn('retrieve', 'could not pin the section the question asks for: answering from ranking alone', {
      error: describeError(error).message,
      intent: intent.kind,
    });
    return [];
  }
}

/**
 * Hybrid retrieval: dense vectors and full-text, fused with RRF.
 *
 * Neither retriever is sufficient alone here. Vector search generalises across
 * languages and paraphrase, which is what makes a Spanish question find English
 * wiki text, but it blurs rare proper nouns — the exact tokens Valheim
 * questions are full of. Full-text nails those and is useless for paraphrase.
 *
 * Two steps then shape what ranking chose. A question that asks what a thing
 * is for or where it is gets that thing's section first, whatever the queries
 * said (`intent.ts`); and a chunk that is one part of a small section brings
 * the rest of it (`stitch.ts`).
 */
export async function retrieve(db: Db, options: RetrieveOptions): Promise<ScoredChunk[]> {
  const {
    queries,
    question,
    rewritten = false,
    candidatesPerRetriever = 20,
    topK = 8,
    maxContextTokens = 6000,
    embedFn,
  } = options;

  const cleaned = expandQueries(queries);
  if (cleaned.length === 0) return [];

  /*
   * Started before the ranking queries and awaited after them: it needs only
   * the question, the cached title index and one indexed query, and on Neon
   * a round trip made after the others would add its whole latency.
   */
  const pinning = question
    ? pinnedFor(db, question, rewritten ? queries : [], options.linker ?? titleLinker(() => getSearchIndex(db)))
    : Promise.resolve([]);

  /*
   * Every query at once. Each is an independent statement, and against Neon
   * each round trip is ~180 ms: one after another, three queries and their
   * glossary variants took 1.1–2.5 s before the model was even asked; side by
   * side, under one. The embeddings come first, in one forward pass for the
   * local model.
   */
  const vectors = embedFn ? await Promise.all(cleaned.map((q) => embedFn(q))) : await embedQueries(cleaned);
  const results = await Promise.all(
    cleaned.map((query, i) =>
      candidatesFor(db, toVectorLiteral(vectors[i] ?? []), buildTsQuery(query), candidatesPerRetriever),
    ),
  );

  const lists: RankedList<RetrievedChunk>[] = [];
  results.forEach((rows, i) => {
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
  });

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
  // prose section. Pinned excerpts come first and count against both; what
  // they hold is not ranked in a second time.
  const selected: ScoredChunk[] = [];
  let budget = maxContextTokens;
  const admit = (chunk: ScoredChunk): void => {
    if (selected.length >= topK) return;
    const cost = contextTokens(chunk.content);
    if (cost > budget && selected.length > 0) return;
    budget -= cost;
    selected.push(chunk);
  };
  for (const chunk of await pinning) admit(chunk);
  const pinnedIds = new Set(selected.flatMap((chunk) => chunk.ids ?? [chunk.id]));
  for (const entry of fused.slice(0, topK * 2)) {
    if (selected.length >= topK) break;
    if (pinnedIds.has(entry.item.id)) continue;
    admit({ ...entry.item, score: entry.score, ranks: entry.ranks });
  }
  return stitchSections(db, selected, { maxContextTokens, keep: pinnedIds });
}
