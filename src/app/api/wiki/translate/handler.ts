import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { clientIp } from '@/lib/auth/client-ip';
import { forbiddenOriginResponse, isSameOriginRequest } from '@/lib/auth/origin';
import { isOperatorPaid, type ChatPrincipal } from '@/lib/auth/principal';
import { consumeQuota, quotaExceededResponse, type QuotaBucket, type QuotaDecision } from '@/lib/auth/quota';
import type { Db } from '@/lib/db/create-db';
import { readJsonBody } from '@/lib/http/json-body';
import { describeError, logError, logWarn } from '@/lib/log';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import {
  applyMemory,
  captionsOf,
  createPacer,
  isPublishable,
  planArticle,
  pruneFailures,
  translateArticle,
  type ArticlePlan,
  type TranslateOptions,
} from '@/lib/wiki/translate';
import { TRANSLATION_MAX_FAILURES, translationBuckets } from '@/lib/wiki/translate-policy';
import {
  acquireLease,
  loadTranslationJob,
  readCachedTranslation,
  releaseLease,
  saveTranslationWork,
  type CachedTranslation,
  type SavedWork,
  type TranslationJob,
  type TranslationWork,
} from '@/lib/wiki/translate-store';

/**
 * A Spanish version of an article, translated once and then served from cache.
 *
 * Reading is a GET with no side effects: whatever is stored, or a 404.
 * Creating or refreshing is a POST, because it spends model tokens on the
 * operator's account. It used to happen on the GET, where a link on any other
 * site could spend a signed-in reader's allowance with a plain navigation, and
 * only for password sessions, so the articles nobody signed in happened to
 * open stayed in English for everyone else.
 *
 * Now any reader can warm an article, counted against an allowance (see
 * `translate-policy.ts`), and the cost of the feature stays bounded by the
 * articles people open rather than by traffic: a translation is stored and
 * served to every later reader, concurrent requests for one article share one
 * translation, and a request that finds nothing it may add spends nothing.
 * Neither does one no provider answered: its unit is given back.
 *
 * Responses — spec §4.5, plus what this implementation adds (marked +):
 *
 *   GET  200 { title, doc, cached: true, stale?: true, +partial?: true }
 *            shared-cacheable only when neither stale nor partial
 *        404 { error: 'not_translated' }      +404 { error: 'not_found' }
 *       +400 { error: 'bad_request' }
 *   POST 200 { title, doc, cached, model?, +stale?: true, +partial?: true }
 *            cached: false — stored just now, and the article's cached page
 *              expired: refresh to show it
 *            cached: true  — nothing new: what was already stored, returned
 *              because this reader can add nothing to it right now (the
 *              strings left have failed too often, or the providers refused
 *              or did not answer). The article's cached page is expired too,
 *              at most once per article every ten minutes: what is stored may
 *              be newer than that page, if another process stored it
 *       +202 { status: 'in_progress', translated, total }
 *            progress is stored but too little of the article is translated
 *            to show yet, or someone else is translating it this moment; ask
 *            again later. Not a success: there is no `doc`
 *        429 { error: 'rate_limited', bucket, retryAfter } + Retry-After
 *        403 { error: 'translation_disabled' }   +403 { error: 'forbidden_origin' }
 *       +404 { error: 'not_found' }
 *        503 { error: 'translation_failed' }      tried, nothing to show; later
 *       +503 { error: 'translation_unavailable' } this article is too long to
 *            translate in one request, and this deployment has nowhere to keep
 *            progress between requests (no memory table); the operator's
 *            script can still do it
 *       +400 / 413 / 415 from `readJsonBody`
 *
 * Kept apart from `route.ts` so it can be exercised with a test database and
 * a mock model; the route only supplies the real dependencies.
 */

/** Languages worth translating into. English is the source and needs no entry. */
const SUPPORTED = ['es'] as const;
type TargetLang = (typeof SUPPORTED)[number];

