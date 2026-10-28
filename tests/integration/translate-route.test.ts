import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleTranslateGet,
  handleTranslatePost,
  resetTranslateHandlerState,
  singleFlight,
  type TranslateDeps,
} from '@/app/api/wiki/translate/handler';
import type { ChatPrincipal } from '@/lib/auth/principal';
import { consumeQuota } from '@/lib/auth/quota';
import { rawQuery, type Db, type DbHandle } from '@/lib/db/create-db';
import { upsertArticle } from '@/lib/db/wiki-repo';
import { ResponseTimeoutError } from '@/lib/rag/fallback';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import { applyMemory, extractStrings } from '@/lib/wiki/translate';
import {
  acquireLease,
  loadTranslationJob,
  readTranslatedCaptions,
  resetMemoryTableState,
  saveTranslationWork,
} from '@/lib/wiki/translate-store';
import { createTestDb } from '../helpers/db';
import type * as Provider from '@/lib/rag/provider';
import { garbage, instantPacer, mockTranslator, refusal, spanish, unavailable } from '../helpers/mock-translator';

// Every request here carries its own mock chain. One that forgets gets a chain
// that cannot answer (a 503), never the real one — whose key may well be in
// the environment of whoever runs the tests.
vi.mock('@/lib/rag/provider', async (original) => ({
  ...(await original<typeof Provider>()),
  rewriteCandidates: () => {
    throw new Error('a test reached the real model chain');
  },
}));

/**
 * The translation endpoint against a real (in-memory) Postgres and a mock
 * model: what is read, what is counted against whose allowance, what is kept
 * when part of the work fails, what is never paid for twice, and what happens
 * when the database cannot keep progress at all.
 */

let handle: DbHandle;
let pageId = 1;

beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  await handle?.close();
});
beforeEach(() => {
  resetTranslateHandlerState();
  resetMemoryTableState();
  // Failures are part of what is tested; their warnings are noise here.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** An article with `n` distinct strings: its title plus `n - 1` list items. */
function docWith(n: number, prefix = 'Line'): ArticleDoc {
  return {
    lead: '',
    blocks: [
      {
        kind: 'list',
        section: '',
        ordered: false,
        items: Array.from({ length: n - 1 }, (_, i) => `${prefix} ${String(i + 1).padStart(3, '0')} of the article`),
      },
    ],
    infobox: null,
    images: [],
    facets: {},
  };
}

async function seed(slug: string, doc: ArticleDoc, title = `Title of ${slug}`): Promise<string> {
  const key = `fandom:${pageId}`;
  await handle.db.execute(sql`
    INSERT INTO pages (key, source, page_id, title, url, revid)
    VALUES (${key}, 'fandom', ${pageId}, ${title}, ${`https://example.test/${slug}`}, 1)
  `);
  pageId += 1;
  await upsertArticle(handle.db, {
    pageKey: key,
    source: 'fandom',
    title,
    slug,
    url: `https://example.test/${slug}`,
    categories: [],
    doc,
  });
  return key;
}

const ENV = { PUBLIC_TRANSLATIONS_PER_DAY: '1000', PUBLIC_TRANSLATIONS_PER_IP_PER_HOUR: '1000' };
const PASSWORD: ChatPrincipal = { kind: 'password', profile: 'ana' };

type TestDeps = TranslateDeps & { revalidated: string[]; mock: ReturnType<typeof mockTranslator> };

function deps(
  options: { principal?: ChatPrincipal | null; mock?: ReturnType<typeof mockTranslator> } & Omit<
    Partial<TranslateDeps>,
    'principal'
  > = {},
): TestDeps {
  const { principal = null, mock = mockTranslator(), ...rest } = options;
  const revalidated: string[] = [];
  return {
    db: async () => handle.db,
    principal: async () => principal,
    revalidate: (tag) => {
      revalidated.push(tag);
    },
    env: ENV,
    // The endpoint's own pacer spaces requests four seconds apart.
    translate: { candidates: mock.candidates, pacer: instantPacer() },
    ...rest,
    revalidated,
    mock,
  };
}

let ipCounter = 1;
/** A distinct client address per call site, so per-address buckets never collide between tests. */
const freshIp = () => `198.51.100.${ipCounter++}`;

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/wiki/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const get = (slug: string, lang = 'es') =>
  handleTranslateGet(new Request(`http://localhost/api/wiki/translate?slug=${slug}&lang=${lang}`), {
    db: async () => handle.db,
  });

async function quotaCount(key: string): Promise<number> {
  const rows = await rawQuery<{ n: number | string | null }>(
    handle.db,
    sql`SELECT sum(count) AS n FROM rate_limits WHERE key = ${key}`,
  );
  return Number(rows[0]?.n ?? 0);
}

const ipUnits = (ip: string) => quotaCount(`translate:public-ip:${ip}|3600000`);

async function memoryRow(
  pageKey: string,
): Promise<{ pending: number; entries: Record<string, string>; failures: Record<string, number> } | null> {
  const rows = await rawQuery<{ pending: number; entries: Record<string, string>; failures: Record<string, number> }>(
    handle.db,
    sql`SELECT pending, entries, failures FROM article_translation_memory WHERE page_key = ${pageKey} AND lang = 'es'`,
  );
  return rows[0] ?? null;
}

/** The database, counting every statement sent through it. */
function counting(db: Db): { db: Db; statements: () => number } {
  let statements = 0;
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return (...args: Parameters<Db['execute']>) => {
          statements += 1;
          return target.execute(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: wrapped, statements: () => statements };
}

describe('GET: the stored translation, and nothing else', () => {
  it('answers 404 not_translated for an article with no translation, and not_found for no article', async () => {
    await seed('get-untranslated', docWith(5));

    const missing = await get('get-untranslated');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_translated' });
    expect(missing.headers.get('cache-control')).toBe('no-store');

    const unknown = await get('no-such-article');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });
  });

  it('refuses a malformed slug or an unsupported language without a query', async () => {
    const db = vi.fn(async (): Promise<Db> => {
      throw new Error('no query expected');
    });
    for (const url of ['?slug=Bad%20Slug&lang=es', '?slug=iron&lang=fr', '?lang=es']) {
      const response = await handleTranslateGet(new Request(`http://localhost/api/wiki/translate${url}`), { db });
      expect(response.status).toBe(400);
    }
    expect(db).not.toHaveBeenCalled();
  });

  it('serves a fresh translation with public cache headers, and never starts one', async () => {
    await seed('get-fresh', docWith(5));
    const before = await quotaCount('translate:public-global|86400000');

    // GET never translates, whoever asks.
    expect((await get('get-fresh')).status).toBe(404);
    expect(await quotaCount('translate:public-global|86400000')).toBe(before);

    const created = await handleTranslatePost(post({ slug: 'get-fresh', lang: 'es' }, { 'cf-connecting-ip': freshIp() }), deps());
    expect(created.status).toBe(200);

    const response = await get('get-fresh');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=86400');
    const body = await response.json();
    expect(body).toMatchObject({ title: 'ES:Title of get-fresh', cached: true });
    expect(body.stale).toBeUndefined();
    expect(body.partial).toBeUndefined();
  });
});

