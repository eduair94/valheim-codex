import './_env';
import { writeFileSync } from 'node:fs';
import { planArticle } from '../src/lib/wiki/translate';
import { listTranslationQueue, loadTranslationJob } from '../src/lib/wiki/translate-store';
import { COMMON_FLAGS, openDatabase, parseArgs, pickQueue, QUEUE_FLAGS } from './translate-cli';

/**
 * Dumps the strings still to translate as flat lists, for translating by hand
 * or by an agent rather than by an API key.
 *
 *   pnpm translate:export --limit 12 --out batch.json
 *   pnpm translate:export --priority --out batch.json
 *   pnpm translate:export --slugs version-history --chunk 300 --out batch.json
 *
 * Also: --lang (es), --order smallest|largest (smallest), --max-strings N
 * (skip articles with more pending strings than that), --pglite <dir> to read
 * a local copy (scripts/_db.ts).
 *
 * The provider chain is metered in tokens per day and the corpus is a thousand
 * articles, so the API path translates the site over weeks. Whoever is already
 * reading this repository can translate a batch directly and skip the queue.
 *
 * The format is the same list `translate.ts` builds for a model: no structure,
 * no numbers, no identifiers, each distinct string once. Nothing here can
 * reshape an article, because nothing here describes its shape.
 *
 * Only what is still missing goes out: strings the article's memory already
 * holds are left out, so a partial translation is completed rather than
 * redone. --chunk caps the strings per article, so a reference page of three
 * thousand strings can go out in pieces — export, translate, import, repeat;
 * each import is kept, and the page is shown once half of it is done.
 *
 * Strings the models keep failing on go out too, last in each article: a
 * person is how those get translated, and importing them clears their record.
 *
 * Smallest first, the opposite of what the API job used to do. This is done
 * in batches by someone waiting for it, and short articles mean more articles
 * finished per batch. --priority puts the pages readers open first ahead of
 * everything, by name.
 */

const USAGE =
  'pnpm translate:export [--out file] [--limit N] [--priority | --slugs a,b] [--chunk N]\n' +
  '                      [--max-strings N] [--order smallest|largest] [--lang es] [--pglite <dir> | --neon]';

const args = parseArgs(
  process.argv.slice(2),
  { ...COMMON_FLAGS, ...QUEUE_FLAGS, out: { type: 'string' }, chunk: { type: 'string' } },
  USAGE,
);

if (args.has('help')) {
  console.log(USAGE);
  process.exit(0);
}

const lang = args.flag('lang') ?? 'es';
const limit = args.count('limit', 10) || Number.POSITIVE_INFINITY;
const out = args.flag('out') ?? 'translate-batch.json';
const maxStrings = args.count('max-strings', 0) || Number.POSITIVE_INFINITY;
const chunk = args.count('chunk', 0) || Number.POSITIVE_INFINITY;
const order = args.order();
const slugs = args.slugs();

// Reads the database and writes only the batch file.
const handle = await openDatabase(args, { writes: false });

try {
  const queue = await listTranslationQueue(handle.db, lang, order);
  const { entries, idle } = pickQueue(queue, slugs);
  for (const slug of idle) console.log(`  ${slug.padEnd(34)} nada pendiente (al día, o no existe)`);

  const batch: { slug: string; title: string; strings: string[] }[] = [];

  for (const entry of entries) {
    if (batch.length >= limit) break;

    const job = await loadTranslationJob(handle.db, entry.slug, lang);
    if (!job) continue;

    const { extraction, todo } = planArticle(job.doc, job.title, job.memory, job.failures);
    if (todo.length === 0 || todo.length > maxStrings) continue;

    batch.push({
      slug: job.slug,
      title: job.title,
      strings: todo.slice(0, chunk).map((i) => extraction.strings[i]!),
    });
  }

  writeFileSync(out, JSON.stringify(batch, null, 1));

  const total = batch.reduce((n, a) => n + a.strings.length, 0);
  console.log(`${queue.length} artículos pendientes en "${lang}".`);
  console.log(`Exportados ${batch.length} a ${out} — ${total} cadenas en total.`);
  console.log('Agregá a cada uno un arreglo "translations", una por cadena y en el mismo orden.');
} finally {
  await handle.close();
}
