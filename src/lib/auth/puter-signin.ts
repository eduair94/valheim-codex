import { appOrigins } from '@/lib/site';
import type { PuterTokenError } from './puter-verify';

/**
 * The parts of the Puter sign-in route that are decisions rather than I/O.
 */

/** The status each verification failure is reported with, one to one. */
export const PUTER_ERROR_STATUS: Record<PuterTokenError, number> = {
  puter_token_invalid: 401,
  wrong_audience: 403,
  puter_account_required: 403,
  puter_unreachable: 502,
  puter_unavailable: 502,
};

/**
 * The origins a Puter token may have been issued to.
 *
 * In production, only the configured ones (`APP_ORIGIN`): taken from the
 * request, a token minted for any other Puter-enabled site would pass by
 * naming that site in a header. Development adds the address the dev server
 * is being reached on, under either scheme, so the flow can be tried locally.
 */
export function puterOrigins(headers: Headers, env: Record<string, string | undefined> = process.env): string[] {
  const origins = appOrigins();
  if (env.NODE_ENV !== 'development') return origins;
  const host = headers.get('host');
  if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) return origins;
  return [...new Set([...origins, `http://${host}`, `https://${host}`])];
}
