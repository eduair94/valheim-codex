import { BYOK_COOKIE, openByok, type ByokModel } from './byok';
import { PUTER_COOKIE, verifyPuterSessionToken } from './puter';
import { byokEncryptionKey, purposeKey, sessionSecret } from './secrets';
import { SESSION_COOKIE, verifySessionToken } from './session';

/**
 * Who is asking, and therefore who pays for the model.
 *
 * Three kinds of chat user, kept strictly apart:
 *
 * - `password`: holds the shared password. The operator's model chain answers
 *   and the operator pays. This is the only kind that may spend operator
 *   money anywhere — translation warm-ups, re-indexing, the model fallback
 *   chain.
 * - `byok`: brought their own Gemini key. The server answers with that key
 *   and nothing else; it never falls back to an operator key.
 * - `puter`: signed in with Puter. The model runs in their browser on their
 *   Puter balance; the server only retrieves excerpts and saves the result.
 *
 * Each kind has its own cookie, with its own audience and key, so a guest
 * cookie can never be mistaken for a password session. `profile` is the
 * history owner: a free-text name for password users (which cannot contain
 * `:`) and `byok:<uuid>` / `puter:<uuid>` for guests, so the namespaces cannot
 * collide.
 */
export type ChatPrincipal =
  | { kind: 'password'; profile: string }
  | { kind: 'byok'; profile: string; apiKey: string; model: ByokModel }
  | { kind: 'puter'; profile: string; name: string };

export type PrincipalKind = ChatPrincipal['kind'];

type Env = Record<string, string | undefined>;

export type GuestModes = { byok: boolean; puter: boolean };

const KNOWN_GUEST_MODES = new Set(['byok', 'puter', 'none']);

/** {@link GuestModes}, plus what the boot check (`src/lib/env.ts`) reports about the value. */
export type GuestModesSetting = GuestModes & {
  /** `none` was listed. */
  none: boolean;
  /** Entries that are none of `byok`, `puter` and `none`, as written (lower-cased). */
  unknown: string[];
};

/**
 * Reads `GUEST_CHAT_MODES`: a comma-separated list, `byok,puter` by default,
 * `none` to make the chat password-only again.
 *
 * A value that names nothing is the default, the same as no line at all.
 * Every other optional line in `.env.example` reads that way, and Docker's
 * `env_file` hands a bare `GUEST_CHAT_MODES=` over as an empty string; read
 * literally it turned both guest sign-ins off, with nothing in the log to say
 * why. `none` stays the one way to turn them off.
 */
export function parseGuestModes(raw: string | undefined): GuestModesSetting {
  const values = (raw ?? '')
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) return { byok: true, puter: true, none: false, unknown: [] };
  return {
    byok: values.includes('byok'),
    puter: values.includes('puter'),
    none: values.includes('none'),
    unknown: values.filter((value) => !KNOWN_GUEST_MODES.has(value)),
  };
}

/**
 * Which guest sign-ins this deployment offers ({@link parseGuestModes}).
 * Read on every request, so turning a mode off also stops cookies already
 * issued for it.
 */
export function guestModes(env: Env = process.env): GuestModes {
  const { byok, puter } = parseGuestModes(env.GUEST_CHAT_MODES);
  return { byok, puter };
}

export type CookieReader = (name: string) => string | undefined;

/**
 * Resolves the principal from the request's cookies.
 *
 * Password first: someone holding the shared password keeps the operator's
 * chain even if a guest cookie lingers. The sign-in routes clear the other
 * kinds' cookies, so in practice only one is ever present.
 */
export async function resolvePrincipal(read: CookieReader, env: Env = process.env): Promise<ChatPrincipal | null> {
  const secret = sessionSecret(env);
  if (secret) {
    const session = await verifySessionToken(read(SESSION_COOKIE), secret);
    if (session) return { kind: 'password', profile: session.profile };
  }

  const modes = guestModes(env);

  if (modes.byok) {
    const token = read(BYOK_COOKIE);
    if (token) {
      const key = await byokEncryptionKey(env);
      const byok = key ? await openByok(token, key) : null;
      if (byok) return { kind: 'byok', profile: byok.sub, apiKey: byok.key, model: byok.model };
    }
  }

  if (modes.puter) {
    const token = read(PUTER_COOKIE);
    if (token) {
      const key = await purposeKey('puter-session', env);
      const puter = key ? await verifyPuterSessionToken(token, key) : null;
      if (puter) return { kind: 'puter', profile: puter.sub, name: puter.name };
    }
  }

  return null;
}

/** True for the one kind allowed to spend the operator's model budget. */
export function isOperatorPaid(principal: ChatPrincipal | null): principal is { kind: 'password'; profile: string } {
  return principal?.kind === 'password';
}
