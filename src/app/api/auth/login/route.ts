import { cookies, headers } from 'next/headers';
import { z } from 'zod';
import { parsePasswordHash, verifyPassword } from '@/lib/auth/password';
import { checkLoginRateLimit, clearLoginRateLimit, clientIp, pruneLoginAttempts } from '@/lib/auth/rate-limit';
import {
  createSessionToken,
  normaliseProfile,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '@/lib/auth/session';
import { getDb } from '@/lib/db/client';

export const runtime = 'nodejs';

const bodySchema = z.object({
  password: z.string().min(1),
  profile: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  const passwordHash = process.env.APP_PASSWORD_HASH;
  const secret = process.env.SESSION_SECRET;
  if (!passwordHash || !secret) {
    return Response.json(
      { error: 'server_misconfigured', message: 'APP_PASSWORD_HASH and SESSION_SECRET must be set.' },
      { status: 500 },
    );
  }

  /*
   * Report an unusable hash as a configuration fault, not as a wrong password.
   * The failure mode this guards against is quiet and confusing: a hash pasted
   * into `.env` with `$` separators is mangled by env-var expansion, and every
   * login then fails as "wrong password" with nothing to debug.
   */
  if (!parsePasswordHash(passwordHash)) {
    console.error('[auth] APP_PASSWORD_HASH is not a valid scrypt hash. Regenerate it with: pnpm auth:hash "<password>"');
    return Response.json(
      {
        error: 'server_misconfigured',
        message: 'APP_PASSWORD_HASH is malformed. Regenerate it with: pnpm auth:hash "<password>"',
      },
      { status: 500 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const profile = normaliseProfile(parsed.data.profile);
  if (!profile) {
    return Response.json({ error: 'invalid_profile' }, { status: 400 });
  }

  const db = await getDb();
  const ip = clientIp(await headers());

  const limit = await checkLoginRateLimit(db, ip);
  if (!limit.allowed) {
    return Response.json(
      { error: 'rate_limited', resetAt: limit.resetAt.toISOString() },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((limit.resetAt.getTime() - Date.now()) / 1000)) } },
    );
  }

  const ok = await verifyPassword(parsed.data.password, passwordHash);
  if (!ok) {
    // Deliberately vague: the response must not distinguish a wrong password
    // from an unknown profile, since the profile is not a credential.
    return Response.json({ error: 'invalid_credentials', remaining: limit.remaining }, { status: 401 });
  }

  await clearLoginRateLimit(db, ip);
  void pruneLoginAttempts(db).catch(() => {});

  const token = await createSessionToken({ profile }, secret);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(process.env.NODE_ENV === 'production'));

  return Response.json({ ok: true, profile });
}
