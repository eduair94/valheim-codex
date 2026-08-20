import './_env';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createDb } from '../src/lib/db/create-db';
import { retrieve } from '../src/lib/rag/retrieve';
import { rewriteQueries } from '../src/lib/rag/rewrite';
import { countChunks } from '../src/lib/db/repo';

/**
 * Retrieval eval: recall@k over a hand-written golden set.
 *
 * Without this, any change to chunking, the tsquery builder or the fusion
 * constants is a guess. The metric is deliberately recall of the *article*, not
 * of an exact chunk: which chunk of "Iron Sword" answers a recipe question is
 * an implementation detail, whether the article was retrieved at all is not.
 */

const { values } = parseArgs({
  options: {
    k: { type: 'string', default: '5' },
    'no-rewrite': { type: 'boolean', default: false },
    'pace-ms': { type: 'string', default: '3200' },
    verbose: { type: 'boolean', default: false },
    file: { type: 'string', default: 'tests/eval/golden.jsonl' },
  },
});

type GoldenCase = { q: string; lang: 'es' | 'en'; expect: string[] };

const k = Number(values.k);
const raw = await readFile(values.file!, 'utf8');
const cases: GoldenCase[] = raw
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l) as GoldenCase);

const handle = await createDb({
  databaseUrl: process.env.DATABASE_URL || undefined,
  pgliteDataDir: process.env.DATABASE_URL ? undefined : process.env.PGLITE_DATA_DIR || '.data/pglite',
});

const total = await countChunks(handle.db);
if (total === 0) {
  console.error('The index is empty. Run `pnpm ingest` first.');
  await handle.close();
  process.exit(1);
}

console.log(`index: ${total} chunks | cases: ${cases.length} | k=${k}${values['no-rewrite'] ? ' | rewrite off' : ''}\n`);

const norm = (s: string): string => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();

/**
 * Gemini's free tier allows 20 generate_content requests per minute. Firing 30
 * rewrites back to back exhausts it a third of the way through, and the rest
 * silently fall back to the raw question — which measures the fallback path,
 * not the system. Pacing keeps the number meaningful.
 */
const paceMs = Number(values['pace-ms']);
const pace = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let hits = 0;
let mrrSum = 0;
const misses: { q: string; expect: string[]; got: string[] }[] = [];
const startedAt = Date.now();

for (const [i, testCase] of cases.entries()) {
  if (i > 0 && !values['no-rewrite'] && paceMs > 0) await pace(paceMs);

  const queries = values['no-rewrite']
    ? [testCase.q]
    : await rewriteQueries({ question: testCase.q });

  const results = await retrieve(handle.db, { queries, topK: k });
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
MRR         ${mrr.toFixed(3)}
elapsed     ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

if (misses.length > 0) {
  console.log('\nmisses:');
  for (const m of misses) {
    console.log(`  "${m.q}"`);
    console.log(`    wanted: ${m.expect.join(' | ')}`);
    console.log(`    got:    ${m.got.join(', ') || '(nothing)'}`);
  }
}

await handle.close();

// A regression below this line is a real quality drop, so CI should notice.
const FLOOR = 0.8;
if (recall < FLOOR) {
  console.error(`\nrecall@${k} below the ${FLOOR * 100}% floor.`);
  process.exit(1);
}
