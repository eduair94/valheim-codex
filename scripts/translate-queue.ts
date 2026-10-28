import type { Db } from '../src/lib/db/create-db';
import {
  applyMemory,
  captionsOf,
  extractStrings,
  isPublishable,
  planArticle,
  pruneFailures,
  splitBatches,
  translateArticle,
  type TranslateOptions,
} from '../src/lib/wiki/translate';
import {
  listTranslationQueue,
  loadTranslationJob,
  releaseLease,
  saveTranslationWork,
  type Lease,
  type TranslationJob,
} from '../src/lib/wiki/translate-store';
import {
  afterArticle,
  leaseForScript,
  MAX_DOWN_ARTICLES,
  MAX_IDLE_ARTICLES,
  pickQueue,
  SCRIPT_LEASE_MS,
  type StopReason,
  type Streaks,
} from './translate-cli';

/**
 * The queue run of `pnpm translate:es` (see translate-corpus.ts for why it
 * works the way it does), apart from the command line, so a test can run it
 * against a database and a mock model.
 */

export type QueueRun = {
  lang: string;
  /** At most this many articles brought forward. */
  limit: number;
  /** Articles with more strings pending than this are left for later. */
  maxStrings: number;
  /** Strings between saves. */
  chunk: number;
  /** Strings per request. */
  batchSize: number;
  /** Requests per minute; 0 for no spacing. */
  rpm: number;
  /** Requests at once. */
  concurrency: number;
  order: 'smallest' | 'largest';
  /** The named slugs, in this order; null for the whole queue. */
  slugs: string[] | null;
  /** Say what would be sent, and send and write nothing. */
  dryRun: boolean;
  /** The model chain, clock and sleep, for a test; the operator's chain otherwise. */
  translate?: Pick<TranslateOptions, 'candidates' | 'now' | 'sleep'>;
  log?: (line: string) => void;
};

export type QueueResult = {
  /** Articles brought forward: strings translated, or brought up to date from memory. */
  articles: number;
  strings: number;
  requests: number;
  /** Where the run stopped before the end of its queue, and why. */
  stopped: { slug: string; reason: StopReason } | null;
};

type Acquired = Extract<Lease, { kind: 'acquired' }>;

/** Why a run stopped, for the person who has to decide what to do next. */
const STOPPED: Record<StopReason, (slug: string) => string> = {
  exhausted: (slug) =>
    `Se detuvo en "${slug}": ningún proveedor tenía presupuesto.\n` +
    'Volvé a correrlo cuando los cupos se renueven; retoma donde quedó, cadena por cadena.',
  idle: (slug) =>
    `Se detuvo en "${slug}": ${MAX_IDLE_ARTICLES} artículos seguidos con cadenas nuevas y ninguna traducida.\n` +
    'Los proveedores responden, pero nada de lo que devuelven sirve: revisá el modelo y lo que contesta.',
  unavailable: (slug) =>
    `Se detuvo en "${slug}": ${MAX_DOWN_ARTICLES} artículos seguidos sin respuesta de ningún proveedor ` +
    '(errores del servidor, de red o demoras).\n' +
    'No se anotó nada en contra de las cadenas; volvé a correrlo más tarde y retoma donde quedó.',
};

