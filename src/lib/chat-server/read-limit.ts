import { clientIp } from '@/lib/auth/client-ip';
import { createSearchLimiter, type SearchLimitOptions } from '@/lib/wiki/search-limit';
import { jsonError } from './http';

/**
 * A ceiling on reading conversations back, per reader and per client
 * address, kept in memory.
 *
 * Opening a conversation costs no quota, and could cost a megabyte: the
 * database sends it, and this process parses it and serializes it again on
 * its only thread (`listRecentMessages` bounds one read; this bounds how
 * often). Any guest can open their conversations now, and a script reopening
 * a long one in a loop would keep the server busy for everyone, and the
 * metered database too. A person opens one every few seconds at most, even
 * clicking through the sidebar.
 *
 * In memory rather than in `rate_limits` for the reason the wiki search's
 * ceiling is (see search-limit.ts): counting there is one more database round
 * trip on every read, which is the very cost being bounded. A request with no
 * usable client address is counted per reader only.
 */

type Env = Record<string, string | undefined>;

/** Reads per minute, per reader and per address, unless `CONVERSATION_READS_PER_MINUTE` says otherwise (0: none). */
export function conversationReadLimitFromEnv(env: Env = process.env): SearchLimitOptions {
  const raw = env.CONVERSATION_READS_PER_MINUTE?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return { limit: Number.isFinite(parsed) && parsed >= 0 ? parsed : 60, windowMs: 60_000 };
}

/** Counts one read; the 429 to send instead, or null to go on. */
export type ConversationReadLimit = (profile: string, headers: Headers, now?: number) => Response | null;

export function createConversationReadLimit(
  options: SearchLimitOptions = conversationReadLimitFromEnv(),
): ConversationReadLimit {
  const limiter = createSearchLimiter(options);
  return (profile, headers, now = Date.now()) => {
    const ip = clientIp(headers);
    // Both counted, refused or not, like every other ceiling here.
    const checks = [
      { bucket: 'conversations:read', decision: limiter.take(`reader:${profile}`, now) },
      { bucket: 'conversations:read-ip', decision: ip === 'unknown' ? null : limiter.take(`ip:${ip}`, now) },
    ];
    let refused: { bucket: string; retryAfter: number } | null = null;
    for (const { bucket, decision } of checks) {
      if (!decision || decision.allowed) continue;
      if (!refused || decision.retryAfterSeconds > refused.retryAfter) {
        refused = { bucket, retryAfter: decision.retryAfterSeconds };
      }
    }
    if (!refused) return null;
    // The shape of every other quota refusal (`quotaExceededResponse`).
    return jsonError(429, 'rate_limited', refused, { 'Retry-After': String(refused.retryAfter) });
  };
}

/*
 * On `globalThis`, not in a module variable, for the reason `getDb` keeps its
 * handle there. Next bundles this module once for pages and once for route
 * handlers, and each copy has its own module state: with a module variable,
 * the chat page's server read of `/?c=` and `GET /api/conversations/[id]`
 * each had a ceiling of their own, and a reader got both. The dev server's
 * re-evaluation of a changed module would also have reset it.
 */
const SHARED = Symbol.for('wiki-valheim.conversation-read-limit');

/**
 * The process's one ceiling, for every way of reading a conversation back:
 * `GET /api/conversations/[id]`, and any page that loads one on the server.
 * Created on first use, from the environment as it is then.
 */
export function limitConversationRead(profile: string, headers: Headers): Response | null {
  const scope = globalThis as typeof globalThis & { [SHARED]?: ConversationReadLimit };
  scope[SHARED] ??= createConversationReadLimit();
  return scope[SHARED](profile, headers);
}