describe('POST: decided before the database when it can be', () => {
  it('refuses a foreign origin and a non-JSON body', async () => {
    const d = deps();
    const foreign = await handleTranslatePost(post({ slug: 'x', lang: 'es' }, { 'sec-fetch-site': 'cross-site' }), d);
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'forbidden_origin' });

    const plain = await handleTranslatePost(
      new Request('http://localhost/api/wiki/translate', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ slug: 'x', lang: 'es' }),
      }),
      d,
    );
    expect(plain.status).toBe(415);

    const bad = await handleTranslatePost(post({ slug: 'x', lang: 'fr' }), d);
    expect(bad.status).toBe(400);
    expect(d.mock.calls).toHaveLength(0);
  });

  it('answers 403 translation_disabled without touching the database when the public allowance is zero', async () => {
    const db = vi.fn(async (): Promise<Db> => {
      throw new Error('no query expected');
    });
    const response = await handleTranslatePost(
      post({ slug: 'anything', lang: 'es' }),
      deps({ db, env: { PUBLIC_TRANSLATIONS_PER_DAY: '0' } }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'translation_disabled' });
    expect(db).not.toHaveBeenCalled();
  });

  it('applies a zero session allowance to password sessions too', async () => {
    const response = await handleTranslatePost(
      post({ slug: 'anything', lang: 'es' }),
      deps({ principal: PASSWORD, env: { SESSION_TRANSLATIONS_PER_HOUR: '0' } }),
    );
    expect(response.status).toBe(403);
  });

  it('answers 404 for an article that does not exist, spending nothing', async () => {
    const d = deps();
    const response = await handleTranslatePost(post({ slug: 'no-such-article', lang: 'es' }), d);
    expect(response.status).toBe(404);
    expect(d.mock.calls).toHaveLength(0);
  });
});

