import './_env';
import { parseArgs } from 'node:util';
import { runMigrations } from '../src/lib/db/migrate';
import { openScriptDatabase } from './_db';
import { IngestConfigError, runIngest, type ProgressEvent } from '../src/lib/ingest/run';
import { PARSER_VERSION } from '../src/lib/ingest/version';
import { MediaWikiClient } from '../src/lib/wiki/mediawiki';
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
  --limit <n>             Stop after n changed pages (smoke test; skips pruning)
  --concurrency <n>       Parallel page fetches (default 3)
  --source <id>           Ingest only this source (default: all)
  --trigger <name>        Label recorded on the ingest_runs row
  --pglite <dir>          Work on this local copy, whatever DATABASE_URL says
  --neon                  Write to DATABASE_URL when it comes from .env.local or
                          .env rather than the environment (scripts/_db.ts)
`);
  process.exit(0);
}

// The local embedding provider needs no key; the Gemini one does.
if (process.env.EMBEDDING_PROVIDER !== 'local' && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
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

const { getEmbeddingProvider } = await import('../src/lib/rag/embed');
const embeddingProvider = getEmbeddingProvider();
console.log(`embedding: ${embeddingProvider.label}`);
console.log(`parser:    v${PARSER_VERSION}`);

const client = new MediaWikiClient({
  contact: process.env.WIKI_CONTACT ?? 'anonymous@example.com',
});

const sources = values.source ? SOURCES.filter((s) => s.id === values.source) : SOURCES;
if (sources.length === 0) {
  console.error(`Unknown source "${values.source}". Known: ${SOURCES.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

let lastLine = 0;
const onProgress = (event: ProgressEvent): void => {
  switch (event.type) {
    case 'listed':
      console.log(`[${event.source}] ${event.pages} articles listed`);
      break;
    case 'planned': {
      const why = Object.entries(event.reasons)
        .filter(([, n]) => n > 0)
        .map(([reason, n]) => `${n} ${reason}`)
        .join(', ');
      console.log(`[${event.source}] ${event.changed} to (re)index${why ? ` (${why})` : ''}`);
      if (event.outdated > 0) {
        console.log(
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
        process.stdout.write(
          `\r  ${String(pct).padStart(3)}%  ${event.index}/${event.total}  ${event.title.slice(0, 44).padEnd(44)}`,
        );
      }
      break;
    }
    case 'error':
      process.stdout.write('\n');
      console.warn(`  ! ${event.title}: ${event.message}`);
      break;
    case 'reembed':
      console.log(`re-embedding every chunk: ${event.reason}`);
      break;
    case 'vectors':
      process.stdout.write(`\r  vectors  ${event.embedded}/${event.total} chunks that had none`);
      if (event.embedded >= event.total) process.stdout.write('\n');
      break;
    case 'done':
      process.stdout.write('\n');
      break;
  }
};

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
    limit: values.limit ? Number(values.limit) : undefined,
    concurrency: Number(values.concurrency),
    trigger: values.trigger,
    onProgress,
  });

  const total = await countChunks(handle.db);
  console.log(`
run              ${result.runId}
pages seen       ${result.pagesSeen}
pages indexed    ${result.pagesChanged}
articles changed ${result.articlesChanged}  (their translations are now stale)
older parser     ${result.outdatedPages}${result.outdatedPages > 0 ? '  (pnpm ingest --reparse rebuilds them)' : ''}
chunks written   ${result.chunksWritten}
embeddings       ${result.embeddingsComputed}
errors           ${result.errors.length}
chunks in db     ${total}
elapsed          ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  if (result.errors.length > 0) {
    console.log('\nfailed pages:');
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
