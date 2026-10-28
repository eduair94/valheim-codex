import './_env';
import { readFileSync } from 'node:fs';
import { captionsOf, isPublishable, mergeTranslations } from '../src/lib/wiki/translate';
import { loadTranslationJob, releaseLease, saveTranslationWork } from '../src/lib/wiki/translate-store';
import { COMMON_FLAGS, leaseForScript, openDatabase, parseArgs } from './translate-cli';

/**
 * Applies a batch of translations produced outside the provider chain.
 *
 *   pnpm translate:import --in batch.json --model claude-sonnet-4-6
 *   pnpm translate:import --in batch.json --model claude --dry-run
 *
 * Expects what `translate:export` produced, with a `translations` array added
 * to each article: one per exported string, in the same order. Every
 * translation is stored in the article's memory under the English string it
 * was made from, checked against the article as it stands now
 * (`mergeTranslations`): an article edited since the export keeps the
 * translations that still apply, and an entry whose two lists differ in length
 * is skipped whole rather than merged hopefully — applying a shifted list
 * produces a page that renders perfectly and describes the wrong things, which
 * is far worse than one still in English.
 *
 * Imports add up. A long article exported in --chunk pieces is completed one
 * import at a time, and is shown from the import that takes it past half
 * translated, the same rule as every other path.
 *
 * Each article is taken under its lease, like everything else that writes a
 * translation, and merged into its memory as of that moment — what the site
 * translated since the export is kept. Without a memory table (a database
 * that has not had drizzle/0009) only complete articles can be stored.
 */

const USAGE = 'pnpm translate:import --in batch.json --model <name> [--lang es] [--dry-run] [--pglite <dir> | --neon]';

const args = parseArgs(
  process.argv.slice(2),
  { ...COMMON_FLAGS, in: { type: 'string' }, model: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  USAGE,
);

if (args.has('help')) {
  console.log(USAGE);
  process.exit(0);
}

const lang = args.flag('lang') ?? 'es';
const file = args.flag('in') ?? 'translate-batch.json';
const model = args.flag('model') ?? 'claude';
const dryRun = args.has('dry-run');

type Entry = { slug?: unknown; strings?: unknown; translations?: unknown };
const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(parsed)) {
  console.error(`${file} no es una lista de artículos.`);
  process.exit(1);
}
const batch = parsed as Entry[];

const handle = await openDatabase(args, { writes: !dryRun });

let shown = 0;
let kept = 0;
const skipped: string[] = [];

try {
  for (const entry of batch) {
    const slug = typeof entry.slug === 'string' ? entry.slug : '';
    const job = slug ? await loadTranslationJob(handle.db, slug, lang) : null;
    if (!job) {
      skipped.push(`${slug || '(sin slug)'} (no existe)`);
      continue;
    }

    const lease = dryRun ? null : await leaseForScript(handle.db, job, lang);
    if (lease?.kind === 'held') {
      skipped.push(`${slug} (el sitio lo sigue traduciendo; importalo de nuevo después)`);
      continue;
    }
    const holder = lease?.kind === 'acquired' ? lease.holder : null;

    try {
      const merged = mergeTranslations(
        lease?.kind === 'acquired' ? { ...job, memory: lease.memory, failures: lease.failures } : job,
        entry,
      );
      if (!merged.ok) {
        skipped.push(
          merged.reason === 'count_mismatch'
            ? `${slug} (${merged.translations} traducciones para ${merged.strings} cadenas)`
            : `${slug} (sin "translations")`,
        );
        continue;
      }

      const { applied, added, obsolete } = merged;
      const publishable = isPublishable(applied.total, applied.pending);
      let stored = true;
      let visible = publishable;
      if (!dryRun) {
        const saved = await saveTranslationWork(handle.db, {
          pageKey: job.pageKey,
          lang,
          lease: holder,
          release: true,
          memory: applied.memory,
          failures: merged.failures,
          pending: applied.pending,
          publish: publishable
            ? { title: applied.title, doc: applied.doc, model, version: job.version, captions: captionsOf(applied.doc, job.doc) }
            : null,
        });
        stored = saved.memory === 'stored' || saved.published;
        visible = saved.published;
        if (saved.memory === 'lost') {
          skipped.push(`${slug} (el sitio lo tomó mientras tanto; importalo de nuevo)`);
          continue;
        }
      }
      if (!stored) {
        skipped.push(`${slug} (incompleto, y sin article_translation_memory no se guarda a medias)`);
        continue;
      }

      if (visible) shown += 1;
      else kept += 1;
      const notes = [
        applied.pending > 0 ? `${applied.pending} cadenas por traducir` : '',
        obsolete > 0 ? `${obsolete} ya no están en el artículo` : '',
        visible ? '' : 'todavía no se muestra',
      ].filter(Boolean);
      console.log(`  ${slug.padEnd(34)} ${added} traducciones${notes.length ? ` (${notes.join(', ')})` : ''}`);
    } finally {
      if (holder) await releaseLease(handle.db, { pageKey: job.pageKey, lang, holder });
    }
  }
} finally {
  await handle.close();
}

console.log(
  `${dryRun ? 'Simulación: se habrían guardado' : 'Guardados'} ${shown + kept} de ${batch.length} artículos en "${lang}"` +
    ` — ${shown} visibles, ${kept} guardados para completar.`,
);
for (const line of skipped) console.log(`  omitido: ${line}`);
