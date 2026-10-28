/**
 * Asks Puter who a sign-in token belongs to, and whether it was issued to
 * this site.
 *
 * Puter signs its tokens with a secret only Puter holds, so the signature
 * cannot be checked here; the token's claims are a hint, never proof. The
 * proof is Puter's own `/whoami` answering 200 for it.
 *
 * That alone is not enough. A Puter token is scoped to the site it was issued
 * on (`app_name`, an id Puter derives from the site's origin). Without
 * comparing it to this site's id, a token a reader handed to *any* other
 * Puter-enabled site could be replayed here by that site's owner to read the
 * reader's conversations. The comparison id comes from configuration —
 * `PUTER_APP_UIDS`, or Puter's own derivation for `APP_ORIGIN` — never from
 * the request, which the replaying party controls.
 */

const PUTER_API = 'https://api.puter.com';
const TIMEOUT_MS = 5_000;
/** Puter may repoint an origin to a new app id; re-ask hourly. */
const APP_UID_TTL_MS = 60 * 60 * 1000;

export type PuterIdentity = { uuid: string; username: string };

export type PuterTokenError =
  /** Puter rejected the token: expired, revoked, or not a Puter token. */
  | 'puter_token_invalid'
  /** Puter could not be reached. */
  | 'puter_unreachable'
  /** Puter answered with something other than a verdict. */
  | 'puter_unavailable'
  /** A valid token, but issued to another site or not to a site at all. */
  | 'wrong_audience'
  /** A temporary guest account; history and quotas need a real one. */
  | 'puter_account_required';

export type PuterTokenCheck = { ok: true; identity: PuterIdentity } | { ok: false; error: PuterTokenError };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type VerifyOptions = {
  /** Origins this site is served from (configuration, not request headers). */
  origins: string[];
  /** Explicitly allowed Puter app ids (`PUTER_APP_UIDS`). */
  allowedAppUids?: string[];
  fetchImpl?: FetchLike;
};

const appUidCache = new Map<string, { uid: string; expires: number }>();

/** Test hook: forget memoised app ids. */
export function resetPuterAppUidCache(): void {
  appUidCache.clear();
}

/** `PUTER_APP_UIDS`, comma-separated. */
export function configuredPuterAppUids(env: Record<string, string | undefined> = process.env): string[] {
  return (env.PUTER_APP_UIDS ?? '')
    .split(',')
    .map((uid) => uid.trim())
    .filter((uid) => /^app-[0-9a-f-]{36}$/i.test(uid));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function call(fetchImpl: FetchLike, path: string, token: string, body?: unknown): Promise<Response | null> {
  try {
    return await fetchImpl(`${PUTER_API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/** The app id Puter assigns to one of this site's origins, memoised. */
async function appUidFor(fetchImpl: FetchLike, origin: string, token: string): Promise<string | null> {
  const hit = appUidCache.get(origin);
  if (hit && hit.expires > Date.now()) return hit.uid;
  const res = await call(fetchImpl, '/auth/app-uid-from-origin', token, { origin });
  if (!res?.ok) return null;
  const json = (await res.json().catch(() => null)) as { uid?: unknown } | null;
  const uid = typeof json?.uid === 'string' ? json.uid : null;
  if (!uid) return null;
  appUidCache.set(origin, { uid, expires: Date.now() + APP_UID_TTL_MS });
  return uid;
}

/** Display names come from Puter; keep them printable and short. */
function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\p{C}]/gu, '').trim().slice(0, 48);
}

export async function verifyPuterToken(token: string, options: VerifyOptions): Promise<PuterTokenCheck> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const res = await call(fetchImpl, '/whoami', token);
  if (!res) return { ok: false, error: 'puter_unreachable' };
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'puter_token_invalid' };
  if (!res.ok) return { ok: false, error: 'puter_unavailable' };

  const who = (await res.json().catch(() => null)) as {
    uuid?: unknown;
    username?: unknown;
    is_temp?: unknown;
    app_name?: unknown;
  } | null;
  if (!who || typeof who.uuid !== 'string' || !UUID.test(who.uuid)) {
    return { ok: false, error: 'puter_unavailable' };
  }

  // A token with no app id is a full Puter session or a personal access
  // token — far more power than this site should ever be handed.
  const appName = typeof who.app_name === 'string' ? who.app_name : null;
  if (!appName) return { ok: false, error: 'wrong_audience' };

  let allowed = (options.allowedAppUids ?? []).includes(appName);
  if (!allowed) {
    for (const origin of options.origins) {
      if ((await appUidFor(fetchImpl, origin, token)) === appName) {
        allowed = true;
        break;
      }
    }
  }
  if (!allowed) {
    console.warn(
      `[puter] rejected a token issued to app ${appName}; this site is ${options.origins.join(', ')}. ` +
        'If the site moved or its Puter app id changed, set PUTER_APP_UIDS.',
    );
    return { ok: false, error: 'wrong_audience' };
  }

  if (who.is_temp === true) return { ok: false, error: 'puter_account_required' };

  return { ok: true, identity: { uuid: who.uuid.toLowerCase(), username: cleanName(who.username) } };
}