describe('POST: creating a translation', () => {
  it('translates for a signed-out reader under the public allowance, and expires the article page', async () => {
    await seed('create-public', docWith(5));
    const ip = freshIp();
    const d = deps();

    const response = await handleTranslatePost(post({ slug: 'create-public', lang: 'es' }, { 'cf-connecting-ip': ip }), d);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      title: 'ES:Title of create-public',
      cached: false,
      model: 'mock/translator',
    });
    expect(d.revalidated).toEqual(['article:create-public']);
    expect(await ipUnits(ip)).toBe(1);
  });

  it('returns a current translation as it is, spending nothing', async () => {
    await seed('create-twice', docWith(5));
    const ip = freshIp();
    await handleTranslatePost(post({ slug: 'create-twice', lang: 'es' }, { 'cf-connecting-ip': ip }), deps());

    const again = deps();
    const response = await handleTranslatePost(post({ slug: 'create-twice', lang: 'es' }, { 'cf-connecting-ip': ip }), again);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cached: true, title: 'ES:Title of create-twice' });
    expect(again.mock.calls).toHaveLength(0);
    // An answer from the store expires the page once, in case it is behind
    // the store (see "a translation another process stored").
    expect(again.revalidated).toEqual(['article:create-twice']);
    expect(await ipUnits(ip)).toBe(1);
  });

  it('counts a password session against its own allowance', async () => {
    await seed('create-password', docWith(5));
    const response = await handleTranslatePost(post({ slug: 'create-password', lang: 'es' }), deps({ principal: PASSWORD }));
    expect(response.status).toBe(200);
    expect(await quotaCount('translate:pw:ana|3600000')).toBe(1);
  });

  it('counts a guest with their own Gemini key against the public allowance', async () => {
    await seed('create-byok', docWith(5));
    const ip = freshIp();
    const response = await handleTranslatePost(
      post({ slug: 'create-byok', lang: 'es' }, { 'cf-connecting-ip': ip }),
      deps({
        principal: { kind: 'byok', profile: 'byok:00000000-0000-4000-8000-000000000000', apiKey: 'k', model: 'gemini-3.5-flash-lite' },
      }),
    );
    expect(response.status).toBe(200);
    expect(await ipUnits(ip)).toBe(1);
  });

  it('answers 429 with Retry-After once the allowance is spent, and still serves what exists', async () => {
    await seed('limit-a', docWith(5));
    await seed('limit-b', docWith(5));
    const ip = freshIp();
    const env = { PUBLIC_TRANSLATIONS_PER_DAY: '1000', PUBLIC_TRANSLATIONS_PER_IP_PER_HOUR: '1' };

    const first = await handleTranslatePost(post({ slug: 'limit-a', lang: 'es' }, { 'cf-connecting-ip': ip }), deps({ env }));
    expect(first.status).toBe(200);

    const refused = deps({ env });
    const second = await handleTranslatePost(post({ slug: 'limit-b', lang: 'es' }, { 'cf-connecting-ip': ip }), refused);
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body).toMatchObject({ error: 'rate_limited', bucket: 'translate:public-ip' });
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(second.headers.get('retry-after')).toBe(String(body.retryAfter));
    expect(refused.mock.calls).toHaveLength(0);

    // A translation that already exists costs nothing, so it is served even now.
    const cached = await handleTranslatePost(post({ slug: 'limit-a', lang: 'es' }, { 'cf-connecting-ip': ip }), deps({ env }));
    expect(cached.status).toBe(200);
  });

  it('remembers a refusal, so the next one costs one light read and no write (PERF-11)', async () => {
    await seed('remember-a', docWith(5));
    await seed('remember-b', docWith(5));
    await seed('remember-c', docWith(5));
    const ip = freshIp();
    const env = { PUBLIC_TRANSLATIONS_PER_DAY: '1000', PUBLIC_TRANSLATIONS_PER_IP_PER_HOUR: '1' };
    await handleTranslatePost(post({ slug: 'remember-a', lang: 'es' }, { 'cf-connecting-ip': ip }), deps({ env }));
    expect((await handleTranslatePost(post({ slug: 'remember-b', lang: 'es' }, { 'cf-connecting-ip': ip }), deps({ env }))).status).toBe(429);
    const units = await ipUnits(ip);

    const { db, statements } = counting(handle.db);
    const third = await handleTranslatePost(
      post({ slug: 'remember-c', lang: 'es' }, { 'cf-connecting-ip': ip }),
      deps({ env, db: async () => db }),
    );
    expect(third.status).toBe(429);
    expect((await third.json()).bucket).toBe('translate:public-ip');
    // The state of the article, and nothing else: no article load, no lease, no counter.
    expect(statements()).toBe(1);
    expect(await ipUnits(ip)).toBe(units);
  });

  it('refuses public work when the quota store is down, but lets a password session through', async () => {
    await seed('quota-down', docWith(5));
    const down = async (): Promise<never> => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    };

    const publicDeps = deps({ consumeQuota: down });
    const refused = await handleTranslatePost(post({ slug: 'quota-down', lang: 'es' }), publicDeps);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: 'translation_failed' });
    expect(publicDeps.mock.calls).toHaveLength(0);

    const password = deps({ consumeQuota: down, principal: PASSWORD });
    const allowed = await handleTranslatePost(post({ slug: 'quota-down', lang: 'es' }), password);
    expect(allowed.status).toBe(200);
    expect(password.mock.calls).toHaveLength(1);
  });

  it('answers 503 and shows nothing when every provider refuses', async () => {
    const key = await seed('all-refuse', docWith(5));
    const d = deps({ mock: mockTranslator(() => refusal(429)) });
    const response = await handleTranslatePost(post({ slug: 'all-refuse', lang: 'es' }), d);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'translation_failed' });
    expect((await get('all-refuse')).status).toBe(404);
    // A refusal is about the account, never held against the strings.
    expect(await memoryRow(key)).toMatchObject({ entries: {}, failures: {} });
  });

  it('sends one request at a time, each one paced (requests per minute are shared with chat)', async () => {
    await seed('paced', docWith(100));
    let inFlight = 0;
    let most = 0;
    const mock = mockTranslator(async (strings) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return spanish(strings, 0);
    });
    const pacer = instantPacer();
    const response = await handleTranslatePost(
      post({ slug: 'paced', lang: 'es' }),
      deps({ mock, translate: { candidates: mock.candidates, pacer } }),
    );
    expect(response.status).toBe(200);
    expect(mock.calls.map((c) => c.length)).toEqual([40, 40, 20]);
    expect(most).toBe(1);
    expect(pacer.turns).toBe(3);
  });
});

