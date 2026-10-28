import { describe, expect, it, vi } from 'vitest';
import type { ChatPrincipal } from '@/lib/auth/principal';
import {
  BASELINE_CONTENT_SECURITY_POLICY,
  contentSecurityPolicy,
  contentSecurityPolicyHeaders,
  contentSecurityPolicyMode,
  decideProxy,
  MAX_API_BODY_BYTES,
  permanentWikiRedirect,
  type ProxyInput,
} from '@/lib/auth/proxy-policy';
import { categoryFromParam, facetQuery, parseCategoryQuery, ALL_CATEGORIES } from '@/lib/routes';
import { config as proxyConfig } from '@/proxy';

const PASSWORD: ChatPrincipal = { kind: 'password', profile: 'Ragnar' };
const BYOK: ChatPrincipal = {
  kind: 'byok',
  profile: 'byok:6f1c2a10-1234-4abc-9def-0123456789ab',
  apiKey: 'AIzaSyTESTTESTTESTTESTTESTTESTTEST1234',
  model: 'gemini-3.5-flash-lite',
};
const PUTER: ChatPrincipal = { kind: 'puter', profile: 'puter:6f1c2a10-1234-4abc-9def-0123456789ab', name: 'ana' };

function input(
  url: string,
  options: { method?: string; headers?: Record<string, string>; principal?: ChatPrincipal | null } = {},
): ProxyInput & { principal: ReturnType<typeof vi.fn> } {
  const parsed = new URL(url, 'http://localhost:3100');
  return {
    method: options.method ?? 'GET',
    pathname: parsed.pathname,
    search: parsed.search,
    searchParams: parsed.searchParams,
    headers: new Headers(options.headers ?? {}),
    principal: vi.fn(async () => options.principal ?? null),
  };
}