/** What `slugify` produces. Anything else cannot name an article, so it is refused without a query. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;

/**
 * How much one request may translate, for how long, and how fast.
 *
 * In time, because the site sits behind Cloudflare, which abandons a response
 * after 100 seconds — and with it every reader waiting on the same article:
 *
 *   - no model request starts after `startMs`;
 *   - each provider in the chain gets `requestTimeoutMs`;
 *   - at `hardMs` whatever is still running is abandoned, fallbacks included,
 *     and whatever was translated by then is kept.
 *
 * A per-provider timeout alone bounds nothing — two providers that hang take
 * two timeouts — so `hardMs` is the bound: the answer leaves at about 75
 * seconds plus two writes, whatever the providers do.
 *
 * In rate, because translation draws on the same per-model limits as chat
 * answers (Gemini's free tier allows about twenty requests a minute, and each
 * question takes two). One request at a time, at least `minIntervalMs` apart
 * across every translation this process runs at once, keeps translation under
 * fifteen a minute however many readers ask. `maxStrings` is about what that
 * pace gets through in `startMs`; a longer article fills in over several
 * requests, its progress kept in the memory in between.
 */
const REQUEST_BUDGET = {
  maxStrings: 360,
  concurrency: 1,
  minIntervalMs: 4_000,
  startMs: 45_000,
  requestTimeoutMs: 25_000,
  hardMs: 75_000,
  /** Outlives `hardMs` and the writes after it; a crashed holder's lease frees itself. */
  leaseMs: 120_000,
};

/** Shared by every translation this process runs, so their requests share one pace. */
const sharedPacer = createPacer(REQUEST_BUDGET.minIntervalMs);

const MAX_FAILURES = TRANSLATION_MAX_FAILURES;

/**
 * Without a memory nothing records what failed, so an article whose
 * translation could not be completed in one request is not tried again for a
 * public reader for this long. Without it, every view would pay for the whole
 * article again and keep nothing.
 */
const UNSTORABLE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * After a run that no provider answered — every one refused, or none could
 * answer at all — how long requests are answered from what is stored without
 * asking them again. A minute covers a per-minute quota and most "overloaded"
 * spells; a longer outage is retried once a minute, by whichever reader comes
 * next, rather than by every Spanish view of every untranslated page.
 */
const PROVIDERS_DOWN_MS = 60_000;

const NO_STORE = { 'Cache-Control': 'no-store' };

/** A complete, current translation changes only when the article does. */
const PUBLIC_CACHE = { 'Cache-Control': 'public, max-age=300, s-maxage=86400' };

export type TranslateDeps = {
  db: () => Promise<Db>;
  principal: () => Promise<ChatPrincipal | null>;
  /** Expires cached pages that show this article, so the next render carries the translation. */
  revalidate: (tag: string) => void;
  env?: Record<string, string | undefined>;
  /** Replaceable so a test can make the quota store fail. */
  consumeQuota?: typeof consumeQuota;
  /** Gives back a unit no provider did any work for; replaceable for the same reason. */
  refundQuota?: (db: Db, buckets: QuotaBucket[], countedAt: Date) => Promise<void>;
  /** Model chain, clock, pace and hard stop, for tests. */
  translate?: Pick<TranslateOptions, 'candidates' | 'now' | 'sleep' | 'pacer' | 'signal'>;
};

type Refusal = Extract<QuotaDecision, { allowed: false }>;

type Outcome =
  | { kind: 'not_found' }
  | {
      kind: 'ready';
      title: string;
      doc: ArticleDoc;
      cached: boolean;
      model?: string;
      stale: boolean;
      partial: boolean;
    }
  | { kind: 'in_progress'; translated: number; total: number }
  | { kind: 'rate_limited'; decision: Refusal }
  | { kind: 'failed' }
  | { kind: 'unavailable' };