describe('POST: one translation per article at a time', () => {
  it('lets concurrent readers share one translation and one unit of allowance', async () => {
    await seed('flight', docWith(5));
    const ip = freshIp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mock = mockTranslator(async (strings) => {
      await gate;
      return spanish(strings, 0);
    });
    const d = deps({ mock });

    const first = handleTranslatePost(post({ slug: 'flight', lang: 'es' }, { 'cf-connecting-ip': ip }), d);
    const second = handleTranslatePost(post({ slug: 'flight', lang: 'es' }, { 'cf-connecting-ip': ip }), d);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    expect(mock.calls).toHaveLength(1);
    expect(await ipUnits(ip)).toBe(1);
  });

  it('gives a reader who joined a refused request a try on their own allowance', async () => {
    await seed('joined-other', docWith(5));
    await seed('joined', docWith(5));
    const ip = freshIp();
    const env = { PUBLIC_TRANSLATIONS_PER_DAY: '1000', PUBLIC_TRANSLATIONS_PER_IP_PER_HOUR: '1' };
    await handleTranslatePost(post({ slug: 'joined-other', lang: 'es' }, { 'cf-connecting-ip': ip }), deps({ env }));

    // The signed-out reader's request is refused, slowly enough that the
    // password session arrives while it is still running and joins it.
    const slowQuota: typeof consumeQuota = async (db, buckets) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return consumeQuota(db, buckets);
    };
    const publicRequest = handleTranslatePost(
      post({ slug: 'joined', lang: 'es' }, { 'cf-connecting-ip': ip }),
      deps({ env, consumeQuota: slowQuota }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const password = deps({ env, principal: PASSWORD });
    const passwordRequest = handleTranslatePost(post({ slug: 'joined', lang: 'es' }, { 'cf-connecting-ip': freshIp() }), password);

    const [refused, served] = await Promise.all([publicRequest, passwordRequest]);
    expect(refused.status).toBe(429);
    expect((await refused.json()).bucket).toBe('translate:public-ip');
    expect(served.status).toBe(200);
    expect(password.mock.calls).toHaveLength(1);
    expect(await quotaCount('translate:pw:ana|3600000')).toBeGreaterThan(0);
  });

  it('releases the key when the work fails, so the next request can try again', async () => {
    await expect(singleFlight('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(singleFlight('k', async () => 'second try')).resolves.toEqual({ value: 'second try', joined: false });
  });
});

describe('POST: one writer per article, across processes (the lease)', () => {
  it('answers 202 without spending while a script translates the article, then pays only for what it left', async () => {
    const key = await seed('leased', docWith(10));
    const ip = freshIp();
    await acquireLease(handle.db, { pageKey: key, lang: 'es', holder: 'script:test', ttlMs: 60_000 });

    const waiting = deps();
    const busy = await handleTranslatePost(post({ slug: 'leased', lang: 'es' }, { 'cf-connecting-ip': ip }), waiting);
    expect(busy.status).toBe(202);
    expect(await busy.json()).toEqual({ status: 'in_progress', translated: 0, total: 10 });
    expect(waiting.mock.calls).toHaveLength(0);
    expect(await ipUnits(ip)).toBe(0);

    // The script saves six strings and gives the article back.
    const job = (await loadTranslationJob(handle.db, 'leased', 'es'))!;
    const done = extractStrings(job.doc, job.title).strings.slice(0, 6);
    const applied = applyMemory(job.doc, job.title, new Map(done.map((s) => [s, `SCRIPT:${s}`])));
    await saveTranslationWork(handle.db, {
      pageKey: key,
      lang: 'es',
      lease: 'script:test',
      release: true,
      memory: applied.memory,
      failures: new Map(),
      pending: applied.pending,
      publish: { title: applied.title, doc: applied.doc, model: 'script', version: job.version },
    });

    const after = deps();
    const finished = await handleTranslatePost(post({ slug: 'leased', lang: 'es' }, { 'cf-connecting-ip': ip }), after);
    expect(finished.status).toBe(200);
    expect(after.mock.calls.flat()).toHaveLength(4);
    expect(after.mock.calls.flat()).not.toContain(done[1]);
    expect((await finished.json()).title).toBe(`SCRIPT:${job.title}`);
  });

  it('writes nothing over someone who took the article after its lease ran out', async () => {
    const key = await seed('stolen', docWith(5));
    const mock = mockTranslator(async (strings) => {
      // As if this request had outlived its lease and a script had taken over.
      await handle.db.execute(
        sql`UPDATE article_translation_memory SET lease_holder = 'script:thief' WHERE page_key = ${key}`,
      );
      return spanish(strings, 0);
    });
    const response = await handleTranslatePost(post({ slug: 'stolen', lang: 'es' }), deps({ mock }));
    expect(response.status).toBe(202);
    expect((await get('stolen')).status).toBe(404);
    expect(await memoryRow(key)).toMatchObject({ entries: {} });
  });
});

describe('POST: a translation another process stored (the page cache)', () => {
  /** What the operator's script does: takes the article, translates all of it, publishes it, gives it back. */
  async function translateElsewhere(slug: string, pageKey: string): Promise<void> {
    await acquireLease(handle.db, { pageKey, lang: 'es', holder: 'script:elsewhere', ttlMs: 60_000 });
    const job = (await loadTranslationJob(handle.db, slug, 'es'))!;
    const all = extractStrings(job.doc, job.title).strings;
    const applied = applyMemory(job.doc, job.title, new Map(all.map((s) => [s, `SCRIPT:${s}`])));
    const saved = await saveTranslationWork(handle.db, {
      pageKey,
      lang: 'es',
      lease: 'script:elsewhere',
      release: true,
      memory: applied.memory,
      failures: new Map(),
      pending: applied.pending,
      publish: { title: applied.title, doc: applied.doc, model: 'script', version: job.version },
    });
    expect(saved.published).toBe(true);
  }

  /** A reader's request at `now`, and the cache tags it expired. */
  async function ask(slug: string, now: () => number = Date.now): Promise<{ body: Record<string, unknown>; expired: string[] }> {
    const mock = mockTranslator();
    const d = deps({ mock, translate: { candidates: mock.candidates, pacer: instantPacer(), now } });
    const response = await handleTranslatePost(post({ slug, lang: 'es' }), d);
    expect(response.status).toBe(200);
    expect(mock.calls).toHaveLength(0);
    return { body: (await response.json()) as Record<string, unknown>, expired: d.revalidated };
  }

  it("expires the article's cached page when it answers with what the script stored", async () => {
    // The script cannot reach this server's cache: the page kept showing
    // English for up to an hour, and asked again on every view.
    const key = await seed('stored-elsewhere', docWith(5));
    await translateElsewhere('stored-elsewhere', key);

    const { body, expired } = await ask('stored-elsewhere');
    expect(body).toMatchObject({ cached: true, title: 'SCRIPT:Title of stored-elsewhere' });
    expect(expired).toEqual(['article:stored-elsewhere']);
  });

  it('expires it at most once per article every ten minutes, however often readers ask', async () => {
    const key = await seed('asked-often', docWith(5));
    const other = await seed('asked-often-too', docWith(5));
    await translateElsewhere('asked-often', key);
    await translateElsewhere('asked-often-too', other);
    let clock = Date.now();
    const now = () => clock;

    expect((await ask('asked-often', now)).expired).toEqual(['article:asked-often']);
    for (let view = 0; view < 5; view++) expect((await ask('asked-often', now)).expired).toEqual([]);
    // Each article has ten minutes of its own.
    expect((await ask('asked-often-too', now)).expired).toEqual(['article:asked-often-too']);

    clock += 9 * 60 * 1000;
    expect((await ask('asked-often', now)).expired).toEqual([]);
    clock += 61 * 1000;
    expect((await ask('asked-often', now)).expired).toEqual(['article:asked-often']);
  });

  it('still expires the page whenever this process stores a translation, interval or not', async () => {
    const original = docWith(5);
    const key = await seed('stored-then-edited', original);
    await translateElsewhere('stored-then-edited', key);
    expect((await ask('stored-then-edited')).expired).toEqual(['article:stored-then-edited']);

    // The wiki edits the article; a reader asks for the update, which this process stores.
    const edited = structuredClone(original);
    const list = edited.blocks[0];
    if (list?.kind !== 'list') throw new Error('expected a list');
    list.items[0] = 'A line the wiki rewrote';
    await upsertArticle(handle.db, {
      pageKey: key,
      source: 'fandom',
      title: 'Title of stored-then-edited',
      slug: 'stored-then-edited',
      url: 'https://example.test/stored-then-edited',
      categories: [],
      doc: edited,
    });
    await handle.db.execute(sql`UPDATE articles SET updated_at = updated_at + interval '1 minute' WHERE slug = 'stored-then-edited'`);

    const d = deps();
    const response = await handleTranslatePost(post({ slug: 'stored-then-edited', lang: 'es' }), d);
    expect(await response.json()).toMatchObject({ cached: false });
    expect(d.revalidated).toEqual(['article:stored-then-edited']);
  });

  it('answers as usual when the page cannot be expired', async () => {
    const key = await seed('expiry-fails', docWith(5));
    await translateElsewhere('expiry-fails', key);
    const d = deps({
      revalidate: () => {
        throw new Error('no cache here');
      },
    });
    const response = await handleTranslatePost(post({ slug: 'expiry-fails', lang: 'es' }), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cached: true });
  });
});

describe('POST: keeping what worked', () => {
  it('stores a mostly-translated article as partial, then sends only the strings that failed', async () => {
    // 100 strings: batches of 40, 40 and 20. Whatever carries line 050 fails,
    // however it is asked; its batch is halved once, and the half without it
    // is kept.
    const key = await seed('partial', docWith(100));
    const failing = deps({
      mock: mockTranslator((strings) =>
        strings.some((s) => s.startsWith('Line 050')) ? garbage() : spanish(strings, 0),
      ),
    });

    const first = await handleTranslatePost(post({ slug: 'partial', lang: 'es' }), failing);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ cached: false, partial: true });
    expect((await memoryRow(key))?.pending).toBe(20);

    const read = await get('partial');
    expect(await read.json()).toMatchObject({ partial: true });
    // About to change, so kept out of shared caches.
    expect(read.headers.get('cache-control')).toBe('no-store');

    const healthy = deps();
    const second = await handleTranslatePost(post({ slug: 'partial', lang: 'es' }), healthy);
    expect(second.status).toBe(200);
    expect((await second.json()).partial).toBeUndefined();
    const resent = healthy.mock.calls.flat();
    expect(resent).toHaveLength(20);
    expect(resent).toContain('Line 050 of the article');
    // Strings that failed before go in batches of five.
    expect(healthy.mock.calls.map((c) => c.length)).toEqual([5, 5, 5, 5]);
    expect(await memoryRow(key)).toMatchObject({ pending: 0, failures: {} });
    expect((await get('partial')).headers.get('cache-control')).toBe('public, max-age=300, s-maxage=86400');
  });

  it('keeps progress below the halfway line without showing it, and continues from there', async () => {
    // Only the first batch of 40 works: 40 of 100 is not enough to show.
    const key = await seed('progress', docWith(100));
    const mostlyFailing = deps({
      mock: mockTranslator((strings) => (strings.includes('Title of progress') ? spanish(strings, 0) : refusal(429))),
    });

    const first = await handleTranslatePost(post({ slug: 'progress', lang: 'es' }), mostlyFailing);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: 'in_progress', translated: 40, total: 100 });
    expect((await get('progress')).status).toBe(404);
    expect((await memoryRow(key))?.pending).toBe(60);
    expect(mostlyFailing.revalidated).toEqual([]);

    const healthy = deps();
    const second = await handleTranslatePost(post({ slug: 'progress', lang: 'es' }), healthy);
    expect(second.status).toBe(200);
    expect(healthy.mock.calls.flat()).toHaveLength(60);
    expect(healthy.mock.calls.flat()).not.toContain('Title of progress');
    expect((await get('progress')).status).toBe(200);
  });

  it('stops paying for a string that keeps failing, and answers from what is stored', async () => {
    // Ten strings; anything carrying line 005 comes back unusable, every time.
    const key = await seed('stubborn', docWith(10));
    const ip = freshIp();
    const failing = () =>
      deps({ mock: mockTranslator((strings) => (strings.some((s) => s.startsWith('Line 005')) ? garbage() : spanish(strings, 0))) });

    const first = await handleTranslatePost(post({ slug: 'stubborn', lang: 'es' }, { 'cf-connecting-ip': ip }), failing());
    expect(await first.json()).toMatchObject({ cached: false, partial: true });
    const second = await handleTranslatePost(post({ slug: 'stubborn', lang: 'es' }, { 'cf-connecting-ip': ip }), failing());
    expect(second.status).toBe(200);
    expect(await ipUnits(ip)).toBe(2);
    expect((await memoryRow(key))?.failures['Line 005 of the article']).toBe(2);

    // From here every public view is answered from the stored translation,
    // at no cost: the strings left have failed twice.
    let calls = 0;
    for (let i = 0; i < 6; i++) {
      const later = failing();
      const response = await handleTranslatePost(post({ slug: 'stubborn', lang: 'es' }, { 'cf-connecting-ip': ip }), later);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ cached: true, partial: true });
      calls += later.mock.calls.length;
    }
    expect(calls).toBe(0);
    expect(await ipUnits(ip)).toBe(2);
    expect(await (await get('stubborn')).json()).toMatchObject({ partial: true });

    // A password session still tries them, on its own allowance.
    const password = deps({ principal: PASSWORD, mock: failing().mock });
    await handleTranslatePost(post({ slug: 'stubborn', lang: 'es' }), password);
    expect(password.mock.calls.length).toBeGreaterThan(0);
  });

  it('holds nothing against strings whose request was abandoned at the hard stop', async () => {
    const key = await seed('hung', docWith(5));
    const hung = mockTranslator(
      (_s, _c, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const started = Date.now();
    const response = await handleTranslatePost(
      post({ slug: 'hung', lang: 'es' }),
      deps({ mock: hung, translate: { candidates: hung.candidates, pacer: instantPacer(), signal: AbortSignal.timeout(100) } }),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.status).toBe(503);
    expect(await memoryRow(key)).toMatchObject({ failures: {}, pending: 5 });
  });
});

