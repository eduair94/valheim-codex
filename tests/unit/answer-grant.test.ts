import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { purposeKey } from '@/lib/auth/secrets';
import { signAnswerGrant, verifyAnswerGrant, type AnswerGrant } from '@/lib/chat-server/grant';

/**
 * The grant is the only thing that lets a browser save an answer it
 * generated: whatever it does not cover — another conversation, another row,
 * other citations — a browser must not be able to write.
 */

const ENV = { SESSION_SECRET: 's'.repeat(48) };

const GRANT: AnswerGrant = {
  profile: 'puter:00000000-0000-4000-8000-000000000001',
  answerId: 'conv-1:m1:a',
  conversationId: 'conv-1',
  citations: [{ n: 1, title: 'Iron', url: 'https://example.test/Iron', sectionPath: '', source: 'fandom', score: 0.5 }],
};

async function key(purpose = 'answer-grant'): Promise<Uint8Array> {
  const k = await purposeKey(purpose, ENV);
  if (!k) throw new Error('no key');
  return k;
}

describe('answer grants', () => {
  it('round-trips its claims, with when it was issued', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signAnswerGrant(GRANT, await key());
    const verified = await verifyAnswerGrant(token, await key());
    expect(verified).toEqual({ ...GRANT, issuedAt: expect.any(Number) });
    // The issue time tells two grants for the same row apart (a regenerated answer).
    expect(verified!.issuedAt).toBeGreaterThanOrEqual(before);
  });

  /*
   * The question's fingerprint: an answer the browser saves after an edit
   * changed its question must not be filed under the new one.
   */
  it('carries the question’s fingerprint when it has one', async () => {
    const withQuestion = { ...GRANT, questionHash: 'a'.repeat(64) };
    const verified = await verifyAnswerGrant(await signAnswerGrant(withQuestion, await key()), await key());
    expect(verified).toEqual({ ...withQuestion, issuedAt: expect.any(Number) });
  });

  it('still verifies a grant issued before the fingerprint existed, without one', async () => {
    const verified = await verifyAnswerGrant(await signAnswerGrant(GRANT, await key()), await key());
    expect(verified).not.toHaveProperty('questionHash');
  });

  it('rejects a fingerprint that is not a string', async () => {
    const token = await new SignJWT({ cid: 'conv-1', cit: [], qh: 42 })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('wiki-valheim')
      .setAudience('wiki-valheim-answer')
      .setSubject(GRANT.profile)
      .setJti(GRANT.answerId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(await key());
    expect(await verifyAnswerGrant(token, await key())).toBeNull();
  });

  it('rejects a grant with no issue time', async () => {
    const token = await new SignJWT({ cid: 'conv-1', cit: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('wiki-valheim')
      .setAudience('wiki-valheim-answer')
      .setSubject(GRANT.profile)
      .setJti(GRANT.answerId)
      .setExpirationTime('5m')
      .sign(await key());
    expect(await verifyAnswerGrant(token, await key())).toBeNull();
  });

  it('rejects a grant with any byte changed', async () => {
    const token = await signAnswerGrant(GRANT, await key());
    const [header, payload, signature] = token.split('.');
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
    forged['cid'] = 'someone-elses-conversation';
    const tampered = [header, Buffer.from(JSON.stringify(forged)).toString('base64url'), signature].join('.');
    expect(await verifyAnswerGrant(tampered, await key())).toBeNull();
  });

  it('rejects a grant signed with another purpose’s key', async () => {
    const token = await signAnswerGrant(GRANT, await key('puter-session'));
    expect(await verifyAnswerGrant(token, await key())).toBeNull();
  });

  it('rejects an expired grant', async () => {
    const token = await signAnswerGrant(GRANT, await key(), -1);
    expect(await verifyAnswerGrant(token, await key())).toBeNull();
  });

  it('rejects a token for another audience, even under the same key', async () => {
    const token = await new SignJWT({ cid: 'conv-1', cit: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('wiki-valheim')
      .setAudience('wiki-valheim-puter')
      .setSubject(GRANT.profile)
      .setJti(GRANT.answerId)
      .setExpirationTime('5m')
      .sign(await key());
    expect(await verifyAnswerGrant(token, await key())).toBeNull();
  });
});
