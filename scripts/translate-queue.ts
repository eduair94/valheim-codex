import type { Db } from '../src/lib/db/create-db';
import {
  applyMemory,
  captionsOf,
  createPacer,
  createSilence,
  estimateTokens,
  extractStrings,
  isPublishable,
  planArticle,
  pruneFailures,
  splitBatches,
  translateArticle,
  type Pacer,
  type Silence,
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
  /** Requests per minute; 0 for no spacing by requests. */
  rpm: number;
  /**
   * Tokens per minute the run may spend, paid off as the providers report
   * them; 0 for no budget. `TOKENS_PER_MINUTE` from the command line.
   */
  tpm: number;
  /** Requests at once. */
  concurrency: number;
  order: 'smallest' | 'largest';
  /** The named slugs, in this order; null for the whole queue. */
  slugs: string[] | null;
  /** Say what would be sent, and send and write nothing. */
  dryRun: boolean;
  /**
   * The model chain, clock and sleep, and a provider's deadline, for a test;
   * the operator's chain otherwise.
   */
  translate?: Pick<TranslateOptions, 'candidates' | 'now' | 'sleep' | 'requestTimeoutMs'>;
  log?: (line: string) => void;
};

export type QueueResult = {
  /** Articles brought forward: strings translated, or brought up to date from memory. */
  articles: number;
  strings: number;
  /** Requests made of the provider chain: batches, halves, and batches asked again after a wait. */
  requests: number;
  /** Calls to providers: every one the chain made, fallbacks and same-provider retries included. */
  calls: number;
  /** Tokens the providers said they used: what their per-minute and per-day limits count. */
  tokens: number;
  /** Where the run stopped before the end of its queue, and why. */
  stopped: { slug: string; reason: StopReason } | null;
};

type Acquired = Extract<Lease, { kind: 'acquired' }>;

/**
 * How long a run waits, after a request no provider answered, before its
 * next request: the same strings asked again, the next round of the
 * article, or the next article — when the refusal named no wait of its own.
 * A minute is the window every per-minute limit counts in, and long enough
 * for an "overloaded" spell to pass; two requests in a row with no answer, a
 * minute apart, are an outage rather than one busy minute.
 */
