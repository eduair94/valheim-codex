import './_env';
import { parseArgs } from 'node:util';
import { createDb } from '../src/lib/db/create-db';
import { runMigrations } from '../src/lib/db/migrate';
import { runIngest, type ProgressEvent } from '../src/lib/ingest/run';
import { MediaWikiClient } from '../src/lib/wiki/mediawiki';
import { SOURCES } from '../src/lib/wiki/sources';
import { countChunks } from '../src/lib/db/repo';

const { values } = parseArgs({
  options: {
    full: { type: 'boolean', default: false },
    reembed: { type: 'boolean', default: false },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
    source: { type: 'string' },
    trigger: { type: 'string', default: 'cli' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`
Usage: pnpm ingest [options]

  --full             Re-parse every page instead of only changed revisions
  --reembed          Discard stored vectors and recompute them all
  --limit <n>        Stop after n changed pages (smoke test; skips pruning)
  --concurrency <n>  Parallel page fetches (default 3)
  --source <id>      Ingest only this source (default: all)
  --trigger <name>   Label recorded on the ingest_runs row
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

const handle = await createDb({
  databaseUrl: process.env.DATABASE_URL || undefined,
  pgliteDataDir: process.env.DATABASE_URL ? undefined : process.env.PGLITE_DATA_DIR || '.data/pglite',
});
console.log(`driver:    ${handle.driver}`);
await runMigrations(handle);

const { getEmbeddingProvider } = await import('../src/lib/rag/embed');
const embeddingProvider = getEmbeddingProvider();
console.log(`embedding: ${embeddingProvider.label}`);

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
    case 'planned':
      console.log(`[${event.source}] ${event.changed} to (re)index`);
      break;
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
    reembed: values.reembed,
    limit: values.limit ? Number(values.limit) : undefined,
    concurrency: Number(values.concurrency),
    trigger: values.trigger,
    onProgress,
  });

  const total = await countChunks(handle.db);
  console.log(`
run             ${result.runId}
pages seen      ${result.pagesSeen}
pages indexed   ${result.pagesChanged}
chunks written  ${result.chunksWritten}
embeddings      ${result.embeddingsComputed}
errors          ${result.errors.length}
chunks in db    ${total}
elapsed         ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  if (result.errors.length > 0) {
    console.log('\nfailed pages:');
    for (const e of result.errors.slice(0, 20)) console.log(`  ${e.title}: ${e.message}`);
    if (result.errors.length > 20) console.log(`  ... and ${result.errors.length - 20} more`);
  }
} finally {
  await handle.close();
}
