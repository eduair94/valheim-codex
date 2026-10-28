import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@/lib/db/create-db';
import { createTestDb } from '../helpers/db';
import { seedSearchCorpus } from '../helpers/search-seed';

const state = vi.hoisted(() => {
  // Read when the route module loads: a small ceiling, so the test can reach it.
  process.env.WIKI_SEARCH_PER_MINUTE = '5';
  return { db: null as unknown, failVocabulary: false };
});

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) =>
      JSON.parse(JSON.stringify(await fn(...args))) as unknown,
}));
vi.mock('@/lib/db/client', () => ({
  getDb: async () => {
    if (state.failVocabulary) throw new Error('database unavailable');
    return state.db;
  },
}));

const search = await import('@/app/api/wiki/search/route');
const titles = await import('@/app/api/wiki/index/route');

const get = (path: string) => new Request(`http://localhost${path}`);

describe('wiki search routes', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
    await seedSearchCorpus(handle.db);
    state.db = handle.db;
  }, 180_000);

  afterAll(async () => {
    delete process.env.WIKI_SEARCH_PER_MINUTE;
    await handle?.close();
  });

  describe('GET /api/wiki/search', () => {
    it('answers a Spanish query with Spanish names, cacheably', async () => {
      const response = await search.GET(get('/api/wiki/search?q=hierro&lang=es'));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('public');
      const body = (await response.json()) as { hits: { slug: string; name?: string }[] };
      expect(body.hits[0]).toEqual(expect.objectContaining({ slug: 'iron', name: 'Hierro' }));
    });

    it('defaults to Spanish, the reader default, when no language is given', async () => {
      const body = (await (await search.GET(get('/api/wiki/search?q=cardo'))).json()) as { hits: { slug: string }[] };
      expect(body.hits.map((h) => h.slug)).toEqual(['thistle']);
    });

    it('folds accents in the query', async () => {
      const body = (await (await search.GET(get('/api/wiki/search?q=jormundling&lang=en'))).json()) as {
        hits: { slug: string; snippet: string }[];
      };
      expect(body.hits[0]!.slug).toBe('jormundling');
      expect(body.hits[0]!.snippet).toContain('«Jörmundling»');
    });

    it('is a 400, not a 500, for a control character or an unknown language', async () => {
      const nul = await search.GET(get('/api/wiki/search?q=%00'));
      expect(nul.status).toBe(400);
      expect(await nul.json()).toEqual({ error: 'invalid_query' });
      expect(nul.headers.get('cache-control')).toBe('no-store');

      const lang = await search.GET(get('/api/wiki/search?q=hierro&lang=fr'));
      expect(lang.status).toBe(400);
      expect(await lang.json()).toEqual({ error: 'invalid_lang' });
    });

    it('survives malformed percent-encoding and operators', async () => {
      for (const q of ['%E0%A4%A', '%27%22%5C%26%7C', 'a'.repeat(5000)]) {
        const response = await search.GET(get(`/api/wiki/search?q=${q}`));
        expect(response.status).toBe(200);
      }
    });

    it('answers an empty or stop-word query with no hits', async () => {
      expect(await (await search.GET(get('/api/wiki/search?q=%20%20'))).json()).toEqual({ hits: [] });
      expect(await (await search.GET(get('/api/wiki/search?q=de%20la'))).json()).toEqual({ hits: [] });
    });

    it('turns away an address searching faster than anyone types, with Retry-After', async () => {
      const from = (ip: string) =>
        new Request('http://localhost/api/wiki/search?q=hierro', { headers: { 'cf-connecting-ip': ip } });
      for (let i = 0; i < 5; i += 1) expect((await search.GET(from('203.0.113.9'))).status).toBe(200);
      const refused = await search.GET(from('203.0.113.9'));
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: 'rate_limited', retryAfter: expect.any(Number) });
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(refused.headers.get('cache-control')).toBe('no-store');
      // Someone else is unaffected, and so is an empty query, which costs nothing.
      expect((await search.GET(from('198.51.100.4'))).status).toBe(200);
      expect((await search.GET(new Request('http://localhost/api/wiki/search?q=', { headers: { 'cf-connecting-ip': '203.0.113.9' } }))).status).toBe(200);
    });

    it('reports a database failure as one, without caching it', async () => {
      state.failVocabulary = true;
      try {
        const response = await search.GET(get('/api/wiki/search?q=hierro'));
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'search_failed' });
        expect(response.headers.get('cache-control')).toBe('no-store');
      } finally {
        state.failVocabulary = false;
      }
    });
  });

  describe('GET /api/wiki/index', () => {
    it('serves the bilingual index at v=2', async () => {
      const response = await titles.GET(get('/api/wiki/index?v=2'));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('s-maxage=86400');
      const { entries } = (await response.json()) as { entries: { s: string; e?: string; i?: string }[] };
      const sword = entries.find((e) => e.s === 'iron-sword')!;
      expect(sword.e).toBe('Espada de hierro');
      expect(sword.i).not.toMatch(/^https?:/);
    });

    it('keeps the original shape without v, for the previous build', async () => {
      const { entries } = (await (await titles.GET(get('/api/wiki/index'))).json()) as {
        entries: { s: string; e?: string; i?: string }[];
      };
      const sword = entries.find((e) => e.s === 'iron-sword')!;
      expect(sword.e).toBeUndefined();
      expect(sword.i).toMatch(/^https:\/\//);
    });
  });
});