function isSupported(lang: string): lang is TargetLang {
  return (SUPPORTED as readonly string[]).includes(lang);
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** `GET /api/wiki/translate?slug&lang`: the stored translation, or a 404. */
export async function handleTranslateGet(request: Request, deps: Pick<TranslateDeps, 'db'>): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const slug = params.get('slug') ?? '';
  const lang = params.get('lang') ?? '';
  if (!SLUG.test(slug) || !isSupported(lang)) return json({ error: 'bad_request' }, 400, NO_STORE);

  const found = await readCachedTranslation(await deps.db(), slug, lang);
  if (!found.article) return json({ error: 'not_found' }, 404, NO_STORE);

  const { translation } = found;
  if (!translation) return json({ error: 'not_translated' }, 404, NO_STORE);

  /*
   * A stale or partial translation is still served rather than withheld: a
   * mostly-current Spanish article beats an English one for a reader who does
   * not read English. It is only kept out of shared caches, because a POST is
   * about to replace it.
   */
  const fresh = !translation.stale && !translation.partial;
  return json(
    {
      title: translation.title,
      doc: translation.doc,
      cached: true,
      ...(translation.stale ? { stale: true } : {}),
      ...(translation.partial ? { partial: true } : {}),
    },
    200,
    fresh ? PUBLIC_CACHE : NO_STORE,
  );
}

const postBody = z.object({
  slug: z.string().regex(SLUG),
  lang: z.enum(SUPPORTED),
});

/** How many times a reader who joined someone else's refused request tries again on their own allowance. */
const MAX_REJOINS = 2;

/**
 * `POST /api/wiki/translate` `{ slug, lang }`: creates or refreshes a
 * translation.
 *
 * Every outcome that is known without the database is decided first: a
 * foreign origin, a malformed body, translation switched off for this kind of
 * reader. Then one light query says what is stored; an up-to-date
 * translation, or one this reader can add nothing to, is returned as it is,
 * and only work that needs a model counts against an allowance.
 */
export async function handleTranslatePost(request: Request, deps: TranslateDeps): Promise<Response> {
  // The proxy checks this for every mutating API request. Checked again here
  // because the proxy is a convenience, never the boundary.
  if (!isSameOriginRequest(request.headers)) return noStore(forbiddenOriginResponse());

  const body = await readJsonBody(request, postBody, 1024);
  if (!body.ok) return noStore(body.response);
  const { slug, lang } = body.data;

  const principal = await deps.principal();
  const env = deps.env ?? process.env;
  const buckets = translationBuckets(principal, clientIp(request.headers), env);
  if (buckets.some((bucket) => bucket.limit <= 0)) {
    return json({ error: 'translation_disabled' }, 403, NO_STORE);
  }

  const ctx = { slug, lang, buckets, operatorPaid: isOperatorPaid(principal), deps };
  try {
    for (let rejoin = 0; ; rejoin++) {
      const { value, joined } = await singleFlight(`${lang}:${slug}`, () => translateOnce(ctx));
      /*
       * A refusal belongs to the allowance it was counted against. A reader
       * who joined someone else's request shares its outcome — but when that
       * outcome is the other reader's allowance being spent, their own has
       * not been asked yet.
       */
      if (joined && value.kind === 'rate_limited' && rejoin < MAX_REJOINS) continue;
      // Before the answer leaves: the page refreshes as soon as it reads it.
      if (value.kind === 'ready' && value.cached) expireForStored(slug, deps);
      return respond(value);
    }
  } catch (error) {
    logError('translate', error, { slug, lang });
    return json({ error: 'translation_failed' }, 503, NO_STORE);
  }
}

function respond(outcome: Outcome): Response {
  switch (outcome.kind) {
    case 'not_found':
      return json({ error: 'not_found' }, 404, NO_STORE);
    case 'ready':
      return json(
        {
          title: outcome.title,
          doc: outcome.doc,
          cached: outcome.cached,
          ...(outcome.model ? { model: outcome.model } : {}),
          ...(outcome.stale ? { stale: true } : {}),
          ...(outcome.partial ? { partial: true } : {}),
        },
        200,
        NO_STORE,
      );
    case 'in_progress':
      return json({ status: 'in_progress', translated: outcome.translated, total: outcome.total }, 202, NO_STORE);
    case 'rate_limited':
      return noStore(quotaExceededResponse(outcome.decision));
    case 'failed':
      return json({ error: 'translation_failed' }, 503, NO_STORE);
    case 'unavailable':
      return json({ error: 'translation_unavailable' }, 503, NO_STORE);
  }
}

