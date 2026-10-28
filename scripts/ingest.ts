import './_env';
import { parseArgs } from 'node:util';
import { runMigrations } from '../src/lib/db/migrate';
import { openScriptDatabase } from './_db';
import type { BuiltGraph } from '../src/lib/craft/build';
import { getLatestRecipeGraph } from '../src/lib/db/recipe-repo';
import { IngestConfigError, RECIPE_GRAPH_ERROR, runIngest, type ProgressEvent } from '../src/lib/ingest/run';
import { PARSER_VERSION } from '../src/lib/ingest/version';
import { MediaWikiClient } from '../src/lib/wiki/mediawiki';
import { RECIPES_VERSION } from '../src/lib/wiki/recipes-version';
import { SOURCES } from '../src/lib/wiki/sources';
import { countChunks } from '../src/lib/db/repo';

const argv = process.argv.slice(2);
const { values } = parseArgs({
  // pnpm 9 passes a literal `--` on: `pnpm ingest -- --full`.
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    full: { type: 'boolean', default: false },
    reparse: { type: 'boolean', default: false },
    reembed: { type: 'boolean', default: false },
    'switch-provider': { type: 'string' },
    recipes: { type: 'boolean', default: false },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
    source: { type: 'string' },
    trigger: { type: 'string', default: 'cli' },
    pglite: { type: 'string' },
    neon: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`
Usage: pnpm ingest [options]

  --full                  Re-parse every page instead of only changed revisions
  --reparse               Also re-parse the pages an older parser built (the run
                          says how many there are). Articles whose text changes
                          leave their translations stale
  --reembed               Discard every stored vector and rebuild them all with
                          the provider that built the index
  --switch-provider <id>  Move the index to another embedding provider: every
                          vector is rebuilt with <id>, which EMBEDDING_PROVIDER
                          must name too. The app must then embed questions with
                          it as well. Without this, a provider other than the
                          one that built the index stops the run before anything
                          is written
  --recipes               Fetch every page whose recipes are missing or outdated
                          and rebuild the recipe graph, without touching articles
                          or their translations, and with no embedding provider.
                          It always assembles the graph again, so run it after
                          editing src/lib/craft/recipe-overrides.ts too. With
                          --full, every page's recipes are read again
  --limit <n>             Stop after fetching n pages, recipes included (smoke
                          test; skips pruning, and a page left without recipes
                          leaves the recipe graph as it was)
  --concurrency <n>       Parallel page fetches (default 3)
  --source <id>           Ingest only this source (default: all)
  --trigger <name>        Label recorded on the ingest_runs row
  --pglite <dir>          Work on this local copy, whatever DATABASE_URL says
  --neon                  Write to DATABASE_URL when it comes from .env.local or
                          .env rather than the environment (scripts/_db.ts)
`);
  process.exit(0);
}

// The local embedding provider needs no key; the Gemini one does. Reading
// recipes embeds nothing, and needs neither.
if (!values.recipes && process.env.EMBEDDING_PROVIDER !== 'local' && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  console.error(
    'Missing GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY).\n' +
      'Set EMBEDDING_PROVIDER=local to index without an API key. See .env.example.',
  );
  process.exit(1);
}

// Chosen and named before the first write, which is the migrations just below.
const handle = await openScriptDatabase(
  { pglite: values.pglite, neon: values.neon },
  { writes: true, lang: 'en', announce: (where) => console.log(`database:  ${where}`) },
);
await runMigrations(handle);

if (values.recipes) {
  console.log('embedding: none (--recipes leaves articles and vectors as they are)');
} else {
  const { getEmbeddingProvider } = await import('../src/lib/rag/embed');
  console.log(`embedding: ${getEmbeddingProvider().label}`);
}
console.log(`parser:    v${PARSER_VERSION}`);
console.log(`recipes:   v${RECIPES_VERSION}`);

const client = new MediaWikiClient({
  contact: process.env.WIKI_CONTACT ?? 'anonymous@example.com',
});

