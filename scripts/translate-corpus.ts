import './_env';
import { applyMemory, captionsOf, deriveMemory } from '../src/lib/wiki/translate';
import {
  acquireLease,
  ensureMemoryTable,
  listTranslationsWithoutMemory,
  loadTranslationJob,
  releaseLease,
  rewriteTranslation,
  saveTranslationWork,
} from '../src/lib/wiki/translate-store';
import { COMMON_FLAGS, openDatabase, PACE_FLAGS, parseArgs, QUEUE_FLAGS, runPace, scriptHolder } from './translate-cli';
import { translateQueue } from './translate-queue';

/**
 * Translates the corpus a bit at a time, and picks up where it left off.
 *
 *   pnpm translate:es                         # until the budget runs out
 *   pnpm translate:es --dry-run               # what it would send, and how much
 *   pnpm translate:es --priority              # biomes, bosses, stations, first creatures, hubs
 *   pnpm translate:es --slugs meadows,forge   # just these, in this order
 *   pnpm translate:es --limit 20              # at most twenty articles
 *   pnpm translate:es --max-strings 600       # leave longer articles for later
 *   pnpm translate:es --rebuild               # no model: recover memories, merge doubled headings
 *
 * Also: --lang (es), --order smallest|largest (smallest), --tpm (tokens a
 * minute, 4,000; 0 for no budget), --rpm (requests a minute; none by
 * default), --batch (strings per request, 40), --chunk (strings between
 * saves: a round of requests, --batch times --concurrency; 0 for one save
 * per article), --concurrency (requests at once, 1), and which database:
 * --pglite <dir> for a local copy, --neon to confirm writing to DATABASE_URL
 * when it comes from .env.local (scripts/_db.ts). The defaults, and the
 * measurements behind them, are in translate-cli.ts (`runPace`).
 *
 * The free tiers this runs on are measured in tokens per day — Groq allows
 * 200,000, roughly fifty ordinary articles — so translating a thousand
 * articles is not one job, it is a job run repeatedly over a couple of weeks.
 * That makes resumability the whole design. Work is committed after every
 * round of requests into the article's translation memory, so a run that
 * dies, or a budget that runs out a third of the way into a 3,000-string
 * reference page, costs only the requests in flight, and the next run
 * continues from that string rather than from the top of the article.
 *
 * Smallest first by default. Largest first spent its first two hundred
 * requests on four reference dumps (Version history, Point of interest, Item
 * IDs, Aggressive creature strategies) while the pages readers open first —
 * the biomes, the bosses, the workbench — waited days. --priority does those
 * by name, in that order. Within an article the skeleton goes first: title,
 * lead, headings and labels, then the text from the top.
 *
 * Rate-aware three times over. Requests are paced by the tokens they use,
 * across the whole run: --tpm a minute, half of Groq's 8,000 by default,
 * because the site's chat answers on the same key and keeps the other half.
 * A provider that refuses anyway and says when it will answer ("Please try
 * again in 12.8s") is waited for, not skipped for providers that cannot
 * answer at all. And a request no provider answered is asked again, a minute
 * later, before it counts against the run.
 *
 * The pace bounds the average, not one batch. In the default order every
 * batch leaves a reader's question room; a --priority run's long prose
 * batches fill most of Groq's minute for some seconds each, and a question
 * that arrives just then finds no room in time, about one moment in twenty
 * (translate-cli.ts, `TOKENS_PER_MINUTE`).
 *
 * The day is the chat's too. A run left to itself spends Groq's 200,000
 * tokens, and until they age out of Groq's rolling day, readers' questions
 * find it refusing, with (as of October 2026) no other provider funded behind
 * it. So run it when the chat is quiet, and bound it (--limit, --slugs) on a
 * day the chat matters. Each article's line, and the summary, say how many
 * tokens went.
 *
 * The run stops when the free tier runs out: at the first request every
 * provider refuses for the day, out of credit or out of a daily quota, since
 * a hundred more refusals only make the log harder to read. Everything
 * translated before that point is saved. It also stops when two articles in a
 * row end with no answer, two requests in a row unanswered with at least a
 * minute's wait before the second (an outage, or rate limits that outlast
 * every wait: nothing is held against their strings), and when three in a
 * row are sent new strings and get nothing usable back (a provider problem).
 * An article with only old failures left counts as neither: those are
 * expected to fail again, and the queue puts such articles last.
 *
 * Safe to run while the site is up. Each article is taken under its lease
 * first, the same one the reader's endpoint takes, so the two never pay for
 * the same strings or save over each other; an article a reader is having
 * translated right now is waited for, briefly. Strings that came back
 * unusable are counted against themselves, which is what lets the endpoint
 * stop paying for them; this script still tries every one, once per run.
 *
 * A translation is shown once at least half of its article is translated —
 * `isPublishable`, the rule the reader's endpoint uses too. Below that the
 * progress stays in the memory, and the article is shown when it crosses the
 * line on a later run.
 *
 * --rebuild calls no model. For translations stored before memories were
 * kept, it recovers the memory from the stored text, so the next re-index
 * re-translates only what changed (run it before a full re-ingest), and
 * rewrites the translation from it, which merges headings that were
 * translated two different ways. It also finds what those translations never
 * covered — image captions, mostly — which `pnpm translate:es --max-strings 20`
 * then fills in with a request or so per article.
 *
 * Writes go straight to the database. The site's cached pages catch up on
 * their own revalidation; there is no request here to expire them with.
 */

