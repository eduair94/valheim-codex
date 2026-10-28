import './_env';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { rawQuery } from '../src/lib/db/create-db';
import { countChunks, EMBEDDING_PROVIDER_KEY, getSetting } from '../src/lib/db/repo';
import { getSearchIndex } from '../src/lib/db/wiki-repo';
import { getEmbeddingProvider } from '../src/lib/rag/embed';
import { detectIntent, titleLinker } from '../src/lib/rag/intent';
import { planQueries, REWRITE_MODE, REWRITE_MODES, type RewriteMode } from '../src/lib/rag/plan';
import { retrieve } from '../src/lib/rag/retrieve';
import { deterministicQueries, rewriteQueries } from '../src/lib/rag/rewrite';
import { contextTokens } from '../src/lib/rag/stitch';
import { openScriptDatabase } from './_db';

/**
 * Retrieval eval: recall@k over a hand-written golden set.
 *
 * Without this, any change to chunking, the tsquery builder or the fusion
 * constants is a guess. The metric is deliberately recall of the *article*, not
 * of an exact chunk: which chunk of "Iron Sword" answers a recipe question is
 * an implementation detail, whether the article was retrieved at all is not.
 *
 * Except when the chunk is the answer. Asked what tin is for, the Tin article
 * was always retrieved — its Crafting list, without the Building list that
 * names the Cauldron — and article recall said all was well. `--sections
 * <file>` scores that instead: each case names the sections its answer needs,
 * by title and section path, and the eval counts how many of their chunks the
 * context holds (tests/eval/sections.jsonl). Its queries are fixed, so no
 * model is asked: it measures retrieval alone, and costs nothing to run.
 *
 * `--rewrite` chooses where the golden set's queries come from, as the chat's
 * CHAT_REWRITE does (`plan.ts`), and defaults to what the chat does:
 *   - `off`    the question as asked, plus its glossary English: no API key,
 *              no quota (`--no-rewrite` is the same);
 *   - `auto`   a model rewrite only for questions the chat would rewrite;
 *   - `always` a model rewrite for every question.
 */

const argv = process.argv.slice(2);
const { values } = parseArgs({
  // pnpm 9 passes a literal `--` on: `pnpm eval -- --no-rewrite`.
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    k: { type: 'string', default: '5' },
    rewrite: { type: 'string' },
    'no-rewrite': { type: 'boolean', default: false },
    'pace-ms': { type: 'string', default: '3200' },
    verbose: { type: 'boolean', default: false },
    file: { type: 'string', default: 'tests/eval/golden.jsonl' },
    sections: { type: 'string' },
    pglite: { type: 'string' },
    neon: { type: 'boolean', default: false },
  },
});

/** `lang` is the language the question is asked in, for the record: retrieval never reads it. */
type GoldenCase = { q: string; lang: string; expect: string[] };

/**
 * A section an answer needs: the chunks under `section` on the article
 * `title` — the section's own and its subsections', so a Usage section split
 * by a later parse is still the whole of it. The empty section is the lead
 * alone. `answers` marks the sections any one of which makes the question
 * answerable at all.
 */
type SectionTarget = { title: string; section: string; kind?: string; answers?: boolean };

/**
 * A question, the queries it is retrieved with — named variants, each a
 * rewrite a model wrote or could have, plus the Puter reader's
 * (`deterministicQueries`) — and the sections its answer needs. With no
 * target marked `answers`, every target counts towards coverage; with some,
 * the case is scored on being answerable.
 */
type SectionCase = { id: string; q: string; lang: string; variants: Record<string, string[]>; targets: SectionTarget[] };

function parseMode(): RewriteMode {
  const raw = values.rewrite?.trim().toLowerCase();
  if (values['no-rewrite']) {
    if (raw && raw !== 'off') {
      console.error(`--no-rewrite is --rewrite off; it cannot be combined with --rewrite ${raw}.`);
      process.exit(1);
    }
    return 'off';
  }
  if (raw === undefined) return REWRITE_MODE;
  const mode = REWRITE_MODES.find((m) => m === raw);
  if (!mode) {
    console.error(`--rewrite is one of ${REWRITE_MODES.join(', ')}, not "${values.rewrite}".`);
    process.exit(1);
  }
  return mode;
}