export async function translateQueue(db: Db, run: QueueRun): Promise<QueueResult> {
  const log = run.log ?? ((line: string) => console.log(line));
  const queue = await listTranslationQueue(db, run.lang, run.order);
  const { entries, idle } = pickQueue(queue, run.slugs);

  log(
    `${queue.length} artículos con trabajo pendiente en "${run.lang}"` +
      (run.slugs ? `; ${entries.length} de los ${run.slugs.length} pedidos.` : '.') +
      (run.dryRun ? ' Simulación: no se llama a ningún modelo ni se escribe nada.' : ''),
  );
  for (const slug of idle) log(`  ${slug.padEnd(34)} nada pendiente (al día, o no existe)`);

  let done = 0;
  let position = 0;
  let streaks: Streaks = { idle: 0, down: 0 };
  let stopped: QueueResult['stopped'] = null;
  const totals = { strings: 0, requests: 0, chars: 0 };

  for (const entry of entries) {
    if (done >= run.limit) break;

    const job = await loadTranslationJob(db, entry.slug, run.lang);
    if (!job) continue;

    const { extraction, todo } = planArticle(job.doc, job.title, job.memory, job.failures);
    if (todo.length > run.maxStrings) {
      log(`  ${'·'.padStart(5)} ${entry.slug.padEnd(34)} omitido: ${todo.length} cadenas pendientes`);
      continue;
    }

    // Its place in this run, whatever came of the ones before it.
    position += 1;
    const label = `${String(position).padStart(4)}. ${entry.slug.padEnd(34)} ${entry.state.padEnd(7)}`;

    if (run.dryRun) {
      const chars = todo.reduce((n, i) => n + extraction.strings[i]!.length, 0);
      const requests = splitBatches(todo.map((i) => extraction.strings[i]!), run.batchSize).length;
      totals.strings += todo.length;
      totals.requests += requests;
      totals.chars += chars;
      done += 1;
      log(`${label} ${todo.length} de ${extraction.strings.length} cadenas, ${requests} pedidos, ${chars} caracteres`);
      continue;
    }

    const lease = await leaseForScript(db, job, run.lang);
    if (lease.kind === 'held') {
      log(`${label} omitido: el sitio lo sigue traduciendo; queda para la próxima corrida`);
      continue;
    }
    if (lease.kind === 'unavailable') {
      log(
        '\nNo se puede escribir article_translation_memory, y sin ella no se guarda nada a medias.\n' +
          'Corré `pnpm db:migrate` (aplica drizzle/0009) con la credencial del dueño y volvé a intentar.',
      );
      break;
    }

    try {
      // The memory as of taking the lease: the site may have added to it.
      const fresh = planArticle(job.doc, job.title, lease.memory, lease.failures);
      if (fresh.todo.length === 0) {
        // Everything is remembered: an article a re-index rewrote without
        // changing, or one the site finished meanwhile. Up to date without a model.
        const shown = await republish(db, run.lang, job, lease);
        done += 1;
        log(`${label} ${shown ? 'al día desde la memoria, sin modelo' : 'nada que agregar todavía'}`);
        continue;
      }

      const started = Date.now();
      const outcome = await translateInChunks(db, run, job, lease);
      totals.requests += outcome.requests;
      totals.strings += outcome.translated;
      if (outcome.translated > 0) done += 1;

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const progress = `${outcome.total - outcome.pending} de ${outcome.total} traducidas`;
      const status = outcome.lost
        ? '  (el sitio tomó el artículo mientras tanto; lo que guardó él queda)'
        : outcome.published
          ? outcome.pending > 0
            ? `  (${outcome.pending} cadenas quedan en inglés, para la próxima)`
            : ''
          : job.published
            ? `  (se sigue mostrando la traducción anterior; ${progress})`
            : `  (todavía no se muestra: ${progress})`;
      const why =
        outcome.translated > 0 || outcome.exhausted
          ? ''
          : outcome.answered === 0 && outcome.unavailable
            ? '  — ningún proveedor respondió'
            : outcome.freshSent === 0
              ? '  — solo le quedan cadenas que ya fallaron antes'
              : '';
      log(`${label} ${seconds}s  ${outcome.model ?? '—'}  ${outcome.translated} cadenas${status}${why}`);

      const next = afterArticle(streaks, outcome);
      streaks = next.streaks;
      if (next.stop) {
        stopped = { slug: entry.slug, reason: next.stop };
        break;
      }
    } finally {
      // A no-op when the last save already gave it back.
      await releaseLease(db, { pageKey: job.pageKey, lang: run.lang, holder: lease.holder });
    }
  }

  if (run.dryRun) {
    log(
      `\n${done} artículos: ${totals.strings} cadenas, ${totals.requests} pedidos de hasta ${run.batchSize}, ` +
        `${totals.chars} caracteres de inglés.` +
        (run.rpm > 0 ? ` A ${run.rpm} pedidos por minuto, unos ${Math.ceil(totals.requests / run.rpm)} minutos.` : ''),
    );
  } else {
    log(`\nTraducidos ${totals.strings} cadenas en ${done} artículos, con ${totals.requests} pedidos.`);
    if (stopped) log(STOPPED[stopped.reason](stopped.slug));
  }
  return { articles: done, strings: totals.strings, requests: totals.requests, stopped };
}