const NO_ANSWER_WAIT_MS = 60_000;

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
    '(errores del servidor, de red o demoras), con al menos un minuto de espera antes de cada nuevo pedido.\n' +
    'No se anotó nada en contra de las cadenas; volvé a correrlo más tarde y retoma donde quedó.',
  'rate-limited': (slug) =>
    `Se detuvo en "${slug}": ${MAX_DOWN_ARTICLES} artículos seguidos en que los proveedores siguieron limitando ` +
    'por minuto, con al menos un minuto de espera antes de cada nuevo pedido.\n' +
    'Algo más está gastando el mismo cupo, seguramente el chat del sitio. Volvé a correrlo en un rato más ' +
    'tranquilo, o con un --tpm más bajo; retoma donde quedó, y no se anotó nada en contra de las cadenas.',
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
  const totals = { strings: 0, requests: 0, calls: 0, tokens: 0, chars: 0 };
  // One pace for the whole run. Each article used to start its own, so the
  // first request of every article went out on the heels of the last one,
  // whatever --rpm said. It hears the tokens every request used, and keeps
  // the run to --tpm of them a minute.
  const pacer = createPacer(run.rpm > 0 ? 60_000 / run.rpm : 0, run.translate?.now, run.translate?.sleep, run.tpm);
  // And one count of the requests no provider answered, for the same reason:
  // the request after one, in the next round or the next article, still
  // waits before it asks, and still counts as the second (`Silence`).
  const silence = createSilence();

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
      const batches = splitBatches(todo.map((i) => extraction.strings[i]!), run.batchSize);
      // At each batch's ceiling: no more than this, and in practice less.
      const tokens = batches.reduce((n, { batch }) => n + estimateTokens(batch, run.lang), 0);
      totals.strings += todo.length;
      totals.requests += batches.length;
      totals.tokens += tokens;
      totals.chars += chars;
      done += 1;
      log(
        `${label} ${todo.length} de ${extraction.strings.length} cadenas, ${batches.length} pedidos, ` +
          `${chars} caracteres, hasta ${tokens} tokens`,
      );
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
      const outcome = await translateInChunks(db, run, job, lease, pacer, silence);
      totals.requests += outcome.requests;
      totals.calls += outcome.calls;
      totals.tokens += outcome.tokens;
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
      // A rate limit is a provider that answered "wait", not silence: the
      // operator looks for a busy chat, not for an outage.
      const why =
        outcome.translated > 0 || outcome.exhausted
          ? ''
          : outcome.outage
            ? outcome.rateLimited
              ? '  — límite por minuto, aun tras esperar'
              : '  — ningún proveedor respondió'
            : outcome.freshSent === 0
              ? '  — solo le quedan cadenas que ya fallaron antes'
              : '';
      log(
        `${label} ${seconds}s  ${outcome.model ?? '—'}  ${outcome.translated} cadenas, ${outcome.tokens} tokens` +
          `${status}${why}`,
      );

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
    // The slower of the two paces bounds the run; tokens at their ceiling make it a bound, not a forecast.
    const minutes = Math.ceil(
      Math.max(run.tpm > 0 ? totals.tokens / run.tpm : 0, run.rpm > 0 ? totals.requests / run.rpm : 0),
    );
    log(
      `\n${done} artículos: ${totals.strings} cadenas, ${totals.requests} pedidos de hasta ${run.batchSize}, ` +
        `${totals.chars} caracteres de inglés, hasta ${totals.tokens} tokens.` +
        (minutes > 0 ? ` A este ritmo, unos ${minutes} minutos como mucho.` : ''),
    );
  } else {
    log(
      `\nTraducidos ${totals.strings} cadenas en ${done} artículos, con ${totals.requests} pedidos ` +
        `(${totals.calls} llamadas a proveedores, ${totals.tokens} tokens).`,
    );
    if (stopped) log(STOPPED[stopped.reason](stopped.slug));
  }
  return {
    articles: done,
    strings: totals.strings,
    requests: totals.requests,
    calls: totals.calls,
    tokens: totals.tokens,
    stopped,
  };
}

/**
 * One article, saved every `chunk` strings under its lease, which each save
 * renews: by default after every round of requests (`runPace`), so a run
 * that dies, during a wait or not, costs only the round in flight. A string
 * that fails is not sent again in the same run, so a string no model will
 * translate cannot keep the article busy forever; it is counted against
 * itself and left for the next run.
 *
 * Nobody is waiting on this run, so it waits out what the reader's endpoint
 * cannot: a provider's rate limit (the chain does), and a request no provider
 * answered, asked again for the same strings a minute later
 * (`NO_ANSWER_WAIT_MS`). Only an outage ends the article: a round that ends
 * on one request nobody answered — a long half that ran out of time, with no
 * halving left — is followed by the next, after the wait, and it is that
 * round's first request which tells whether the providers are down.
 */
async function translateInChunks(
  db: Db,
  run: QueueRun,
  job: TranslationJob,
  lease: Acquired,
  pacer: Pacer,
  silence: Silence,
) {
  let memory = lease.memory;
  let failures = lease.failures;
  let published = false;
  let lost = false;
  let model: string | null = null;
  let translated = 0;
  let requests = 0;
  let calls = 0;
  let tokens = 0;
  let answered = 0;
  let exhausted = false;
  let outage = false;
  let rateLimited = false;
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
      pacer,
      silence,
      noAnswerWaitMs: NO_ANSWER_WAIT_MS,
      ...run.translate,
    });
    for (const s of result.attempted) {
      tried.add(s);
      if ((lease.failures.get(s) ?? 0) === 0) freshSent += 1;
    }
    requests += result.requests;
    calls += result.calls;
    tokens += result.tokens;
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
    // Providers that stopped answering — two requests in a row, the second a
    // minute after the first — will not answer the next round either.
    if (result.outage) {
      outage = true;
      rateLimited = result.rateLimited;
      break;
    }
    if (result.pending === 0 || result.attempted.length === 0) break;
  }

  return {
    translated,
    requests,
    calls,
    tokens,
    answered,
    exhausted,
    outage,
    rateLimited,
    freshSent,
    published,
    lost,
    model,
    total,
    pending,
  };
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