const flights = new Map<string, Promise<unknown>>();

/**
 * One translation per article and language at a time, in this process.
 *
 * A reader arriving while an article is being translated waits for that
 * translation instead of starting another, so a burst of visits to a new
 * article pays for it once, and counts once against an allowance: only the
 * request that started the work consumed a unit. `joined` tells the others
 * apart, so a refusal of the first reader's allowance is not taken for theirs.
 *
 * Across processes — the bulk script, a second container — the article's
 * lease does the same job (`acquireLease`).
 */
export async function singleFlight<T>(key: string, work: () => Promise<T>): Promise<{ value: T; joined: boolean }> {
  const running = flights.get(key) as Promise<T> | undefined;
  if (running) return { value: await running, joined: true };
  const flight = (async () => {
    try {
      return await work();
    } finally {
      flights.delete(key);
    }
  })();
  flights.set(key, flight);
  return { value: await flight, joined: false };
}

/*
 * What this process has learned and need not ask the database again.
 *
 * Refusals: an allowance that ran out stays out until its window ends, so a
 * reader whose allowance is spent — or everyone, once the public daily one is
 * — is answered from here, without a write. Every Spanish view of an
 * untranslated page asks; without this, each one cost a full load of the
 * article and a write to the counters to be told no.
 *
 * Unstorable: articles whose last attempt, with no memory to keep it in,
 * could not be completed (UNSTORABLE_COOLDOWN_MS).
 *
 * Providers down: the chain is the operator's, shared by every article and
 * every reader, so a run no provider answered says the next one would fare
 * the same (PROVIDERS_DOWN_MS).
 */
const refusals = new Map<string, number>();
const unstorable = new Map<string, number>();
let providersDownUntil = 0;
const REMEMBERED = 2_000;

/** The subject-free part of a bucket name, as `consumeQuota` reports it. */
const bucketKind = (name: string): string => name.split(':').slice(0, 2).join(':');
const bucketKey = (bucket: QuotaBucket): string => `${bucket.name}|${bucket.windowMs}`;

function remember(map: Map<string, number>, key: string, until: number, now: number): void {
  map.delete(key);
  map.set(key, until);
  if (map.size <= REMEMBERED) return;
  for (const [k, t] of map) if (t <= now) map.delete(k);
  // Oldest first: a Map iterates in insertion order.
  for (const k of map.keys()) {
    if (map.size <= REMEMBERED) break;
    map.delete(k);
  }
}

function knownRefusal(buckets: QuotaBucket[], now: number): Refusal | null {
  for (const bucket of buckets) {
    const until = refusals.get(bucketKey(bucket));
    if (until === undefined) continue;
    if (until <= now) {
      refusals.delete(bucketKey(bucket));
      continue;
    }
    return {
      allowed: false,
      bucket: bucketKind(bucket.name),
      retryAfterSeconds: Math.max(1, Math.ceil((until - now) / 1000)),
    };
  }
  return null;
}

function rememberRefusal(buckets: QuotaBucket[], decision: Refusal, now: number): void {
  for (const bucket of buckets) {
    if (bucketKind(bucket.name) === decision.bucket) {
      remember(refusals, bucketKey(bucket), now + decision.retryAfterSeconds * 1000, now);
    }
  }
}

/**
 * How long, after an answer from the store expired an article's cached pages,
 * before another such answer may expire them again (`expireForStored`).
 */
const STORED_EXPIRY_INTERVAL_MS = 10 * 60 * 1000;

/** Articles whose pages an answer from the store expired, and until when it may not again. */
const storedExpiries = new Map<string, number>();

/** Test-only: forget every refusal and cooldown this process remembers. */
export function resetTranslateHandlerState(): void {
  refusals.clear();
  unstorable.clear();
  storedExpiries.clear();
  providersDownUntil = 0;
}

/**
 * Expires the cached pages that show an article, so the next render reads
 * what is stored. A failure is only logged: the translation is stored either
 * way, and the pages catch up on their own revalidation interval.
 */
