import { jwtVerify, SignJWT } from 'jose';
import type { Citation } from '@/lib/db/schema';

/**
 * The permission to save one answer, for readers whose model runs in their
 * browser (Puter).
 *
 * `/api/chat/prepare` retrieves the excerpts and hands the browser the prompt;
 * the browser runs the model on the reader's Puter account and sends the text
 * back to `/api/chat/complete`. Between the two the server keeps nothing. The
 * grant carries what it would have kept — which conversation, which answer
 * row, which citations — signed, so the browser can save its own text into
 * its own conversation and nothing else: not another reader's conversation,
 * not another answer's row, not citations the server did not choose.
 *
 * HS256 under a key derived for this purpose alone, and an audience of its
 * own, so a grant can never pass for a session or the other way round.
 */

const ISSUER = 'wiki-valheim';
const AUDIENCE = 'wiki-valheim-answer';

/** Long enough for a slow model and a long answer; short enough to be useless later. */
export const ANSWER_GRANT_TTL_SECONDS = 15 * 60;

export type AnswerGrant = {
  /** The principal's profile; must match whoever completes it. */
  profile: string;
  /** The answer row's id (`jti`). */
  answerId: string;
  conversationId: string;
  citations: Citation[];
  /**
   * The question's fingerprint (`questionHash` in repo.ts), claim `qh`: the
   * answer is saved only while its question still reads the same. Edited in
   * the meantime — the server allows edits — the browser would otherwise
   * file an answer, and its sources, under a question it never answered.
   * Absent only from grants issued before the claim existed, which expire
   * fifteen minutes after a deploy.
   */
  questionHash?: string;
};

/** A grant that passed verification, with when it was issued (`iat`, seconds). */
export type VerifiedAnswerGrant = AnswerGrant & { issuedAt: number };

export async function signAnswerGrant(
  grant: AnswerGrant,
  key: Uint8Array,
  ttlSeconds: number = ANSWER_GRANT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { cid: grant.conversationId, cit: grant.citations };
  if (grant.questionHash !== undefined) claims['qh'] = grant.questionHash;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(grant.profile)
    .setJti(grant.answerId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);
}

/** The grant's claims, or null for anything expired, tampered with, or signed for another purpose. */
export async function verifyAnswerGrant(token: string, key: Uint8Array): Promise<VerifiedAnswerGrant | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      requiredClaims: ['iat'],
    });
    const { sub, jti, iat } = payload;
    const cid = payload['cid'];
    const cit = payload['cit'];
    const qh = payload['qh'];
    if (
      typeof sub !== 'string' ||
      typeof jti !== 'string' ||
      typeof iat !== 'number' ||
      typeof cid !== 'string' ||
      !Array.isArray(cit) ||
      (qh !== undefined && typeof qh !== 'string')
    ) {
      return null;
    }
    const verified: VerifiedAnswerGrant = {
      profile: sub,
      answerId: jti,
      conversationId: cid,
      citations: cit as Citation[],
      issuedAt: iat,
    };
    if (typeof qh === 'string') verified.questionHash = qh;
    return verified;
  } catch {
    return null;
  }
}
