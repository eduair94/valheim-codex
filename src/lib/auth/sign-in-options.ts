import 'server-only';

import type { ConnectModes } from '@/lib/chat/connect';
import { BYOK_MODELS, DEFAULT_BYOK_MODEL } from './byok';
import { parsePasswordHash } from './password';
import { guestModes } from './principal';
import { byokEncryptionKey, purposeKey, sessionSecret } from './secrets';

type Env = Record<string, string | undefined>;

/** The ways of signing in to the chat this server offers, and the models a reader's own key may run. */
export type SignInOptions = {
  modes: ConnectModes;
  byokModels: string[];
  defaultByokModel: string;
};

/**
 * Which ways of signing in this server offers: the one answer that both
 * `GET /api/auth/session` (`modes`, `byokModels`, `defaultByokModel`) and the
 * connect page, rendered on the server without asking that route, give.
 *
 * - `password` only when `APP_PASSWORD_HASH` parses and the session secret is
 *   usable: otherwise every sign-in fails with `server_misconfigured`.
 * - `byok` and `puter` only when `GUEST_CHAT_MODES` offers them and their key
 *   can be derived.
 *
 * Computed in one place because it used to be computed in two, kept in step
 * by a comment: a change to one would have had the page offer a method the
 * API refuses, or hide one it allows.
 */
export async function signInOptions(env: Env = process.env): Promise<SignInOptions> {
  const guests = guestModes(env);
  const passwordHash = env.APP_PASSWORD_HASH;
  return {
    modes: {
      password: Boolean(passwordHash && parsePasswordHash(passwordHash) && sessionSecret(env)),
      byok: guests.byok && (await byokEncryptionKey(env)) !== null,
      puter: guests.puter && (await purposeKey('puter-session', env)) !== null,
    },
    byokModels: [...BYOK_MODELS],
    defaultByokModel: DEFAULT_BYOK_MODEL,
  };
}