describe('POST: refreshing a stale translation (BWR-20)', () => {
  it('re-translates only the strings that changed', async () => {
    const original = docWith(5);
    const key = await seed('refresh', original);
    await handleTranslatePost(post({ slug: 'refresh', lang: 'es' }), deps());

    const edited = structuredClone(original);
    const list = edited.blocks[0];
    if (list?.kind !== 'list') throw new Error('expected a list');
    list.items[1] = 'A sentence the wiki rewrote';
    await upsertArticle(handle.db, {
      pageKey: key,
      source: 'fandom',
      title: 'Title of refresh',
      slug: 'refresh',
      url: 'https://example.test/refresh',
      categories: [],
      doc: edited,
    });
    await handle.db.execute(sql`UPDATE articles SET updated_at = updated_at + interval '1 minute' WHERE slug = 'refresh'`);

    const stale = await get('refresh');
    expect(await stale.json()).toMatchObject({ stale: true });
    expect(stale.headers.get('cache-control')).toBe('no-store');

    const d = deps();
    const response = await handleTranslatePost(post({ slug: 'refresh', lang: 'es' }), d);
    expect(response.status).toBe(200);
    expect(d.mock.calls.flat()).toEqual(['A sentence the wiki rewrote']);
    expect(d.revalidated).toEqual(['article:refresh']);

    const fresh = await (await get('refresh')).json();
    expect(fresh.stale).toBeUndefined();
    expect(fresh.doc.blocks[0].items[1]).toBe('ES:A sentence the wiki rewrote');
  });

  it('brings an article that a re-index rewrote unchanged up to date without a model or an allowance', async () => {
    await seed('reindexed', docWith(5));
    const ip = freshIp();
    await handleTranslatePost(post({ slug: 'reindexed', lang: 'es' }, { 'cf-connecting-ip': ip }), deps());
    await handle.db.execute(sql`UPDATE articles SET updated_at = updated_at + interval '1 minute' WHERE slug = 'reindexed'`);
    expect(await (await get('reindexed')).json()).toMatchObject({ stale: true });

    const d = deps();
    const response = await handleTranslatePost(post({ slug: 'reindexed', lang: 'es' }, { 'cf-connecting-ip': ip }), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cached: false, model: 'mock/translator' });
    expect(d.mock.calls).toHaveLength(0);
    expect(await ipUnits(ip)).toBe(1);
    expect((await (await get('reindexed')).json()).stale).toBeUndefined();
  });

  it('stamps a translation with the article version exactly, microseconds included', async () => {
    await seed('precise', docWith(5));
    await handle.db.execute(
      sql`UPDATE articles SET updated_at = '2026-10-26 12:00:00.123456+00' WHERE slug = 'precise'`,
    );
    await handleTranslatePost(post({ slug: 'precise', lang: 'es' }), deps());
    // A millisecond Date would stamp .123 < .123456: stale the moment it was saved.
    expect((await (await get('precise')).json()).stale).toBeUndefined();
  });
});

