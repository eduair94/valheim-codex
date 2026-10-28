import { base64url } from 'jose';
import { parsePasswordHash } from './auth/password';
import { parseGuestModes } from './auth/principal';
import { MIN_SESSION_SECRET_LENGTH, PASSWORD_HASH_REMEDY, SESSION_SECRET_REMEDY } from './auth/secrets';
import { normaliseProfile } from './auth/session';

/**
 * Environment checks, run once when the server starts (`src/instrumentation.ts`).
 *
 * Each sign-in path already refuses a bad value when it meets one — a short
 * SESSION_SECRET signs nobody in, a malformed BYOK_SECRET turns Gemini-key
 * sign-in off — but only at the first request, and only for that path. This
 * says so at boot, in one place, in words that name the variable and the fix.
 *
 * It never stops the server: the public wiki needs none of these, and a
 * misconfigured chat is no reason to take the reader down with it. It never
 * prints a value either, only names and lengths.
 */

type Env = Record<string, string | undefined>;

export type ConfigProblem = {
  /** `error`: something that is configured but will not work. `warn`: a feature left off. */
  level: 'error' | 'warn';
  message: string;
};

function listOf(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function checkConfiguration(env: Env = process.env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const error = (message: string) => problems.push({ level: 'error', message });
  const warn = (message: string) => problems.push({ level: 'warn', message });

  const secret = env.SESSION_SECRET;
  if (!secret) {
    warn(
      'SESSION_SECRET is not set: password and Puter sign-in are off' +
        (env.BYOK_SECRET ? '.' : ', and so is Gemini-key sign-in (no BYOK_SECRET either).'),
    );
  } else if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    error(
      `SESSION_SECRET is ${secret.length} characters; at least ${MIN_SESSION_SECRET_LENGTH} are required, ` +
        `and every sign-in that depends on it stays off until it is replaced. ${SESSION_SECRET_REMEDY}`,
    );
  }

  const hash = env.APP_PASSWORD_HASH;
  if (!hash) {
    warn('APP_PASSWORD_HASH is not set: password sign-in is off.');
  } else if (!parsePasswordHash(hash)) {
    error(
      'APP_PASSWORD_HASH is not a valid scrypt hash, so every password sign-in will be refused ' +
        `(a \`$\` in a .env value is expanded away). ${PASSWORD_HASH_REMEDY}`,
    );
  }

  const byokSecret = env.BYOK_SECRET?.trim();
  if (byokSecret) {
    let length = 0;
    try {
      length = base64url.decode(byokSecret).length;
    } catch {
      length = 0;
    }
    if (length !== 32) {
      error(
        'BYOK_SECRET must be 32 random bytes encoded as base64url (43 characters); Gemini-key sign-in is off ' +
          "until it is fixed. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
      );
    }
  }

  // The same reading the sign-in paths use, so the two cannot disagree about a value.
  const guests = parseGuestModes(env.GUEST_CHAT_MODES);
  if (guests.unknown.length > 0) {
    const off = !guests.byok && !guests.puter && !guests.none;
    warn(
      `GUEST_CHAT_MODES has ${guests.unknown.length === 1 ? 'a value' : 'values'} it does not know ` +
        `(${guests.unknown.map((value) => `"${value}"`).join(', ')}); only byok, puter and none are read` +
        (off ? ', so Gemini-key and Puter sign-in are both off.' : '.'),
    );
  }
  if (guests.none && (guests.byok || guests.puter)) {
    warn('GUEST_CHAT_MODES combines "none" with other modes; the other modes stay on.');
  }

  if (env.APP_ORIGIN) {
    const bad = listOf(env.APP_ORIGIN).filter((origin) => !/^https?:\/\/[^/]+\/*$/.test(origin));
    if (bad.length > 0) {
      warn(
        `APP_ORIGIN has ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} that ${bad.length === 1 ? 'is' : 'are'} not ` +
          'an origin (scheme://host[:port], no path) and will be ignored.',
      );
    }
  }

  if (env.PUTER_APP_UIDS) {
    const bad = listOf(env.PUTER_APP_UIDS).filter((uid) => !/^app-[0-9a-f-]{36}$/i.test(uid));
    if (bad.length > 0) warn(`PUTER_APP_UIDS has ${bad.length} malformed entr${bad.length === 1 ? 'y' : 'ies'} (expected app-<uuid>); ignored.`);
  }

  // Development always enforces the policy (`contentSecurityPolicyMode`), so
  // there is nothing to say there.
  const enforce = env.CSP_ENFORCE?.trim();
  if (enforce && !['1', 'true', '0', 'false'].includes(enforce)) {
    warn('CSP_ENFORCE is neither 1 nor 0; the Content-Security-Policy stays report-only.');
  } else if (env.NODE_ENV === 'production' && enforce !== '1' && enforce !== 'true') {
    warn(
      'The Content-Security-Policy is report-only (framing, <base> and plugins are blocked regardless). ' +
        'Violations are logged under [csp]; set CSP_ENFORCE=1 once they show nothing unexpected.',
    );
  }

  if (env.ADMIN_PROFILES?.trim()) {
    const entries = listOf(env.ADMIN_PROFILES);
    const valid = entries.filter((entry) => normaliseProfile(entry) !== null);
    if (valid.length === 0) {
      warn('ADMIN_PROFILES is set but names no valid profile, so nobody can re-index from the app.');
    } else if (valid.length < entries.length) {
      warn(`ADMIN_PROFILES has ${entries.length - valid.length} entr${entries.length - valid.length === 1 ? 'y' : 'ies'} that cannot be a profile name; ignored.`);
    }
  }

  return problems;
}

const REPORTED = Symbol.for('wiki-valheim.config-reported');

/**
 * Logs the problems found, once per process: the proxy and the server can
 * each run instrumentation, and one copy of the list is enough.
 */
export function reportConfiguration(env: Env = process.env): void {
  const registry = globalThis as { [REPORTED]?: boolean };
  if (registry[REPORTED]) return;
  registry[REPORTED] = true;
  for (const problem of checkConfiguration(env)) {
    (problem.level === 'error' ? console.error : console.warn)(`[config] ${problem.message}`);
  }
}

/** Only the bits the ingest script needs, so it can run without auth secrets. */
export function getIngestEnv(): { apiKey: string; databaseUrl?: string; contact: string } {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) is required to run the ingest.');
  }
  // The AI SDK reads this variable directly.
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
  return {
    apiKey,
    databaseUrl: process.env.DATABASE_URL || undefined,
    contact: process.env.WIKI_CONTACT ?? 'anonymous@example.com',
  };
}