function expireArticlePages(slug: string, deps: TranslateDeps): void {
  try {
    deps.revalidate(`article:${slug}`);
  } catch (error) {
    logWarn('translate', `could not expire article:${slug}: ${describeError(error).message}`);
  }
}

/**
 * After an answer from the store (`cached: true`): expires the article's
 * cached pages, at most once per article every ten minutes in this process.
 *
 * The page asked because what it showed had no translation, or an older one,
 * and its data cache can be an hour behind the store: a translation stored
 * by another process — the operator's `pnpm translate:es`, another server —
 * never expired this one's cache. Every view of the English page then asked
 * again, was told the translation exists, refreshed, and got the same English
 * page. Expiring the entry lets the refresh show it. Not on every such
 * answer, though: each one empties the cache entry for both languages, and a
 * reader could keep it empty by asking over and over.
 */
function expireForStored(slug: string, deps: TranslateDeps): void {
  const now = (deps.translate?.now ?? Date.now)();
  if ((storedExpiries.get(slug) ?? 0) > now) return;
  // Held before the attempt, so a failing one is not retried on every request.
  remember(storedExpiries, slug, now + STORED_EXPIRY_INTERVAL_MS, now);
  expireArticlePages(slug, deps);
}

/**
 * Gives back the unit `consumeQuota` counted at `countedAt`, in the very
 * windows it counted it in: a run can outlast the end of an hour, and the
 * next hour's window is not the one that was charged.
 *
 * Mirrors how `consumeQuota` keeps a count (src/lib/auth/quota.ts): one
 * `rate_limits` row per `<name>|<windowMs>` and fixed window. It belongs next
 * to it; until it moves there, the route tests pin the two together.
 */
async function refundQuota(db: Db, buckets: QuotaBucket[], countedAt: Date): Promise<void> {
  if (buckets.length === 0) return;
  const counted = buckets.map((bucket) => {
    const windowStart = new Date(Math.floor(countedAt.getTime() / bucket.windowMs) * bucket.windowMs);
    return sql`(${bucketKey(bucket)}, ${windowStart.toISOString()}::timestamptz)`;
  });
  await db.execute(sql`
    UPDATE rate_limits SET count = GREATEST(count - 1, 0)
    WHERE (key, window_start) IN (VALUES ${sql.join(counted, sql`, `)})
  `);
}

type Ctx = {
  slug: string;
  lang: TargetLang;
  buckets: QuotaBucket[];
  operatorPaid: boolean;
  deps: TranslateDeps;
};

/** The stored translation as it is: this request adds nothing to it. */
function stored(translation: Pick<CachedTranslation, 'title' | 'doc' | 'stale'> & { partial: boolean }): Outcome {
  return {
    kind: 'ready',
    title: translation.title,
    doc: translation.doc,
    cached: true,
    stale: translation.stale,
    partial: translation.partial,
  };
}

/** Nothing more this reader can do now: what is stored, or a failure when nothing is. */
function nothingToAdd(job: TranslationJob): Outcome {
  return job.published ? stored({ ...job.published, partial: job.pending > 0 }) : { kind: 'failed' };
}

function progress(plan: ArticlePlan): Outcome {
  const total = plan.extraction.strings.length;
  return { kind: 'in_progress', translated: total - plan.todo.length - plan.stuck.length, total };
}

