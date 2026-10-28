import { isIP } from 'node:net';

/**
 * The client address a rate limit should count against.
 *
 * Production sits behind a Cloudflare tunnel, and the origin listens only on
 * 127.0.0.1, so every request arrives through Cloudflare. Cloudflare sets
 * `CF-Connecting-IP` to the address it actually saw; the client cannot forge
 * it. `X-Forwarded-For` is different: Cloudflare *appends* the real address to
 * whatever the client sent, so its first entry is attacker-chosen. Keying the
 * login limit on that first entry let anyone reset it per request by sending a
 * random value, which made password guessing unlimited.
 *
 * Fallbacks for other setups take the *last* forwarded hop (the one added by
 * the nearest proxy) and only ever accept a syntactically valid address, so a
 * header full of junk cannot mint fresh buckets.
 *
 * IPv6 clients are bucketed by /64: one ordinary home connection owns 2^64
 * addresses, and counting each separately would make the limit decorative.
 *
 * This feeds rate limits only, never an authorisation decision.
 */
export function clientIp(headers: Headers): string {
  const cf = normalise(headers.get('cf-connecting-ip'));
  if (cf) return cf;

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',');
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = normalise(hops[i]);
      if (hop) return hop;
    }
  }

  return normalise(headers.get('x-real-ip')) ?? 'unknown';
}

function normalise(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  // IPv4-mapped IPv6 (`::ffff:203.0.113.7`) is the IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value)?.[1];
  if (mapped && isIP(mapped) === 4) return mapped;
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) return ipv6Prefix64(value);
  return null;
}

/** First four hextets of an IPv6 address, as `xxxx:xxxx:xxxx:xxxx::/64`. */
function ipv6Prefix64(address: string): string {
  const [head = '', tail = ''] = address.toLowerCase().split('%')[0]!.split('::');
  const left = head ? head.split(':') : [];
  const right = address.includes('::') && tail ? tail.split(':') : [];
  const groups = address.includes('::')
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  const prefix = groups.slice(0, 4).map((g) => (g.replace(/^0+(?=.)/, '') || '0'));
  while (prefix.length < 4) prefix.push('0');
  return `${prefix.join(':')}::/64`;
}