/**
 * One article, saved every `chunk` strings under its lease, which each save
 * renews. A string that fails is not sent again in the same run, so a string
 * no model will translate cannot keep the article busy forever; it is counted
 * against itself and left for the next run.
 */
async function translateInChunks(db: Db, run: QueueRun, job: TranslationJob, lease: Acquired) {
  let memory = lease.memory;
  let failures = lease.failures;
  let published = false;
  let lost = false;
  let model: string | null = null;
  let translated = 0;
  let requests = 0;
  let answered = 0;
  let exhausted = false;
  let unavailable = false;
  let total = 0;
  let pending = 0;
  /** Strings sent that had never failed before this run: none for an article stuck on old failures. */
  let freshSent = 0;
  const tried = new Set<string>();

  for (;;) {
    const result = await translateArticle({
      doc: job.doc,
      title: job.title,
      lang: run.lang,
      memory,
      failures,
      maxStrings: run.chunk,
      skip: tried,
      batchSize: run.batchSize,
      concurrency: run.concurrency,
      minIntervalMs: run.rpm > 0 ? 60_000 / run.rpm : 0,
      ...run.translate,
    });
    for (const s of result.attempted) {
      tried.add(s);
      if ((lease.failures.get(s) ?? 0) === 0) freshSent += 1;
    }
    requests += result.requests;
    answered += result.answered;
    total = result.total;
    pending = result.pending;

    if (result.translated > 0 || result.failed > 0) {
      translated += result.translated;
      model = result.model ?? model;
      memory = result.memory;
      failures = result.failures;
      const publishable = result.translated > 0 && isPublishable(result.total, result.pending);
      const saved = await saveTranslationWork(db, {
        pageKey: job.pageKey,
        lang: run.lang,
        lease: lease.holder,
        release: false,
        leaseMs: SCRIPT_LEASE_MS,
        memory: result.memory,
        failures: result.failures,
        pending: result.pending,
        publish: publishable
          ? {
              title: result.title,
              doc: result.doc,
              model: model ?? job.published?.model ?? 'none',
              version: job.version,
              captions: captionsOf(result.doc, job.doc),
            }
          : null,
      });
      if (saved.memory === 'lost') {
        lost = true;
        break;
      }
      published ||= saved.published;
    }

    if (result.exhausted) {
      exhausted = true;
      break;
    }
    // Providers that stopped answering will not answer the next chunk either.
    if (result.unavailable) {
      unavailable = true;
      break;
    }
    if (result.pending === 0 || result.attempted.length === 0) break;
  }

  return { translated, requests, answered, exhausted, unavailable, freshSent, published, lost, model, total, pending };
}

/** Re-applies the memory and stamps the translation with the current article, when it is worth showing. */
async function republish(db: Db, lang: string, job: TranslationJob, lease: Acquired): Promise<boolean> {
  const applied = applyMemory(job.doc, job.title, lease.memory);
  if (!isPublishable(applied.total, applied.pending)) return false;
  const saved = await saveTranslationWork(db, {
    pageKey: job.pageKey,
    lang,
    lease: lease.holder,
    release: true,
    memory: applied.memory,
    failures: pruneFailures(lease.failures, extractStrings(job.doc, job.title), applied.memory),
    pending: applied.pending,
    publish: {
      title: applied.title,
      doc: applied.doc,
      model: job.published?.model ?? 'none',
      version: job.version,
      captions: captionsOf(applied.doc, job.doc),
    },
  });
  return saved.published;
}
