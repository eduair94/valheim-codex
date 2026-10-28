import { describe, expect, it, vi } from 'vitest';
import type { ChatPrincipal } from '@/lib/auth/principal';
import { completionBuckets, enforceCompletionQuota, enforceQuota } from '@/lib/chat-server/turn';
import type { Db } from '@/lib/db/create-db';

/**
 * When the quota store itself is down, a guest is refused and a password
 * holder is let through: guests are bounded by nothing but these counters,
 * while losing the operator's own friends' chat to a counter outage would be
 * worse than one unmetered question.
 */

const broken = {
  execute: vi.fn(async () => {
    throw Object.assign(new Error('connection refused'), { code: '08006' });
  }),
} as unknown as Db;

const headers = new Headers({ 'cf-connecting-ip': '203.0.113.5' });

describe('enforceQuota when the store fails', () => {
  it('refuses a guest with a 503 and a code', async () => {
    const guest: ChatPrincipal = {
      kind: 'byok',
      profile: 'byok:00000000-0000-4000-8000-000000000009',
      apiKey: 'AIzaUSERKEYuserkeyUSERKEYuserkey12345',
      model: 'gemini-3.5-flash-lite',
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await enforceQuota(broken, guest, headers);
      expect(response?.status).toBe(503);
      expect(response?.headers.get('cache-control')).toBe('private, no-store');
      expect(await response?.json()).toEqual({ error: 'quota_unavailable' });
    } finally {
      error.mockRestore();
    }
  });

  it('lets a password holder through, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await enforceQuota(broken, { kind: 'password', profile: 'ana' }, headers)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unmetered'), expect.any(String));
    } finally {
      warn.mockRestore();
    }
  });
});

const GRANT = {
  profile: 'puter:00000000-0000-4000-8000-000000000010',
  answerId: 'conv-1:m1:a',
  conversationId: 'conv-1',
  citations: [],
  issuedAt: 1_800_000_000,
};

describe('the ceiling on saving a Puter answer', () => {
  it('counts per grant, telling a regenerated answer’s grant apart by its issue time', () => {
    const [bucket] = completionBuckets(GRANT, {});
    expect(bucket).toEqual({ name: 'chat:complete:conv-1:m1:a:1800000000', limit: 4, windowMs: 15 * 60_000 });
    expect(completionBuckets({ ...GRANT, issuedAt: 1_800_000_060 }, {})[0]!.name).not.toBe(bucket!.name);
    expect(completionBuckets(GRANT, { CHAT_COMPLETIONS_PER_GRANT: '2' })[0]!.limit).toBe(2);
  });

  /*
   * Refusing would throw away an answer the reader already paid Puter for,
   * and every grant that can reach this was issued under the chat quota.
   */
  it('lets the save through, with a warning, when the store fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await enforceCompletionQuota(broken, GRANT)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unmetered'), expect.any(String));
    } finally {
      warn.mockRestore();
    }
  });
});
