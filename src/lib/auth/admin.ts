import type { ChatPrincipal } from './principal';
import { normaliseProfile } from './session';

/**
 * Who may re-index the wiki.
 *
 * Re-indexing dispatches a workflow that runs on the operator's accounts, so
 * it is never open to a guest — a Gemini key or a Puter account is free to
 * mint. Among password holders, `ADMIN_PROFILES` (comma-separated profile
 * names) narrows it further when set. Profiles are labels, not credentials —
 * anyone with the password can type any name — so this keeps the button away
 * from friends who should not press it rather than from an attacker.
 */

type Env = Record<string, string | undefined>;

/** The configured admin profiles, or null when every password holder qualifies. */
export function adminProfiles(env: Env = process.env): string[] | null {
  const raw = env.ADMIN_PROFILES?.trim();
  if (!raw) return null;
  return raw
    .split(',')
    .map((entry) => normaliseProfile(entry))
    .filter((profile): profile is string => profile !== null);
}

export function mayReindex(principal: ChatPrincipal | null, env: Env = process.env): boolean {
  if (principal?.kind !== 'password') return false;
  const admins = adminProfiles(env);
  return admins === null || admins.includes(principal.profile);
}