describe('POST: providers that answer nothing (IT-2, IT-5)', () => {
  const globalUnits = () => quotaCount('translate:public-global|86400000');

  /** A reader's requests on a clock the test moves, against `mock`. */
  const on = (mock: ReturnType<typeof mockTranslator>, now: () => number) =>
    deps({ mock, translate: { candidates: mock.candidates, pacer: instantPacer(), now } });

  it('holds an outage against no string, and translates once the providers are back', async () => {
    // Two public views during a 503 outage used to leave every string stuck
    // for public readers, for good.
    const key = await seed('outage', docWith(8));
    const ip = freshIp();
    let clock = Date.now();
    const down = mockTranslator(() => unavailable(503));

    for (let view = 0; view < 2; view++) {
      const response = await handleTranslatePost(post({ slug: 'outage', lang: 'es' }, { 'cf-connecting-ip': ip }), on(down, () => clock));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'translation_failed' });
    }
    // The second view was answered without asking the providers again.
    expect(down.calls).toHaveLength(1);
    expect(await memoryRow(key)).toMatchObject({ entries: {}, failures: {} });
    expect(await ipUnits(ip)).toBe(0);

    clock += 61_000;
    const healthy = mockTranslator();
    const back = await handleTranslatePost(post({ slug: 'outage', lang: 'es' }, { 'cf-connecting-ip': ip }), on(healthy, () => clock));
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ cached: false });
    expect(healthy.calls.flat()).toHaveLength(8);
    expect(await ipUnits(ip)).toBe(1);
  });

  it('gives back every unit the refusing providers did no work for, and asks them again only after a minute', async () => {
    for (const slug of ['refused-a', 'refused-b', 'refused-c']) await seed(slug, docWith(5));
    const ip = freshIp();
    let clock = Date.now();
    const refusing = mockTranslator(() => refusal(429));
    const before = await globalUnits();

    for (const slug of ['refused-a', 'refused-b', 'refused-c']) {
      const response = await handleTranslatePost(post({ slug, lang: 'es' }, { 'cf-connecting-ip': ip }), on(refusing, () => clock));
      expect(response.status).toBe(503);
    }
    expect(refusing.calls).toHaveLength(1);
    expect(await ipUnits(ip)).toBe(0);
    expect(await globalUnits()).toBe(before);

    clock += 61_000;
    const healthy = mockTranslator();
    const after = await handleTranslatePost(post({ slug: 'refused-b', lang: 'es' }, { 'cf-connecting-ip': ip }), on(healthy, () => clock));
    expect(after.status).toBe(200);
    expect(await ipUnits(ip)).toBe(1);
  });

  it('keeps the unit of a run a provider did answer, if uselessly, and turns no one away after it', async () => {
    await seed('answered-badly', docWith(10));
    const ip = freshIp();
    // A reply in prose, then a refusal for the first half of it.
    const mock = mockTranslator((_strings, call) => (call === 0 ? garbage() : refusal(429)));
    const response = await handleTranslatePost(post({ slug: 'answered-badly', lang: 'es' }, { 'cf-connecting-ip': ip }), deps({ mock }));
    expect(response.status).toBe(503);
    expect(await ipUnits(ip)).toBe(1);

    const next = deps();
    const again = await handleTranslatePost(post({ slug: 'answered-badly', lang: 'es' }, { 'cf-connecting-ip': ip }), next);
    expect(again.status).toBe(200);
    expect(next.mock.calls.length).toBeGreaterThan(0);
  });

  it('gives the unit back in the window it was counted in, though the run ends in the next one', async () => {
    await seed('window-edge', docWith(5));
    const ip = freshIp();
    const hour = 3_600_000;
    let clock = Math.floor(Date.now() / hour) * hour + hour - 100;
    const refusing = mockTranslator(() => {
      clock += 1_000;
      return refusal(429);
    });
    const response = await handleTranslatePost(
      post({ slug: 'window-edge', lang: 'es' }, { 'cf-connecting-ip': ip }),
      on(refusing, () => clock),
    );
    expect(response.status).toBe(503);
    const rows = await rawQuery<{ count: number }>(
      handle.db,
      sql`SELECT count FROM rate_limits WHERE key = ${`translate:public-ip:${ip}|3600000`}`,
    );
    // One row, the hour it was counted in, given back; nothing taken from the next hour.
    expect(rows.map((r) => Number(r.count))).toEqual([0]);
  });

  it('answers as usual when the unit cannot be given back', async () => {
    await seed('refund-fails', docWith(5));
    const refusing = mockTranslator(() => refusal(429));
    const response = await handleTranslatePost(
      post({ slug: 'refund-fails', lang: 'es' }),
      deps({
        mock: refusing,
        refundQuota: async () => {
          throw new Error('connection reset');
        },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'translation_failed' });
  });

  it('spends nothing on a deployment with no model key configured', async () => {
    await seed('no-key', docWith(5));
    const ip = freshIp();
    const response = await handleTranslatePost(
      post({ slug: 'no-key', lang: 'es' }, { 'cf-connecting-ip': ip }),
      deps({
        translate: {
          candidates: () => {
            throw new Error('No model provider configured.');
          },
          pacer: instantPacer(),
        },
      }),
    );
    expect(response.status).toBe(503);
    expect(await ipUnits(ip)).toBe(0);
  });

  it('pauses no one for a string too long to write in time, which is held against that string', async () => {
    const long = 'A changelog entry far longer than any reply can be written in time. '.repeat(40);
    const key = await seed('too-long', { ...docWith(1), lead: long });
    await seed('after-too-long', docWith(5));
    const ip = freshIp();
    // Every provider runs out of time on whatever carries the long lead.
    const slowOnLong = () =>
      mockTranslator((strings) => (strings.includes(long) ? new ResponseTimeoutError(25_000) : spanish(strings, 0)));

    const first = await handleTranslatePost(post({ slug: 'too-long', lang: 'es' }, { 'cf-connecting-ip': ip }), deps({ mock: slowOnLong() }));
    expect(await first.json()).toMatchObject({ cached: false, partial: true });
    // Only the long lead is left, and it runs out of time again.
    const second = await handleTranslatePost(post({ slug: 'too-long', lang: 'es' }, { 'cf-connecting-ip': ip }), deps({ mock: slowOnLong() }));
    expect(await second.json()).toMatchObject({ cached: true, partial: true });
    expect(await memoryRow(key)).toMatchObject({ failures: { [long]: 2 } });
    // Nothing was produced the second time, so its unit went back...
    expect(await ipUnits(ip)).toBe(1);
    // ...and the providers are not taken for down: the next article is asked for at once.
    const next = deps();
    expect((await handleTranslatePost(post({ slug: 'after-too-long', lang: 'es' }, { 'cf-connecting-ip': ip }), next)).status).toBe(200);
    expect(next.mock.calls.length).toBeGreaterThan(0);
  });

  it('serves what is stored while the providers are down, rather than a failure', async () => {
    // Most of the article is translated and shown; the rest waits.
    await seed('down-partial', docWith(100));
    const ip = freshIp();
    const clock = Date.now();
    const halfway = mockTranslator((strings) => (strings.some((s) => s.startsWith('Line 050')) ? garbage() : spanish(strings, 0)));
    expect((await handleTranslatePost(post({ slug: 'down-partial', lang: 'es' }, { 'cf-connecting-ip': ip }), on(halfway, () => clock))).status).toBe(200);

    const down = mockTranslator(() => unavailable(503));
    const first = await handleTranslatePost(post({ slug: 'down-partial', lang: 'es' }, { 'cf-connecting-ip': ip }), on(down, () => clock));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ cached: true, partial: true });
    // Two requests unanswered in a row end the run.
    expect(down.calls).toHaveLength(2);

    const second = await handleTranslatePost(post({ slug: 'down-partial', lang: 'es' }, { 'cf-connecting-ip': ip }), on(down, () => clock));
    expect(await second.json()).toMatchObject({ cached: true, partial: true });
    expect(down.calls).toHaveLength(2);
  });
});

