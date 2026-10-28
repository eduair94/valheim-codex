import { describe, expect, it } from 'vitest';
import { isAutomatedReader } from '@/components/wiki/article/crawler';
import { readTranslateResponse, translateMode, waitParts } from '@/components/wiki/article/translate-request';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

describe('translateMode', () => {
  it('asks for a missing translation, and offers to refresh a stale or unfinished one', () => {
    expect(translateMode(null)).toBe('missing');
    expect(translateMode({ stale: true, partial: false, retryable: false })).toBe('stale');
    expect(translateMode({ stale: false, partial: true, retryable: true })).toBe('partial');
  });

  it('offers nothing when no request could add anything', () => {
    expect(translateMode({ stale: false, partial: false, retryable: false })).toBeNull();
    // Partial, but every missing string has failed too often for a public request.
    expect(translateMode({ stale: false, partial: true, retryable: false })).toBeNull();
  });
});

describe('readTranslateResponse', () => {
  it('refreshes the page when something was stored just now', async () => {
    for (const shown of ['missing', 'stale', 'partial'] as const) {
      expect(await readTranslateResponse(json(200, { title: 'x', doc: {}, cached: false, model: 'm' }), shown)).toEqual({
        kind: 'refresh',
      });
    }
  });

  it('refreshes a page that shows less than what is stored, though nothing was added now', async () => {
    // The page came from a cache that has not seen a translation another process stored.
    expect(await readTranslateResponse(json(200, { title: 'x', doc: {}, cached: true }), 'missing')).toEqual({
      kind: 'refresh',
    });
    // Stale on the page, current in the store; unfinished on the page, complete in the store.
    expect(await readTranslateResponse(json(200, { title: 'x', doc: {}, cached: true }), 'stale')).toEqual({
      kind: 'refresh',
    });
    expect(await readTranslateResponse(json(200, { title: 'x', doc: {}, cached: true, stale: true }), 'partial')).toEqual({
      kind: 'refresh',
    });
  });

  it('says there is nothing new when the store holds what the page shows', async () => {
    expect(await readTranslateResponse(json(200, { title: 'x', doc: {}, cached: true, stale: true }), 'stale')).toEqual({
      kind: 'current',
    });
    expect(await readTranslateResponse(json(200, { title: 'x', doc: {}, cached: true, partial: true }), 'partial')).toEqual({
      kind: 'current',
    });
    // A 200 without a translation in it is nothing to show.
    expect(await readTranslateResponse(json(200, { cached: true }), 'missing')).toEqual({ kind: 'current' });
  });

  it('treats a 202 as progress, not as a translation', async () => {
    expect(await readTranslateResponse(json(202, { status: 'in_progress', translated: 40, total: 120 }), 'missing')).toEqual({
      kind: 'pending',
      translated: 40,
      total: 120,
    });
  });

  it('reads the wait from the body, or from Retry-After', async () => {
    expect(await readTranslateResponse(json(429, { error: 'rate_limited', bucket: 'x', retryAfter: 3600 }), 'missing')).toEqual({
      kind: 'limited',
      retryAfter: 3600,
    });
    expect(await readTranslateResponse(json(429, { error: 'rate_limited' }, { 'Retry-After': '90' }), 'missing')).toEqual({
      kind: 'limited',
      retryAfter: 90,
    });
    expect(await readTranslateResponse(json(429, {}), 'missing')).toEqual({ kind: 'limited', retryAfter: null });
  });

  it('maps refusals and failures', async () => {
    expect(await readTranslateResponse(json(403, { error: 'translation_disabled' }), 'missing')).toEqual({ kind: 'disabled' });
    expect(await readTranslateResponse(json(503, { error: 'translation_failed' }), 'missing')).toEqual({ kind: 'failed' });
    expect(await readTranslateResponse(json(503, { error: 'translation_unavailable' }), 'missing')).toEqual({ kind: 'failed' });
    expect(await readTranslateResponse(json(415, { error: 'unsupported_media_type' }), 'missing')).toEqual({ kind: 'failed' });
  });

  it('survives a body that is not JSON', async () => {
    const response = new Response('<html>gateway</html>', { status: 202 });
    expect(await readTranslateResponse(response, 'missing')).toEqual({ kind: 'pending', translated: 0, total: 0 });
  });
});

describe('waitParts', () => {
  it('says minutes below an hour and a half, hours above, and never zero', () => {
    expect(waitParts(5)).toEqual({ unit: 'minutes', n: 1 });
    expect(waitParts(600)).toEqual({ unit: 'minutes', n: 10 });
    expect(waitParts(7200)).toEqual({ unit: 'hours', n: 2 });
  });
});

describe('isAutomatedReader', () => {
  it('recognises crawlers that run scripts, and the ones that name themselves', () => {
    expect(isAutomatedReader('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
    expect(
      isAutomatedReader(
        'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
      ),
    ).toBe(true);
    expect(isAutomatedReader('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36')).toBe(true);
    expect(isAutomatedReader('Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse')).toBe(true);
    expect(isAutomatedReader('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)')).toBe(true);
    expect(isAutomatedReader('Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)')).toBe(true);
    expect(isAutomatedReader(null)).toBe(true);
    expect(isAutomatedReader('')).toBe(true);
  });

  it('lets readers through', () => {
    expect(isAutomatedReader('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')).toBe(false);
    expect(
      isAutomatedReader(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false);
    expect(isAutomatedReader('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')).toBe(false);
    // A phone whose model name ends in "bot", without a version after it.
    expect(isAutomatedReader('Mozilla/5.0 (Linux; Android 12; CUBOT X30 Build/SP1A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36')).toBe(false);
  });
});