const USAGE =
  'pnpm translate:es [--dry-run] [--priority | --slugs a,b] [--limit N] [--max-strings N]\n' +
  '                  [--order smallest|largest] [--tpm N] [--rpm N] [--batch N] [--chunk N] [--concurrency N]\n' +
  '                  [--lang es] [--rebuild] [--pglite <dir> | --neon]';

const args = parseArgs(
  process.argv.slice(2),
  {
    ...COMMON_FLAGS,
    ...QUEUE_FLAGS,
    ...PACE_FLAGS,
    'dry-run': { type: 'boolean' },
    rebuild: { type: 'boolean' },
  },
  USAGE,
);

if (args.has('help')) {
  console.log(USAGE);
  process.exit(0);
}

const lang = args.flag('lang') ?? 'es';
const limit = args.count('limit', 0) || Number.POSITIVE_INFINITY;
const maxStrings = args.count('max-strings', 0) || Number.POSITIVE_INFINITY;
const pace = runPace(args);
const order = args.order();
const slugs = args.slugs();
const dryRun = args.has('dry-run');

const handle = await openDatabase(args, { writes: !dryRun });

try {
  if (args.has('rebuild')) await rebuild();
  else {
    await translateQueue(handle.db, {
      lang,
      limit,
      maxStrings,
      ...pace,
      order,
      slugs,
      dryRun,
    });
  }
} finally {
  await handle.close();
}

/**
 * Recovers the memory of every translation stored without one, and rewrites
 * the translation from it where that changes the text (a heading or a cell
 * that was translated two different ways now reads one way everywhere).
 */
async function rebuild(): Promise<void> {
  // The owner credential runs this, so the table can be created up front
  // rather than on the first write.
  if (!dryRun) await ensureMemoryTable(handle.db);
  const pending = await listTranslationsWithoutMemory(handle.db, lang);
  console.log(
    `${pending.length} traducciones en "${lang}" sin memoria.` +
      (dryRun ? ' Simulación: no se escribe nada.' : ''),
  );

  let remembered = 0;
  let rewritten = 0;
  let gaps = 0;
  let missing = 0;
  const busy: string[] = [];

  for (const slug of pending) {
    const job = await loadTranslationJob(handle.db, slug, lang);
    if (!job?.published || job.published.stale) continue;

    const memory = deriveMemory(
      { doc: job.doc, title: job.title },
      { doc: job.published.doc, title: job.published.title },
    );
    const applied = applyMemory(job.doc, job.title, memory);
    const changed =
      applied.title !== job.published.title ||
      JSON.stringify([applied.doc.lead, applied.doc.blocks, applied.doc.infobox]) !==
        JSON.stringify([job.published.doc.lead, job.published.doc.blocks, job.published.doc.infobox]);

    remembered += 1;
    if (changed) rewritten += 1;
    if (applied.pending > 0) {
      gaps += 1;
      missing += applied.pending;
    }
    if (changed || applied.pending > 0) {
      console.log(
        `  ${slug.padEnd(34)} ${changed ? 'reescrito' : 'igual'}` +
          (applied.pending > 0 ? `, ${applied.pending} cadenas sin traducción` : ''),
      );
    }
    if (dryRun) continue;

    // No waiting here: an article someone is translating right now will have
    // a memory of its own when they are done.
    const lease = await acquireLease(handle.db, { pageKey: job.pageKey, lang, holder: scriptHolder });
    if (lease.kind !== 'acquired') {
      busy.push(slug);
      continue;
    }
    if (lease.memory.size > 0) {
      await releaseLease(handle.db, { pageKey: job.pageKey, lang, holder: lease.holder });
      continue;
    }
    const saved = await saveTranslationWork(handle.db, {
      pageKey: job.pageKey,
      lang,
      lease: lease.holder,
      release: true,
      memory: applied.memory,
      failures: new Map(),
      pending: applied.pending,
      publish: null,
    });
    if (changed && saved.memory === 'stored') {
      await rewriteTranslation(handle.db, {
        pageKey: job.pageKey,
        lang,
        title: applied.title,
        doc: applied.doc,
        captions: captionsOf(applied.doc, job.doc),
      });
    }
  }

  console.log(
    `\n${remembered} memorias recuperadas, ${rewritten} traducciones reescritas, ` +
      `${gaps} con cadenas por completar (${missing} en total; las toma \`pnpm translate:es --max-strings 20\`).`,
  );
  if (busy.length > 0) console.log(`En uso por el sitio, sin tocar: ${busy.join(', ')}.`);
}