describe('POST: a remembered refusal over a stale translation (IT-6)', () => {
  const env = { PUBLIC_TRANSLATIONS_PER_DAY: '1000', PUBLIC_TRANSLATIONS_PER_IP_PER_HOUR: '1' };

  /** Translates `slug` with this reader's one unit for the hour, then has `other` refused and remembered. */
  async function translateThenSpend(slug: string, other: string, ip: string): Promise<void> {
    expect((await handleTranslatePost(post({ slug, lang: 'es' }, { 'cf-connecting-ip': ip }), deps({ env }))).status).toBe(200);
    expect((await handleTranslatePost(post({ slug: other, lang: 'es' }, { 'cf-connecting-ip': ip }), deps({ env }))).status).toBe(429);
  }

  it('still brings up to date, at no cost, a translation its memory fully covers', async () => {
    await seed('known-stale', docWith(5));
    await seed('known-stale-other', docWith(5));
    const ip = freshIp();
    await translateThenSpend('known-stale', 'known-stale-other', ip);
    const units = await ipUnits(ip);
    // A re-index rewrote the article without changing a word a reader sees.
    await handle.db.execute(sql`UPDATE articles SET updated_at = updated_at + interval '1 minute' WHERE slug = 'known-stale'`);

    const d = deps({ env });
    const response = await handleTranslatePost(post({ slug: 'known-stale', lang: 'es' }, { 'cf-connecting-ip': ip }), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cached: false });
    expect(d.mock.calls).toHaveLength(0);
    expect(await ipUnits(ip)).toBe(units);
    expect((await (await get('known-stale')).json()).stale).toBeUndefined();
  });

  it('refuses a refresh that needs a model with two reads and no write', async () => {
    const key = await seed('known-edited', docWith(5));
    await seed('known-edited-other', docWith(5));
    const ip = freshIp();
    await translateThenSpend('known-edited', 'known-edited-other', ip);

    const edited = docWith(5);
    const list = edited.blocks[0];
    if (list?.kind !== 'list') throw new Error('expected a list');
    list.items[1] = 'A sentence the wiki rewrote';
    await upsertArticle(handle.db, {
      pageKey: key,
      source: 'fandom',
      title: 'Title of known-edited',
      slug: 'known-edited',
      url: 'https://example.test/known-edited',
      categories: [],
      doc: edited,
    });
    await handle.db.execute(sql`UPDATE articles SET updated_at = updated_at + interval '1 minute' WHERE slug = 'known-edited'`);
    const units = await ipUnits(ip);

    const { db, statements } = counting(handle.db);
    const d = deps({ env, db: async () => db });
    const response = await handleTranslatePost(post({ slug: 'known-edited', lang: 'es' }, { 'cf-connecting-ip': ip }), d);
    expect(response.status).toBe(429);
    // What is shown, then the article and its memory: no lease, no counter.
    expect(statements()).toBe(2);
    expect(d.mock.calls).toHaveLength(0);
    expect(await ipUnits(ip)).toBe(units);
  });
});