describe('decideProxy', () => {
  describe('cross-site writes to the API', () => {
    it('refuses a forged POST from another site, signed in or not', async () => {
      const forgeries: Record<string, string>[] = [
        { origin: 'https://evil.example', 'content-type': 'text/plain' },
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'same-site', origin: 'https://www.digitalshopuy.com' },
      ];
      for (const headers of forgeries) {
        for (const path of ['/api/auth/logout', '/api/auth/login', '/api/chat', '/api/wiki/translate']) {
          expect(await decideProxy(input(path, { method: 'POST', headers, principal: PASSWORD }))).toEqual({
            action: 'json',
            status: 403,
            body: { error: 'forbidden_origin' },
          });
        }
      }
    });

    it('lets same-origin requests and non-browser clients through to the handler', async () => {
      const sameOrigin = await decideProxy(
        input('/api/auth/login', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }),
      );
      expect(sameOrigin).toEqual({ action: 'next', page: false });
      // curl and test runners send neither header, and carry no victim's cookies.
      expect(await decideProxy(input('/api/auth/logout', { method: 'POST' }))).toEqual({ action: 'next', page: false });
    });

    it('checks DELETE and PATCH too, but never reads', async () => {
      const foreign = { origin: 'https://evil.example' };
      expect(await decideProxy(input('/api/auth/byok', { method: 'DELETE', headers: foreign }))).toMatchObject({ status: 403 });
      expect(await decideProxy(input('/api/auth/byok', { method: 'PATCH', headers: foreign }))).toMatchObject({ status: 403 });
      expect(await decideProxy(input('/api/auth/session', { headers: foreign }))).toEqual({ action: 'next', page: false });
    });

    it('takes violation reports from Safari before 16.4, which send Origin: null and no Sec-Fetch-Site', async () => {
      const oldSafari = { origin: 'null', 'content-type': 'application/csp-report' };
      expect(await decideProxy(input('/api/csp-report', { method: 'POST', headers: oldSafari }))).toEqual({
        action: 'next',
        page: false,
      });
      // Current WebKit sends the same Origin plus the header that vouches for it.
      expect(
        await decideProxy(input('/api/csp-report', { method: 'POST', headers: { ...oldSafari, 'sec-fetch-site': 'same-origin' } })),
      ).toEqual({ action: 'next', page: false });
    });

    it('keeps that exception to the report path and to that shape', async () => {
      const oldSafari = { origin: 'null', 'content-type': 'application/csp-report' };
      for (const path of ['/api/auth/logout', '/api/auth/login', '/api/chat', '/api/csp-report/x', '/api/csp-report2']) {
        expect(await decideProxy(input(path, { method: 'POST', headers: oldSafari, principal: PASSWORD })), path).toMatchObject({
          status: 403,
        });
      }
      // Another site pointing its own report-uri here: a modern browser says so.
      for (const headers of [
        { ...oldSafari, 'sec-fetch-site': 'cross-site' },
        { ...oldSafari, 'sec-fetch-site': 'same-site' },
        { origin: 'https://evil.example', 'content-type': 'application/csp-report' },
      ]) {
        expect(await decideProxy(input('/api/csp-report', { method: 'POST', headers }))).toEqual({
          action: 'json',
          status: 403,
          body: { error: 'forbidden_origin' },
        });
      }
      // And the size ceiling still holds for it.
      expect(
        await decideProxy(
          input('/api/csp-report', { method: 'POST', headers: { ...oldSafari, 'content-length': String(MAX_API_BODY_BYTES + 1) } }),
        ),
      ).toEqual({ action: 'json', status: 413, body: { error: 'payload_too_large' } });
    });

    it('refuses a declared body over the ceiling before any handler reads it', async () => {
      const big = await decideProxy(
        input('/api/wiki/translate', { method: 'POST', headers: { 'content-length': String(MAX_API_BODY_BYTES + 1) } }),
      );
      expect(big).toEqual({ action: 'json', status: 413, body: { error: 'payload_too_large' } });
      const fits = await decideProxy(
        input('/api/wiki/translate', { method: 'POST', headers: { 'content-length': String(MAX_API_BODY_BYTES) } }),
      );
      expect(fits).toEqual({ action: 'next', page: false });
    });
  });

  describe('malformed paths', () => {
    it('answers broken percent-encoding with a 400 instead of a crash', async () => {
      expect(await decideProxy(input('/wiki/a/%E0%A4%A'))).toEqual({ action: 'text', status: 400, body: 'Bad Request' });
      expect(await decideProxy(input('/api/conversations/%C0'))).toEqual({
        action: 'json',
        status: 400,
        body: { error: 'bad_request' },
      });
    });
  });

  describe('public surface', () => {
    it('serves the reader and its API without looking at cookies', async () => {
      for (const path of ['/wiki', '/wiki/a/iron-sword', '/robots.txt', '/sitemap.xml']) {
        const request = input(path);
        expect(await decideProxy(request)).toEqual({ action: 'next', page: true });
        expect(request.principal).not.toHaveBeenCalled();
      }
      expect(await decideProxy(input('/api/wiki/search?q=hierro'))).toEqual({ action: 'next', page: false });
    });
  });

  describe('the connect page', () => {
    it('shows itself to a visitor who is not signed in', async () => {
      expect(await decideProxy(input('/login?next=%2F%3Fabout%3DIron%2520Sword'))).toEqual({ action: 'next', page: true });
      expect(await decideProxy(input('/login'))).toEqual({ action: 'next', page: true });
      expect(await decideProxy(input('/login?next=%2F'))).toEqual({ action: 'next', page: true });
      expect(await decideProxy(input('/login?next=%2Fwiki%2Fa%2Firon-sword&switch=1'))).toEqual({
        action: 'next',
        page: true,
      });
    });

    it('replaces a foreign destination before the page can follow it, signed in or not', async () => {
      // The form follows `next` after signing in; it used to check only startsWith('/').
      for (const next of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/.//evil.example', 'https://evil.example', '']) {
        expect(await decideProxy(input(`/login?next=${encodeURIComponent(next)}`)), next).toEqual({
          action: 'redirect',
          location: '/login',
        });
      }
      // Everything else on the URL stays, `switch` included.
      expect(await decideProxy(input('/login?switch=1&next=%2F%2Fevil.example', { principal: BYOK }))).toEqual({
        action: 'redirect',
        location: '/login?switch=1',
      });
      // Repeated: neither value is trusted.
      expect(await decideProxy(input('/login?next=%2Fa&next=%2Fb'))).toEqual({ action: 'redirect', location: '/login' });
      // A destination the parser only tidies keeps its meaning, in its tidied form.
      expect(await decideProxy(input('/login?next=%2Fwiki%2F..%2Fwiki%2Fbrowse'))).toEqual({
        action: 'redirect',
        location: '/login?next=%2Fwiki%2Fbrowse',
      });
    });

    it('lets nothing foreign through and never loops, over a few thousand tricky destinations', async () => {
      // Deterministic: a small linear congruential generator over the characters URL parsing is subtle about.
      const alphabet = ['/', '\\', '.', '%', '2', 'e', 'E', 'f', '5', 'C', '\t', '\n', ':', '?', '#', 'a', ' ', '@', '/'];
      let seed = 42;
      const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      for (let n = 0; n < 4000; n++) {
        const length = 1 + Math.floor(random() * 9);
        const next = `/${Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')}`;
        let decision = await decideProxy(input(`/login?next=${encodeURIComponent(next)}`));
        if (decision.action === 'redirect') {
          decision = await decideProxy(input(decision.location));
          expect(decision, `loop for ${JSON.stringify(next)}`).toEqual({ action: 'next', page: true });
        }
      }
      // And whatever reached the page resolves on this site.
      seed = 42;
      for (let n = 0; n < 4000; n++) {
        const length = 1 + Math.floor(random() * 9);
        const next = `/${Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')}`;
        const asked = `/login?next=${encodeURIComponent(next)}`;
        const decision = await decideProxy(input(asked));
        const served = new URL(decision.action === 'redirect' ? decision.location : asked, 'https://x.invalid');
        const target = served.searchParams.get('next');
        if (target === null) continue;
        const resolved = new URL(target, 'https://site.invalid');
        expect(resolved.origin, JSON.stringify(next)).toBe('https://site.invalid');
        expect(target.startsWith('//') || target.startsWith('/\\'), JSON.stringify(next)).toBe(false);
      }
    });

    it('never loops: the page it redirects to passes the same check', async () => {
      const hostile = ['//evil.example', '/./%2e%2e//evil', '/a/..//evil', '/wiki/a/hacha de bronce?q=á', '/%2e//x', '/./\\x'];
      for (const next of hostile) {
        const first = await decideProxy(input(`/login?next=${encodeURIComponent(next)}`));
        if (first.action !== 'redirect') continue;
        expect(await decideProxy(input(first.location)), next).toEqual({ action: 'next', page: true });
      }
    });

    it('sends anyone already signed in, by any method, on to where they were going', async () => {
      for (const principal of [PASSWORD, BYOK, PUTER]) {
        expect(await decideProxy(input('/login?next=%2F%3Fabout%3DIron%2520Sword', { principal }))).toEqual({
          action: 'redirect',
          location: '/?about=Iron%20Sword',
        });
        expect(await decideProxy(input('/login', { principal }))).toEqual({ action: 'redirect', location: '/' });
      }
    });

    it('stays put when the visitor came to change how they are signed in', async () => {
      expect(await decideProxy(input('/login?switch=1&next=%2F', { principal: BYOK }))).toEqual({
        action: 'next',
        page: true,
      });
    });

    it('never redirects off the site, whatever `next` says', async () => {
      for (const next of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/.//evil.example', 'https://evil.example']) {
        const decision = await decideProxy(input(`/login?next=${encodeURIComponent(next)}`, { principal: PASSWORD }));
        expect(decision).toEqual({ action: 'redirect', location: '/' });
      }
      // An encoded backslash stays encoded: a path on this site, not a host.
      expect(await decideProxy(input('/login?next=%2F%255Cevil.example', { principal: PASSWORD }))).toEqual({
        action: 'redirect',
        location: '/%5Cevil.example',
      });
      // Repeated: arrives as two values, and neither is trusted.
      expect(await decideProxy(input('/login?next=%2Fa&next=%2Fb', { principal: PASSWORD }))).toEqual({
        action: 'redirect',
        location: '/',
      });
    });
  });

  describe('the chat', () => {
    it('opens to every kind of sign-in', async () => {
      for (const principal of [PASSWORD, BYOK, PUTER]) {
        expect(await decideProxy(input('/', { principal }))).toEqual({ action: 'next', page: true });
        expect(await decideProxy(input('/?about=Iron%20Sword', { principal }))).toEqual({ action: 'next', page: true });
        for (const path of ['/api/chat', '/api/chat/prepare', '/api/chat/complete', '/api/conversations', '/api/conversations/x']) {
          expect(await decideProxy(input(path, { method: 'GET', principal }))).toEqual({ action: 'next', page: false });
        }
      }
    });

    it('opens the reader to a stranger who typed the bare domain', async () => {
      expect(await decideProxy(input('/'))).toEqual({ action: 'redirect', location: '/wiki' });
    });

    it('opens the reader, not the sign-in, for a shared link with tracking parameters', async () => {
      // Facebook adds fbclid to every outbound link; campaigns add utm_* and gclid.
      for (const url of ['/?fbclid=abc123', '/?utm_source=x&utm_medium=social', '/?gclid=1', '/?ref=reddit']) {
        expect(await decideProxy(input(url)), url).toEqual({ action: 'redirect', location: '/wiki' });
      }
    });

    it('keeps a question that arrives with tracking parameters', async () => {
      expect(await decideProxy(input('/?about=Iron%20Sword&utm_source=x'))).toEqual({
        action: 'redirect',
        location: '/login?next=%2F%3Fabout%3DIron%2520Sword%26utm_source%3Dx',
      });
    });

    it('keeps the question when a stranger follows "Ask about this"', async () => {
      // Used to land on /wiki with the article's title dropped.
      expect(await decideProxy(input('/?about=Iron%20Sword'))).toEqual({
        action: 'redirect',
        location: '/login?next=%2F%3Fabout%3DIron%2520Sword',
      });
    });

    it('sends a signed-out reload of a conversation to sign in and back to it', async () => {
      // The chat keeps the thread in the address as `/?c=<id>`; it used to land on /wiki.
      expect(await decideProxy(input('/?c=2b0c1f6e-9a8d-4c3b-8e7f-1a2b3c4d5e6f'))).toEqual({
        action: 'redirect',
        location: '/login?next=%2F%3Fc%3D2b0c1f6e-9a8d-4c3b-8e7f-1a2b3c4d5e6f',
      });
      // Signed in, the chat opens it.
      expect(await decideProxy(input('/?c=abc', { principal: PUTER }))).toEqual({ action: 'next', page: true });
      // And once signed in, the connect page sends the reader on to it.
      expect(await decideProxy(input('/login?next=%2F%3Fc%3Dabc', { principal: BYOK }))).toEqual({
        action: 'redirect',
        location: '/?c=abc',
      });
    });

    it('sends a stranger to sign in for any other gated page', async () => {
      expect(await decideProxy(input('/random-junk?x=1'))).toEqual({
        action: 'redirect',
        location: '/login?next=%2Frandom-junk%3Fx%3D1',
      });
    });

    it('answers the API with status codes, never a redirect', async () => {
      for (const path of ['/api/chat', '/api/conversations', '/api/ingest']) {
        expect(await decideProxy(input(path))).toEqual({ action: 'json', status: 401, body: { error: 'unauthorized' } });
      }
    });
  });

  describe('every article, unfiltered (/wiki/c/all with no facet)', () => {
    const BROWSE = { action: 'redirect', location: '/wiki/browse', permanent: true };

    it('is the browse page, for good, before the page streams anything', async () => {
      for (const url of [
        '/wiki/c/all',
        // How a set is shown is not what is listed; the browse page has neither.
        '/wiki/c/all?view=compare',
        '/wiki/c/all?view=compare&tab=2',
        '/wiki/c/all?tab=Level%203',
        // Read as the page reads it: an empty facet, or a first value of spaces, narrows nothing.
        '/wiki/c/all?biome=',
        '/wiki/c/all?station=%20%20',
        '/wiki/c/all?biome=&biome=Meadows',
        '/wiki/c/all?utm_source=x',
        // The segment decoded once, as the page decodes it.
        '/wiki/c/%61ll',
      ]) {
        const request = input(url);
        expect(await decideProxy(request), url).toEqual(BROWSE);
        expect(request.principal).not.toHaveBeenCalled();
      }
      // Signed in or not.
      expect(await decideProxy(input('/wiki/c/all', { principal: PASSWORD }))).toEqual(BROWSE);
      expect(await decideProxy(input('/wiki/c/all', { method: 'HEAD' }))).toEqual(BROWSE);
    });

    it('serves every facet, category and other address as before', async () => {
      for (const url of [
        '/wiki/c/all?biome=Meadows',
        '/wiki/c/all?station=Forge',
        '/wiki/c/all?type=Weapon',
        '/wiki/c/all?view=compare&station=Forge',
        '/wiki/c/Weapons',
        '/wiki/c/Weapons?view=compare',
        '/wiki/c/ALL',
        '/wiki/c/all/more',
        '/wiki/c',
        '/wiki/browse',
        '/wiki/a/all',
      ]) {
        expect(await decideProxy(input(url)), url).toEqual({ action: 'next', page: true });
      }
      // Never a POST: nothing posts to a page, and a 308 would post it again elsewhere.
      expect(await decideProxy(input('/wiki/c/all', { method: 'POST' }))).toEqual({ action: 'next', page: true });
    });

    it('agrees with the page about which addresses list everything', () => {
      // The page's own reading (`readRequest` in src/app/wiki/c/[category]/page.tsx), for the `all` sentinel.
      const pageListsEverything = (url: URL): boolean => {
        const raw: Record<string, string | string[]> = {};
        for (const key of new Set(url.searchParams.keys())) {
          const values = url.searchParams.getAll(key);
          raw[key] = values.length > 1 ? values : values[0]!;
        }
        const { query, invalid } = parseCategoryQuery(raw);
        return !invalid && Object.keys(facetQuery(query)).length === 0;
      };
      const queries = [
        '',
        '?view=compare',
        '?view=list',
        '?tab=2',
        '?biome=Meadows',
        '?biome=%20',
        '?biome=&station=Forge',
        '?station=&station=Forge',
        '?type=Weapon&view=compare',
        '?BIOME=Meadows',
        '?q=hierro',
        '?biome=Meadows&biome=',
      ];
      for (const query of queries) {
        const url = new URL(`/wiki/c/all${query}`, 'https://x.invalid');
        const segment = url.pathname.split('/').at(-1)!;
        expect(categoryFromParam(segment)).toBe(ALL_CATEGORIES);
        expect(permanentWikiRedirect(url.pathname, url.searchParams) !== null, query).toBe(pageListsEverything(url));
      }
    });

    it('runs: the proxy’s matcher covers the category pages', () => {
      // Next anchors each matcher source at both ends.
      const matchers = proxyConfig.matcher.map((source) => new RegExp(`^${source}$`));
      for (const path of ['/wiki/c/all', '/wiki/c/Weapons', '/wiki/browse']) {
        expect(matchers.some((matcher) => matcher.test(path)), path).toBe(true);
      }
      expect(matchers.some((matcher) => matcher.test('/_next/static/chunks/app.js'))).toBe(false);
    });
  });

  describe('re-indexing', () => {
    it('is for the password holder only', async () => {
      expect(await decideProxy(input('/api/ingest', { principal: PASSWORD }))).toEqual({ action: 'next', page: false });
      for (const principal of [BYOK, PUTER]) {
        expect(await decideProxy(input('/api/ingest', { principal }))).toEqual({
          action: 'json',
          status: 403,
          body: { error: 'forbidden' },
        });
        expect(await decideProxy(input('/api/ingest', { method: 'POST', principal }))).toMatchObject({ status: 403 });
      }
    });
  });
});