const sources = values.source ? SOURCES.filter((s) => s.id === values.source) : SOURCES;
if (sources.length === 0) {
  console.error(`Unknown source "${values.source}". Known: ${SOURCES.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

let lastLine = 0;
// A progress line is written over in place and ends with no newline, so
// whatever is printed after it starts a line of its own.
let midLine = false;
const progress = (text: string): void => {
  process.stdout.write(`\r${text}`);
  midLine = true;
};
const endLine = (): void => {
  if (midLine) process.stdout.write('\n');
  midLine = false;
};
const say = (text: string, warn = false): void => {
  endLine();
  if (warn) console.warn(text);
  else console.log(text);
};
/** "3 added, 1 revised": the reasons a plan counts, the empty ones left out. */
const counted = (reasons: Record<string, number>): string =>
  Object.entries(reasons)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${reason}`)
    .join(', ');
// Why the recipe graph was left as it was, when the run says so.
let graphSkipped: string | null = null;

const onProgress = (event: ProgressEvent): void => {
  switch (event.type) {
    case 'listed':
      say(`[${event.source}] ${event.pages} articles listed`);
      break;
    case 'planned': {
      const why = counted(event.reasons);
      say(`[${event.source}] ${event.changed} to (re)index${why ? ` (${why})` : ''}`);
      if (event.outdated > 0) {
        say(
          `[${event.source}] note: ${event.outdated} pages were built by an older parser and are left as they ` +
            `are; --reparse rebuilds them with v${PARSER_VERSION} (translations go stale where the text changes)`,
        );
      }
      break;
    }
    case 'page': {
      // Throttle so a 1000-page run does not produce 1000 lines.
      const now = Date.now();
      if (now - lastLine > 400 || event.index === event.total) {
        lastLine = now;
        const pct = Math.round((event.index / Math.max(1, event.total)) * 100);
        progress(`  ${String(pct).padStart(3)}%  ${event.index}/${event.total}  ${event.title.slice(0, 44).padEnd(44)}`);
      }
      break;
    }
    case 'recipes-planned': {
      const why = counted(event.reasons);
      say(`[${event.source}] ${event.pages} pages' recipes to read${why ? ` (${why})` : ''}`);
      break;
    }
    case 'recipes': {
      const now = Date.now();
      if (now - lastLine > 400 || event.index === event.total) {
        lastLine = now;
        progress(`  recipes  ${event.index}/${event.total}  ${event.title.slice(0, 44).padEnd(44)}`);
      }
      break;
    }
    case 'graph':
      say(`recipe graph assembled: ${event.graph.report.items} items, ${event.graph.report.recipes} recipes`);
      break;
    case 'graph-skipped':
      graphSkipped = event.reason;
      say(`  ! recipe graph not assembled: ${event.reason}`, true);
      break;
    case 'error':
      say(`  ! ${event.title}: ${event.message}`, true);
      break;
    case 'reembed':
      say(`re-embedding every chunk: ${event.reason}`);
      break;
    case 'vectors':
      progress(`  vectors  ${event.embedded}/${event.total} chunks that had none`);
      break;
    case 'done':
      endLine();
      break;
  }
};

/** A step's materials as the summary lists them, by id: "Iron 40, LinenThread 20". */
const materials = (inputs: [string, number][]): string => inputs.map(([id, qty]) => `${id} ${qty}`).join(', ');

/** One statement of a step in a cost conflict: its materials, the level it asks, and where. */
const statement = (s: { from: string; inputs: [string, number][]; stationLevel: number | null }): string =>
  `${materials(s.inputs)}${s.stationLevel === null ? '' : ` at level ${s.stationLevel}`} (${s.from})`;

/**
 * The recipe graph's part of the summary: its size, and what its report
 * found, each list with its first five: the names mentioned most that
 * resolved to nothing, the steps two statements cost differently, the
 * upgrades off the game's rule. Wiki errors behind any of it are settled in
 * src/lib/craft/recipe-overrides.ts.
 *
 * `served` is the version of the graph readers have, asked of the database
 * when this run assembled none: on the first run after the graph shipped,
 * there is none to serve yet, and the summary must not say otherwise.
 */
function graphSummary(
  { graph, errors }: { graph: BuiltGraph | null; errors: { title: string }[] },
  served: string | null,
): string {
  if (!graph) {
    const why = errors.some((e) => e.title === RECIPE_GRAPH_ERROR)
      ? 'its assembly failed (below)'
      : graphSkipped
        ? 'pages are without recipes (above)'
        : null;
    if (!why) return 'recipe graph     unchanged: no recipe changed';
    const readers = served
      ? `the stored one (${served.slice(0, 12)}) is still served`
      : 'no graph is stored yet, so crafting views have none';
    return `recipe graph     not assembled: ${why}; ${readers}`;
  }
  const { report } = graph;
  const mentions = report.unresolved.reduce((sum, u) => sum + u.count, 0);
  const lines = [
    `recipe graph     ${graph.version.slice(0, 12)}: ${report.items} items, ${report.recipes} recipes ` +
      `(${report.products} products, ${report.raw} raw materials)`,
    `  unresolved     ${report.unresolved.length} names, ${mentions} mentions`,
    ...report.unresolved.slice(0, 5).map((u) => `    ${u.text} x${u.count} (${u.from})`),
    `  cycles         ${report.cycles.length}`,
    `  level conflicts ${report.levelConflicts.length}`,
    `  not available  ${report.unavailable.length}  (steps at a station level the game does not have yet)`,
    `  duplicates     ${report.duplicates.length}  (a step stated on two pages; the item's own page kept, unless the rule says otherwise)`,
    `  cost conflicts ${report.costConflicts.length}  (a step two statements cost or level differently; the item's own infobox kept)`,
    ...report.costConflicts
      .slice(0, 5)
      .map((c) => `    ${c.product} q${c.quality}: ${c.statements.map(statement).join(' vs ')}`),
    `  overruled      ${report.overruled.length}  (statements off the game's rule beside one on it, which is kept)`,
    `  cost suspects  ${report.costSuspects.length}  (upgrades off the game's rule, left out until settled)`,
    ...report.costSuspects
      .slice(0, 5)
      .map((s) => `    ${s.product} q${s.quality} (${s.from}): ${materials(s.stated)}; the rule gives ${materials(s.linear)}`),
    `  yield suspects ${report.yieldSuspects.length}`,
    `  notes          ${report.notes.length}`,
  ];
  return lines.join('\n');
}

const startedAt = Date.now();
try {
  const result = await runIngest({
    db: handle.db,
    client,
    sources,
    full: values.full,
    reparse: values.reparse,
    reembed: values.reembed,
    switchProvider: values['switch-provider'],
    recipesOnly: values.recipes,
    limit: values.limit ? Number(values.limit) : undefined,
    concurrency: Number(values.concurrency),
    trigger: values.trigger,
    onProgress,
  });

  const elapsed = `elapsed          ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  const served = result.graph ? null : ((await getLatestRecipeGraph(handle.db))?.graph.version ?? null);
  if (values.recipes) {
    console.log(`
run              ${result.runId}
pages seen       ${result.pagesSeen}
recipes read     ${result.recipesExtracted}
${graphSummary(result, served)}
errors           ${result.errors.length}
${elapsed}`);
  } else {
    const total = await countChunks(handle.db);
    console.log(`
run              ${result.runId}
pages seen       ${result.pagesSeen}
pages indexed    ${result.pagesChanged}
articles changed ${result.articlesChanged}  (their translations are now stale)
older parser     ${result.outdatedPages}${result.outdatedPages > 0 ? '  (pnpm ingest --reparse rebuilds them)' : ''}
chunks written   ${result.chunksWritten}
embeddings       ${result.embeddingsComputed}
recipes read     ${result.recipesExtracted}
${graphSummary(result, served)}
errors           ${result.errors.length}
chunks in db     ${total}
${elapsed}`);
  }

  if (result.errors.length > 0) {
    console.log('\nfailed:');
    for (const e of result.errors.slice(0, 20)) console.log(`  ${e.title}: ${e.message}`);
    if (result.errors.length > 20) console.log(`  ... and ${result.errors.length - 20} more`);
  }
} catch (error) {
  // A configuration mistake, not a crash: say what to do, without a stack.
  if (error instanceof IngestConfigError) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await handle.close();
}