describe('POST: image captions', () => {
  it('translates them, stores them with the translation, and serves them', async () => {
    const doc: ArticleDoc = {
      ...docWith(3),
      images: [
        { url: 'https://example.test/one.png', alt: 'One.png', caption: 'A boar in the rain' },
        { url: 'https://example.test/two.png', alt: 'Two.png' },
      ],
    };
    await seed('captioned', doc);
    const response = await handleTranslatePost(post({ slug: 'captioned', lang: 'es' }), deps());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.doc.images.map((i: { caption?: string }) => i.caption)).toEqual(['ES:A boar in the rain', undefined]);

    const read = await (await get('captioned')).json();
    expect(read.doc.images[0].caption).toBe('ES:A boar in the rain');
    expect(read.doc.images[0].url).toBe('https://example.test/one.png');
    expect(await readTranslatedCaptions(handle.db, 'captioned', 'es')).toEqual({
      'https://example.test/one.png': 'ES:A boar in the rain',
    });
  });
});

describe('without a memory this role may write (drizzle/0009 applied, never granted)', () => {
  beforeAll(async () => {
    // The production shape: the app's least-privilege role has the tables it
    // had before 0009, and the memory table is the owner's.
    await handle.db.execute(sql`CREATE ROLE route_app NOLOGIN`);
    await handle.db.execute(sql`GRANT SELECT ON pages, articles TO route_app`);
    await handle.db.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON article_translations, rate_limits TO route_app`);
  });

  async function asApp<T>(work: () => Promise<T>): Promise<T> {
    await handle.db.execute(sql`SET ROLE route_app`);
    try {
      return await work();
    } finally {
      await handle.db.execute(sql`RESET ROLE`);
    }
  }

  it('refuses an article too long for one request before spending anything', async () => {
    await seed('nm-long', docWith(400));
    const ip = freshIp();
    const d = deps();
    const response = await asApp(() => handleTranslatePost(post({ slug: 'nm-long', lang: 'es' }, { 'cf-connecting-ip': ip }), d));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'translation_unavailable' });
    expect(d.mock.calls).toHaveLength(0);
    expect(await ipUnits(ip)).toBe(0);
  });

  it('translates a short article whole, and shows it as complete', async () => {
    await seed('nm-short', docWith(5));
    const response = await asApp(() => handleTranslatePost(post({ slug: 'nm-short', lang: 'es' }), deps()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cached: false });
    const read = await get('nm-short');
    expect(read.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=86400');
  });

  it('never shows a partial translation it cannot record as partial, and stops paying for it', async () => {
    await seed('nm-partial', docWith(10));
    const ip = freshIp();
    const failing = () =>
      deps({ mock: mockTranslator((strings) => (strings.some((s) => s.startsWith('Line 005')) ? garbage() : spanish(strings, 0))) });

    const first = await asApp(() => handleTranslatePost(post({ slug: 'nm-partial', lang: 'es' }, { 'cf-connecting-ip': ip }), failing()));
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: 'translation_failed' });
    expect((await get('nm-partial')).status).toBe(404);
    expect(await ipUnits(ip)).toBe(1);

    // Nothing records what failed, so the article rests for a while instead
    // of costing every public view the whole article again.
    const again = failing();
    const second = await asApp(() => handleTranslatePost(post({ slug: 'nm-partial', lang: 'es' }, { 'cf-connecting-ip': ip }), again));
    expect(second.status).toBe(503);
    expect(again.mock.calls).toHaveLength(0);
    expect(await ipUnits(ip)).toBe(1);

    // A password session may still try.
    const password = deps({ principal: PASSWORD, mock: failing().mock });
    await asApp(() => handleTranslatePost(post({ slug: 'nm-partial', lang: 'es' }), password));
    expect(password.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('without the memory table (a deploy that skipped migrations)', () => {
  it('keeps reading and translating, and puts the table back on the next write', async () => {
    await seed('no-memory-old', docWith(5));
    await handleTranslatePost(post({ slug: 'no-memory-old', lang: 'es' }), deps());
    await seed('no-memory-new', docWith(5));

    await handle.db.execute(sql`DROP TABLE article_translation_memory`);

    const read = await get('no-memory-old');
    expect(read.status).toBe(200);

    const created = await handleTranslatePost(post({ slug: 'no-memory-new', lang: 'es' }), deps());
    expect(created.status).toBe(200);

    const tables = await rawQuery<{ tablename: string }>(
      handle.db,
      sql`SELECT tablename FROM pg_tables WHERE tablename = 'article_translation_memory'`,
    );
    expect(tables).toHaveLength(1);
  });
});