function parseLines<T>(raw: string): T[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

const k = Number(values.k);
const mode = parseMode();
const sectionsFile = values.sections;
const raw = await readFile(sectionsFile ?? values.file!, 'utf8');

// Only reads, so a DATABASE_URL from .env.local needs no --neon (scripts/_db.ts).
const handle = await openScriptDatabase(
  { pglite: values.pglite, neon: values.neon },
  { writes: false, lang: 'en', announce: (where) => console.log(`database: ${where}`) },
);

const total = await countChunks(handle.db);
if (total === 0) {
  console.error('The index is empty. Run `pnpm ingest` first.');
  await handle.close();
  process.exit(1);
}

/*
 * Questions are embedded with the configured provider and compared with the
 * stored vectors. Against an index another model built, that comparison is
 * noise, and the recall it reports measures nothing — the scheduled workflow
 * ran exactly that way while EMBEDDING_PROVIDER was unset there.
 */
const indexProvider = await getSetting(handle.db, EMBEDDING_PROVIDER_KEY);
const queryProvider = getEmbeddingProvider().id;
if (indexProvider && indexProvider !== queryProvider) {
  console.error(
    `The index was embedded with "${indexProvider}" but EMBEDDING_PROVIDER is "${queryProvider}". ` +
      `Set EMBEDDING_PROVIDER=${indexProvider} to measure it.`,
  );
  await handle.close();
  process.exit(1);
}

// The title index the chat links names through, read once for the whole run.
const linker = titleLinker(() => getSearchIndex(handle.db));
const startedAt = Date.now();

/* -------------------------------------------------------------------------- */
/* --sections: the chunks an answer needs                                      */
/* -------------------------------------------------------------------------- */

/**
 * Below this share of target chunks in context the sections eval fails, and
 * so does any run of a question it marks answerable that is not.
 *
 * It is the level stitching and pinning reached, 52 of 54 (96.3%), because
 * the eval exists to catch them breaking. Before either, the lab's cases
 * scored 43 of 54 and 5 of 6; with the uses pin broken alone, 49 of 54 and
 * still 6 of 6, which a 90% floor let pass. A reparse that splits sections
 * differently changes the count of target chunks, so measure again after one
 * before reading a failure here as a regression.
 */
const SECTIONS_FLOOR = 0.96;

/** The chunks a target names, in document order; none when the index has no such section. */
async function chunksOf(target: SectionTarget): Promise<string[]> {
  const below = target.section ? sql`OR starts_with(section_path, ${`${target.section} > `})` : sql``;
  const kind = target.kind ? sql`AND kind = ${target.kind}` : sql``;
  const rows = await rawQuery<{ id: string }>(
    handle.db,
    sql`SELECT id FROM chunks
        WHERE lower(title) = lower(${target.title})
          AND (section_path = ${target.section} ${below})
          ${kind}
        ORDER BY split_part(id, ':', 4)::int`,
  );
  return rows.map((row) => row.id);
}

const label = (target: SectionTarget): string =>
  [target.title, ...(target.section ? target.section.split(' > ') : [target.kind === 'infobox' ? '(infobox)' : '(lead)'])].join(' › ');

async function runSections(cases: SectionCase[]): Promise<boolean> {
  console.log(
    `index: ${total} chunks (${queryProvider}) | cases: ${cases.length} | sections, top 8, fixed queries: no model calls\n`,
  );

  let got = 0;
  let wanted = 0;
  let complete = 0;
  let coverageRuns = 0;
  let answerable = 0;
  let answerableRuns = 0;
  let tokens = 0;
  let runs = 0;

  for (const testCase of cases) {
    const targets = await Promise.all(testCase.targets.map(async (target) => ({ target, ids: await chunksOf(target) })));
    for (const { target, ids } of targets) {
      if (ids.length === 0) console.log(`  ${testCase.id}: no chunk is "${label(target)}" any more; it counts as missing`);
    }
    const scoredOnAnswers = targets.some(({ target }) => target.answers);
    const intent = detectIntent(testCase.q);

    const variants: [string, string[]][] = [...Object.entries(testCase.variants), ['puter', deterministicQueries(testCase.q)]];
    for (const [variant, queries] of variants) {
      // A named variant stands for a model's rewrite; the Puter reader's are the question's own.
      const rewritten = variant !== 'puter';
      const results = await retrieve(handle.db, { queries, rewritten, question: testCase.q, linker });
      const held = new Set(results.flatMap((r) => r.ids ?? [r.id]));
      const context = results.reduce((sum, r) => sum + contextTokens(r.content), 0);
      tokens += context;
      runs += 1;

      // A target with no chunk left in the index is one missing chunk, not zero wanted.
      const counts = targets.map(({ target, ids }) => ({
        target,
        wanted: Math.max(1, ids.length),
        got: ids.filter((id) => held.has(id)).length,
      }));
      const runWanted = counts.reduce((sum, c) => sum + c.wanted, 0);
      const runGot = counts.reduce((sum, c) => sum + c.got, 0);
      const missing = counts.filter((c) => c.got < c.wanted);

      let verdict = '';
      if (scoredOnAnswers) {
        const ok = targets.some(({ target, ids }) => target.answers && ids.some((id) => held.has(id)));
        answerableRuns += 1;
        if (ok) answerable += 1;
        verdict = ok ? ' answerable' : ' NOT ANSWERABLE';
      } else {
        got += runGot;
        wanted += runWanted;
        coverageRuns += 1;
        if (runGot === runWanted) complete += 1;
      }

      const pinned = [...new Set(results.filter((r) => 'pinned' in r.ranks).map((r) => r.title))];
      const pins = intent ? ` [${intent.kind}: ${pinned.join(', ') || 'nothing linked'}]` : '';
      const mark = verdict === ' NOT ANSWERABLE' || (!scoredOnAnswers && runGot < runWanted) ? '✗' : '✓';
      console.log(`${mark} ${`${testCase.id}/${variant}`.padEnd(14)} ${runGot}/${runWanted}${verdict} ~${context} tok${pins}`);
      if (values.verbose || mark === '✗') {
        for (const c of missing) {
          console.log(`      missing: ${label(c.target)}${c.got > 0 ? ` (${c.wanted - c.got} of its ${c.wanted} chunks)` : ''}`);
        }
      }
    }
  }

  const coverage = wanted > 0 ? got / wanted : 1;
  console.log(`
targets     ${(coverage * 100).toFixed(1)}%  (${got}/${wanted}), every target in ${complete}/${coverageRuns} runs
answerable  ${answerable}/${answerableRuns}
context     ~${runs > 0 ? Math.round(tokens / runs) : 0} tokens on average
elapsed     ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  let passed = true;
  if (coverage < SECTIONS_FLOOR) {
    console.error(`\ntarget coverage below the ${SECTIONS_FLOOR * 100}% floor.`);
    passed = false;
  }
  if (answerable < answerableRuns) {
    console.error(`\n${answerableRuns - answerable} run(s) of an answerable question left every answer out.`);
    passed = false;
  }
  return passed;
}

/* -------------------------------------------------------------------------- */
/* Golden set: recall of the article                                           */
/* -------------------------------------------------------------------------- */

const norm = (s: string): string => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();

/**
 * Gemini's free tier refuses in bursts: a few requests a minute, twenty a
 * day. Firing the rewrites back to back exhausts it a third of the way
 * through, and the rest silently fall back to the raw question — which
 * measures the fallback path, not the system. Pacing the rewrites (not the
 * questions searched as asked, which call nothing) keeps the number meaningful.
 */
const paceMs = Number(values['pace-ms']);
const pace = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let lastRewriteAt = 0;
async function pacedRewrite(question: string): Promise<string[]> {
  const wait = lastRewriteAt + paceMs - Date.now();
  if (wait > 0) await pace(wait);
  lastRewriteAt = Date.now();
  return rewriteQueries({ question });
}

async function runGolden(cases: GoldenCase[]): Promise<boolean> {
  console.log(`index: ${total} chunks (${queryProvider}) | cases: ${cases.length} | k=${k} | rewrite ${mode}\n`);

  let hits = 0;
  let mrrSum = 0;
  let rewritten = 0;
  const misses: { q: string; expect: string[]; got: string[] }[] = [];

  for (const [i, testCase] of cases.entries()) {
    const plan = await planQueries({
      question: testCase.q,
      history: [],
      linker,
      mode,
      rewrite: () => pacedRewrite(testCase.q),
    });
    if (plan.rewritten) rewritten += 1;

    const results = await retrieve(handle.db, {
      queries: plan.queries,
      rewritten: plan.rewritten,
      question: testCase.q,
      linker,
      topK: k,
    });
    const titles = results.map((r) => r.title);
    const wanted = testCase.expect.map(norm);

    const rank = titles.findIndex((t) => wanted.includes(norm(t)));
    const hit = rank !== -1;
    if (hit) {
      hits += 1;
      mrrSum += 1 / (rank + 1);
    } else {
      misses.push({ q: testCase.q, expect: testCase.expect, got: [...new Set(titles)].slice(0, 5) });
    }

    const mark = hit ? '✓' : '✗';
    const line = `${mark} ${String(i + 1).padStart(2)} ${testCase.q.slice(0, 52).padEnd(52)}`;
    if (values.verbose || !hit) {
      console.log(`${line} → ${[...new Set(titles)].slice(0, 4).join(', ')}`);
    } else {
      console.log(line);
    }
  }

  const recall = hits / cases.length;
  const mrr = mrrSum / cases.length;

  console.log(`
recall@${k}   ${(recall * 100).toFixed(1)}%  (${hits}/${cases.length})
MRR         ${mrr.toFixed(3)}${mode === 'off' ? '' : `\nrewritten   ${rewritten}/${cases.length}`}
elapsed     ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  if (misses.length > 0) {
    console.log('\nmisses:');
    for (const m of misses) {
      console.log(`  "${m.q}"`);
      console.log(`    wanted: ${m.expect.join(' | ')}`);
      console.log(`    got:    ${m.got.join(', ') || '(nothing)'}`);
    }
  }

  // A regression below this line is a real quality drop, so CI should notice.
  const FLOOR = 0.8;
  if (recall < FLOOR) {
    console.error(`\nrecall@${k} below the ${FLOOR * 100}% floor.`);
    return false;
  }
  return true;
}

let passed: boolean;
try {
  passed = sectionsFile ? await runSections(parseLines<SectionCase>(raw)) : await runGolden(parseLines<GoldenCase>(raw));
} finally {
  await handle.close();
}
if (!passed) process.exit(1);
