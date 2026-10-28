import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/csp-report/route';
import { logCspReports, MAX_CSP_REPORT_BYTES, resetCspReportBudget, summariseCspReports } from '@/lib/auth/csp-report';

/*
 * The endpoint browsers report Content-Security-Policy violations to. It is
 * public, so these pin both halves: that a real report becomes a useful log
 * line, and that nothing a reader typed, or an attacker sent, gets into the
 * log beyond a few bounded fields.
 */

const LEGACY = {
  'csp-report': {
    'document-uri': 'https://valheim.digitalshopuy.com/wiki/a/iron-sword?about=my%20secret%20question#x',
    referrer: 'https://www.google.com/',
    'violated-directive': 'img-src',
    'effective-directive': 'img-src',
    'original-policy': "default-src 'self'; report-uri /api/csp-report",
    disposition: 'report',
    'blocked-uri': 'https://tracker.example/pixel.gif?uid=12345',
    'line-number': 12,
    'source-file': 'https://valheim.digitalshopuy.com/_next/static/chunks/app.js?v=1',
    'script-sample': 'steal(document.cookie)',
  },
};

const REPORTING_API = [
  {
    type: 'csp-violation',
    url: 'https://valheim.digitalshopuy.com/wiki?q=hierro',
    body: {
      documentURL: 'https://valheim.digitalshopuy.com/wiki?q=hierro',
      effectiveDirective: 'script-src-elem',
      blockedURL: 'inline',
      disposition: 'enforce',
      sample: 'alert(1)',
    },
  },
  { type: 'deprecation', body: { id: 'x' } },
];

function post(body: string, type = 'application/csp-report'): Promise<Response> {
  return POST(new Request('http://localhost:3100/api/csp-report', { method: 'POST', headers: { 'content-type': type }, body }));
}

describe('summariseCspReports', () => {
  it('keeps the directive, the blocked origin and the page path, nothing else', () => {
    expect(summariseCspReports(LEGACY)).toEqual([
      {
        disposition: 'report',
        directive: 'img-src',
        blocked: 'https://tracker.example',
        page: '/wiki/a/iron-sword',
        source: '/_next/static/chunks/app.js',
      },
    ]);
  });

  it('reads the Reporting API format and skips other report types', () => {
    expect(summariseCspReports(REPORTING_API)).toEqual([
      { disposition: 'enforce', directive: 'script-src-elem', blocked: 'inline', page: '/wiki', source: null },
    ]);
  });

  it('turns hostile or malformed fields into short placeholders', () => {
    const [summary] = summariseCspReports({
      'csp-report': {
        'effective-directive': 'img-src\n[auth] Signed in as admin',
        'blocked-uri': 'javascript:alert(document.cookie)',
        'document-uri': 'not a url',
        'source-file': `https://valheim.digitalshopuy.com/${'a'.repeat(500)}`,
      },
    });
    expect(summary).toMatchObject({ directive: 'img-src', blocked: 'javascript', page: 'unknown' });
    expect(summary!.source!.length).toBeLessThanOrEqual(160);
    expect(summariseCspReports({ 'csp-report': { 'effective-directive': '<script>' } })[0]?.directive).toBe('unknown');
    expect(summariseCspReports('nonsense')).toEqual([]);
    expect(summariseCspReports(null)).toEqual([]);
  });
});

describe('logCspReports', () => {
  beforeEach(() => {
    resetCspReportBudget();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a line per report, under [csp], with no query string, sample or key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const withKey = {
      'csp-report': { ...LEGACY['csp-report'], 'blocked-uri': 'https://evil.example/x?key=AIzaSyTESTTESTTESTTESTTESTTESTTEST1234' },
    };
    expect(logCspReports(withKey)).toBe(1);
    const line = warn.mock.calls.flat().join(' ');
    expect(line).toContain('[csp] would block img-src');
    expect(line).toContain('https://evil.example');
    expect(line).not.toContain('secret');
    expect(line).not.toContain('AIza');
    expect(line).not.toContain('steal');
    expect(line).not.toContain('uid=');
  });

  it('logs at most twenty a minute and sums up the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const start = 1_000_000;
    let logged = 0;
    for (let i = 0; i < 50; i++) logged += logCspReports(LEGACY, start + i);
    expect(logged).toBe(20);
    expect(warn).toHaveBeenCalledTimes(20);

    logCspReports(LEGACY, start + 61_000);
    expect(warn.mock.calls.at(-2)?.join(' ')).toContain('30 more violation reports');
  });

  it('reads nothing of a report past the minute’s budget', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const start = 2_000_000;
    for (let i = 0; i < 20; i++) logCspReports(LEGACY, start);
    let reads = 0;
    const watched = new Proxy({}, { get: () => void reads++ });
    expect(logCspReports({ 'csp-report': watched }, start + 1)).toBe(0);
    expect(logCspReports([{ type: 'csp-violation', body: watched }], start + 2)).toBe(0);
    expect(reads).toBe(0);
  });
});

describe('a report built to be expensive', () => {
  // `eyJ` with no dot made the log redactor's token pattern rescan the rest of the
  // field from every `eyJ`: 130–200 ms of blocked event loop per 16 KB report.
  const report = (fields: Record<string, string>) => ({
    'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': 'https://tracker.example/x', ...fields },
  });
  const keyword = report({ 'blocked-uri': 'eyJ'.repeat(5400) });
  const page = report({ 'document-uri': `https://valheim.digitalshopuy.com/${'-eyJ'.repeat(4000)}` });
  const source = report({ 'source-file': `https://valheim.digitalshopuy.com/${'eyJ'.repeat(5300)}` });

  beforeEach(() => {
    resetCspReportBudget();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is reduced to the same short fields as any other', () => {
    expect(summariseCspReports(keyword)[0]).toMatchObject({ directive: 'img-src', blocked: 'unparsable' });
    const [long] = summariseCspReports(page);
    expect(long).toMatchObject({ blocked: 'https://tracker.example' });
    expect(long!.page.length).toBeLessThanOrEqual(160);
    expect(summariseCspReports(source)[0]!.source!.length).toBeLessThanOrEqual(160);
  });

  it('costs about what a real one does', () => {
    // Ten of each: about five seconds with the old pattern, a few milliseconds now.
    const started = performance.now();
    for (let i = 0; i < 10; i++) for (const body of [keyword, page, source]) summariseCspReports(body);
    expect(performance.now() - started).toBeLessThan(300);
  });

  it('is answered like any other report', async () => {
    for (const body of [keyword, page, source]) {
      const text = JSON.stringify(body);
      expect(text.length).toBeLessThanOrEqual(MAX_CSP_REPORT_BYTES);
      expect((await post(text)).status).toBe(204);
    }
  });
});

describe('POST /api/csp-report', () => {
  beforeEach(() => {
    resetCspReportBudget();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts both report formats and answers without a body', async () => {
    const legacy = await post(JSON.stringify(LEGACY));
    expect(legacy.status).toBe(204);
    expect(legacy.headers.get('cache-control')).toBe('no-store');
    expect(await legacy.text()).toBe('');
    expect((await post(JSON.stringify(REPORTING_API), 'application/reports+json')).status).toBe(204);
  });

  it('refuses what is not a report', async () => {
    expect((await post(JSON.stringify(LEGACY), 'text/plain')).status).toBe(415);
    expect((await post('{not json')).status).toBe(400);
    expect((await post(JSON.stringify({ 'csp-report': { pad: 'x'.repeat(20_000) } }))).status).toBe(413);
  });
});