describe('contentSecurityPolicy', () => {
  const directives = (policy: string) =>
    Object.fromEntries(
      policy.split(';').map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values];
      }),
    ) as Record<string, string[]>;

  it('allows only this site, Fandom images, Puter and Cloudflare analytics', () => {
    const csp = directives(contentSecurityPolicy(false));
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['script-src']).toEqual(["'self'", "'unsafe-inline'", 'https://static.cloudflareinsights.com']);
    expect(csp['img-src']).toEqual([
      "'self'",
      'data:',
      'blob:',
      'https://static.wikia.nocookie.net',
      'https://services.fandom.com',
    ]);
    expect(csp['connect-src']).toEqual([
      "'self'",
      'https://api.puter.com',
      'https://puter.com',
      'wss://api.puter.com',
      'https://cloudflareinsights.com',
    ]);
    for (const [name, value] of [
      ['frame-src', ["'none'"]],
      ['frame-ancestors', ["'none'"]],
      ['object-src', ["'none'"]],
      ['base-uri', ["'self'"]],
      ['form-action', ["'self'"]],
      ['worker-src', ["'self'"]],
      ['manifest-src', ["'self'"]],
      ['font-src', ["'self'", 'data:']],
      ['style-src', ["'self'", "'unsafe-inline'"]],
    ] as const) {
      expect(csp[name], name).toEqual(value);
    }
  });

  it('adds eval and the hot-reload socket in development only', () => {
    const production = contentSecurityPolicy(false);
    const development = directives(contentSecurityPolicy(true));
    expect(production).not.toContain('unsafe-eval');
    expect(production).not.toMatch(/\sws:/);
    expect(development['script-src']).toContain("'unsafe-eval'");
    expect(development['connect-src']).toContain('ws:');
  });

  it('reports every violation to this site', () => {
    expect(directives(contentSecurityPolicy(false))['report-uri']).toEqual(['/api/csp-report']);
    expect(directives(BASELINE_CONTENT_SECURITY_POLICY)['report-uri']).toEqual(['/api/csp-report']);
  });

  describe('rollout', () => {
    it('starts report-only in production, with the parts no page can trip enforced', () => {
      const headers = Object.fromEntries(contentSecurityPolicyHeaders({ NODE_ENV: 'production' }));
      expect(headers['Content-Security-Policy-Report-Only']).toBe(contentSecurityPolicy(false));
      const enforced = directives(headers['Content-Security-Policy']!);
      expect(enforced).toEqual({
        'frame-ancestors': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'object-src': ["'none'"],
        'report-uri': ['/api/csp-report'],
      });
    });

    it('enforces the whole policy once CSP_ENFORCE is set', () => {
      for (const value of ['1', 'true']) {
        expect(contentSecurityPolicyHeaders({ NODE_ENV: 'production', CSP_ENFORCE: value })).toEqual([
          ['Content-Security-Policy', contentSecurityPolicy(false)],
        ]);
      }
      expect(contentSecurityPolicyMode({ NODE_ENV: 'production', CSP_ENFORCE: '0' })).toBe('report-only');
      expect(contentSecurityPolicyMode({ NODE_ENV: 'production', CSP_ENFORCE: 'yes please' })).toBe('report-only');
    });

    it('always enforces in development, so new code meets the policy before it ships', () => {
      expect(contentSecurityPolicyHeaders({ NODE_ENV: 'development' })).toEqual([
        ['Content-Security-Policy', contentSecurityPolicy(true)],
      ]);
      expect(contentSecurityPolicyMode({ NODE_ENV: 'development', CSP_ENFORCE: '0' })).toBe('enforce');
    });
  });
});
