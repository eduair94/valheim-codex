import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clientIp } from '@/lib/auth/client-ip';
import { isSafeMethod, isSameOriginRequest } from '@/lib/auth/origin';
import { readJsonBody } from '@/lib/http/json-body';

describe('clientIp', () => {
  it('trusts Cloudflare’s connecting address over anything forwarded', () => {
    const h = new Headers({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1, 203.0.113.7' });
    expect(clientIp(h)).toBe('203.0.113.7');
  });

  it('cannot be steered by a client-supplied first X-Forwarded-For entry', () => {
    // Cloudflare appends the real address to whatever the client sent.
    for (const spoof of ['10.0.0.1', '10.0.0.2', 'random-junk']) {
      expect(clientIp(new Headers({ 'x-forwarded-for': `${spoof}, 198.51.100.77` }))).toBe('198.51.100.77');
    }
  });

  it('ignores hops that are not addresses', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '198.51.100.77, not-an-ip' }))).toBe('198.51.100.77');
    expect(clientIp(new Headers({ 'x-forwarded-for': 'nope, also-nope' }))).toBe('unknown');
    expect(clientIp(new Headers({ 'cf-connecting-ip': 'garbage' }))).toBe('unknown');
  });

  it('buckets IPv6 by /64 so one connection cannot rotate through addresses', () => {
    const a = clientIp(new Headers({ 'cf-connecting-ip': '2001:db8:abcd:12:1111:2222:3333:4444' }));
    const b = clientIp(new Headers({ 'cf-connecting-ip': '2001:db8:abcd:12::99' }));
    expect(a).toBe('2001:db8:abcd:12::/64');
    expect(b).toBe(a);
    expect(clientIp(new Headers({ 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8:0:0::/64');
  });

  it('unwraps IPv4-mapped IPv6', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '::ffff:203.0.113.9' }))).toBe('203.0.113.9');
  });
});

describe('isSameOriginRequest', () => {
  it('accepts same-origin fetches and rejects cross-site and same-site siblings', () => {
    expect(isSameOriginRequest(new Headers({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOriginRequest(new Headers({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))).toBe(false);
    expect(
      isSameOriginRequest(new Headers({ 'sec-fetch-site': 'same-site', origin: 'https://www.digitalshopuy.com' })),
    ).toBe(false);
  });

  it('falls back to comparing Origin with Host for browsers without fetch metadata', () => {
    const host = 'valheim.digitalshopuy.com';
    expect(isSameOriginRequest(new Headers({ origin: `https://${host}`, host }))).toBe(true);
    expect(isSameOriginRequest(new Headers({ origin: 'https://evil.example', host }))).toBe(false);
    expect(isSameOriginRequest(new Headers({ origin: 'null', host }))).toBe(false);
    expect(isSameOriginRequest(new Headers({ origin: 'not a url', host }))).toBe(false);
  });

  it('lets non-browser clients through, since they cannot carry a victim’s cookies', () => {
    expect(isSameOriginRequest(new Headers())).toBe(true);
  });

  it('only checks methods that change state', () => {
    expect(isSafeMethod('GET')).toBe(true);
    expect(isSafeMethod('POST')).toBe(false);
    expect(isSafeMethod('DELETE')).toBe(false);
  });
});

describe('readJsonBody', () => {
  const schema = z.object({ q: z.string().max(10) });
  const post = (body: string, type = 'application/json') =>
    new Request('http://localhost/api/x', { method: 'POST', body, headers: { 'content-type': type } });

  it('parses a valid body', async () => {
    const result = await readJsonBody(post('{"q":"hierro"}'), schema);
    expect(result).toEqual({ ok: true, data: { q: 'hierro' } });
  });

  it('refuses text/plain, the content type a cross-site form can send', async () => {
    const result = await readJsonBody(post('{"q":"x"}', 'text/plain'), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(415);
  });

  it('refuses bodies over the ceiling while reading', async () => {
    const result = await readJsonBody(post(JSON.stringify({ q: 'x'.repeat(5000) })), schema, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it('distinguishes broken JSON from a wrong shape', async () => {
    const broken = await readJsonBody(post('{"q":'), schema);
    const wrong = await readJsonBody(post('{"q":"far too long for ten"}'), schema);
    expect(!broken.ok && broken.response.status).toBe(400);
    expect(!wrong.ok && (await wrong.response.json())).toEqual({ error: 'invalid_request' });
  });
});