async function translateOnce(ctx: Ctx): Promise<Outcome> {
  const { slug, lang, buckets, operatorPaid, deps } = ctx;
  const maxFailures = operatorPaid ? MAX_FAILURES.session : MAX_FAILURES.public;
  const now = deps.translate?.now ?? Date.now;
  const db = await deps.db();

  // 1. What readers are shown, and whether this reader could add to it. One
  //    light query: no English article, no memory.
  const state = await readCachedTranslation(db, slug, lang, { maxFailures });
  if (!state.article) return { kind: 'not_found' };
  const shown = state.translation;
  if (shown && !shown.stale && !shown.retryable) return stored(shown);

  // 2. What is already known to be refused costs no write: this reader's
  //    allowance, spent until its window ends, or providers that answered
  //    nothing a moment ago. Unless the translation shown is stale: bringing
  //    it up to date may need no model at all (step 4), and neither refusal
  //    stands in the way of that.
  const known = knownRefusal(buckets, now());
  const refused: Outcome | null = known
    ? { kind: 'rate_limited', decision: known }
    : providersDownUntil > now()
      ? shown
        ? stored(shown)
        : { kind: 'failed' }
      : null;
  if (refused && !shown?.stale) return refused;

  // 3. The article, its translation and its memory.
  const job = await loadTranslationJob(db, slug, lang);
  if (!job) return { kind: 'not_found' };
  let plan = planArticle(job.doc, job.title, job.memory, job.failures, maxFailures);
  if (plan.todo.length === 0 && !isPublishable(plan.extraction.strings.length, plan.stuck.length)) {
    return nothingToAdd(job);
  }
  // A refresh that does need a model, refused as above: still no write.
  if (refused && plan.todo.length > 0) return refused;

  // 4. One writer per article, wherever it runs. The memory comes back with
  //    the lease, as of now: a script may have saved since step 3.
  const holder = `endpoint:${crypto.randomUUID()}`;
  const lease = await acquireLease(db, { pageKey: job.pageKey, lang, holder, ttlMs: REQUEST_BUDGET.leaseMs });
  if (lease.kind === 'held') return progress(plan);

  const leased = lease.kind === 'acquired';
  const memory = leased ? lease.memory : job.memory;
  const failures = leased ? lease.failures : job.failures;
  const key = `${lang}:${slug}`;
  if (leased) {
    plan = planArticle(job.doc, job.title, memory, failures, maxFailures);
  } else {
    // Nowhere to keep progress between requests: the whole article in this
    // one, or nothing. Refused before spending anything.
    if (plan.todo.length > REQUEST_BUDGET.maxStrings) return { kind: 'unavailable' };
    if (!operatorPaid && (unstorable.get(key) ?? 0) > now()) return nothingToAdd(job);
  }

  let released = !leased;
  const save = async (work: Omit<TranslationWork, 'pageKey' | 'lang' | 'lease' | 'release'>): Promise<SavedWork> => {
    const saved = await saveTranslationWork(db, {
      ...work,
      pageKey: job.pageKey,
      lang,
      lease: leased ? holder : null,
      release: true,
    });
    released = true;
    return saved;
  };

  try {
    if (plan.todo.length === 0) {
      /*
       * Everything this reader may add is already remembered — typically an
       * article a re-index rewrote without changing, which makes its
       * translation stale in name only. Brought up to date without a model
       * call, and without counting against anyone's allowance.
       */
      const applied = applyMemory(job.doc, job.title, memory ?? new Map());
      if (!isPublishable(applied.total, applied.pending)) return nothingToAdd(job);
      const saved = await save({
        memory: applied.memory,
        failures: pruneFailures(failures, plan.extraction, applied.memory),
        pending: applied.pending,
        publish: {
          title: applied.title,
          doc: applied.doc,
          model: job.published?.model ?? 'none',
          version: job.version,
          captions: captionsOf(applied.doc, job.doc),
        },
      });
      if (saved.memory === 'lost') return progress(plan);
      return afterPublish(saved, job, deps, { ...applied, model: job.published?.model ?? 'none' });
    }

    // 5. Count it — at a stated instant, so a unit given back below comes
    //    out of the windows it went into.
    const countedAt = new Date(now());
    let counted = true;
    let decision: QuotaDecision;
    try {
      decision = await (deps.consumeQuota ?? consumeQuota)(db, buckets, countedAt);
    } catch (error) {
      /*
       * The quota store is what keeps public translation bounded, so without it
       * a public request is refused rather than paid for blind. A password
       * session is let through, as password chat is: it is someone the operator
       * trusts, and their own ceiling is back as soon as the store is.
       */
      if (!operatorPaid) {
        logError('translate', error, { slug, lang, quota: 'public' });
        return { kind: 'failed' };
      }
      logWarn('translate', `quota store unavailable, allowing a password session: ${describeError(error).message}`, {
        slug,
      });
      decision = { allowed: true };
      counted = false;
    }
    if (!decision.allowed) {
      rememberRefusal(buckets, decision, now());
      return { kind: 'rate_limited', decision };
    }

    // 6. Translate.
    const result = await translateArticle({
      doc: job.doc,
      title: job.title,
      lang,
      memory,
      failures,
      maxFailures,
      maxStrings: REQUEST_BUDGET.maxStrings,
      concurrency: REQUEST_BUDGET.concurrency,
      pacer: sharedPacer,
      deadline: now() + REQUEST_BUDGET.startMs,
      signal: AbortSignal.timeout(REQUEST_BUDGET.hardMs),
      requestTimeoutMs: REQUEST_BUDGET.requestTimeoutMs,
      ...deps.translate,
    });
    if (result.answered === 0) {
      /*
       * No provider produced anything — every one refused, none could be
       * reached, or they hung until the hard stop — so nothing was paid for
       * and the unit goes back. Kept, readers opening pages during a quota
       * outage used up the day's public allowance in minutes and shut public
       * translation for the rest of the day. And unless what failed was held
       * against the text (a string too long to write in time), the next
       * minute of requests is answered from what is stored, without asking
       * the providers again.
       */
      if (result.exhausted || result.unavailable || (result.requests > 0 && result.failed === 0)) {
        providersDownUntil = Math.max(providersDownUntil, now() + PROVIDERS_DOWN_MS);
      }
      if (counted) {
        await (deps.refundQuota ?? refundQuota)(db, buckets, countedAt).catch((error: unknown) => {
          logWarn('translate', `could not give back an unused unit: ${describeError(error).message}`, { slug });
        });
      }
    }
    if (result.translated === 0) {
      const why = result.exhausted
        ? '; every provider refused'
        : result.unavailable
          ? '; no provider answered (server errors, the network or timeouts)'
          : '';
      logWarn('translate', `${slug}: nothing translated${why}`, { lang });
    }

    // 7. Keep it: progress always, when there is a memory to keep it in; the
    //    translation readers see once at least half of it is there.
    const publishable = result.translated > 0 && isPublishable(result.total, result.pending);
    const model = result.model ?? job.published?.model ?? 'none';
    const saved = await save({
      memory: result.memory,
      failures: result.failures,
      pending: result.pending,
      publish: publishable
        ? { title: result.title, doc: result.doc, model, version: job.version, captions: captionsOf(result.doc, job.doc) }
        : null,
    });

    if (saved.memory === 'lost') return progress(plan);
    if (saved.published) return afterPublish(saved, job, deps, { ...result, model });
    if (saved.memory === 'unavailable') {
      // Work was paid for and could not be kept. (Providers that answered
      // nothing cost nothing to try again.)
      if (result.answered > 0 || result.failed > 0) {
        remember(unstorable, key, now() + UNSTORABLE_COOLDOWN_MS, now());
      }
      return nothingToAdd(job);
    }
    if (result.translated === 0) return nothingToAdd(job);
    // Stored, but too little of the article to show yet.
    return { kind: 'in_progress', translated: result.total - result.pending, total: result.total };
  } finally {
    if (!released) {
      await releaseLease(db, { pageKey: job.pageKey, lang, holder }).catch((error: unknown) => {
        logWarn('translate', `could not release the lease on ${slug}: ${describeError(error).message}`);
      });
    }
  }
}

/** Expires the pages that show the article, once readers can see the new translation. */
function afterPublish(
  saved: SavedWork,
  job: TranslationJob,
  deps: TranslateDeps,
  applied: { title: string; doc: ArticleDoc; pending: number; model: string },
): Outcome {
  if (!saved.published) return nothingToAdd(job);
  expireArticlePages(job.slug, deps);
  return {
    kind: 'ready',
    title: applied.title,
    doc: applied.doc,
    cached: false,
    model: applied.model,
    stale: false,
    partial: applied.pending > 0,
  };
}
