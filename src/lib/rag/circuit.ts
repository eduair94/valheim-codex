import { logWarn } from '@/lib/log';

/**
 * Remembers providers that are refusing for a reason waiting will not fix.
 *
 * The chain tries providers in order, so a dead one at the front taxes every
 * single question with a failed round trip before the working provider is even
 * asked. And "dead" is the normal state for an unfunded key: an xAI team with
 * no credit answers 403 to every request, for weeks, until someone pays.
 *
 * The distinction that matters is permanent versus temporary. A 429 is
 * temporary and the provider deserves to be asked again in a minute — skipping
 * it would give up the quota it is about to get back. A 401/402/403 is a fact
 * about the account, not the moment, so the provider is skipped for a while
 * and the chain moves straight to one that can answer.
 *
 * A timeout sits in between. A provider that hung once is likely hanging for
 * everyone right now, and without a memory every question would pay the full
 * first-token deadline on it before reaching one that answers. So a timeout
 * demotes it too, but only for a minute: long enough to ride out an incident,
 * short enough that a single slow answer costs it almost nothing.
 *
 * Only the answer's own first-word deadline counts as that evidence, which is
 * why timeouts have their own entry point instead of going through
 * `recordFailure`. Rewrite, answer and translation share candidate names (by
 * default the rewrite and the answer even use the same model), so a
 * translation batch that outlived its own 60-second budget, or a rewrite that
 * missed its 6-second one, used to demote the operator's first provider for
 * chat answers too, and for that minute every reader was answered by the next,
 * free tier. A permanent refusal, by contrast, is a fact about the account and
 * true for every feature alike.
 *
 * Deliberately in-memory and deliberately short. This is a latency
 * optimisation, not a source of truth: the worst case if it is wrong is one
 * wasted round trip, and a cooldown that outlived a top-up would be a far more
 * annoying bug than the one it fixes.
 */

const COOLDOWN_MS = 10 * 60 * 1000;
const TIMEOUT_COOLDOWN_MS = 60 * 1000;

const openUntil = new Map<string, number>();

/** Auth, payment and permission — the failures that a retry cannot fix. */
function isPermanent(error: unknown): boolean {
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? (error as { statusCode?: number }).statusCode
      : undefined;

  if (status === 401 || status === 402 || status === 403) return true;

  const message = error instanceof Error ? error.message : String(error);
  return /permission-denied|insufficient[_ ]?credits|invalid[_ ]api[_ ]key|unauthorized|requires? (more )?credits|upgrade to a paid/i.test(
    message,
  );
}

/** True while this provider is being skipped. */
export function isTripped(name: string, now: number = Date.now()): boolean {
  const until = openUntil.get(name);
  if (until === undefined) return false;
  if (until > now) return true;
  openUntil.delete(name);
  return false;
}

/**
 * Records a failure, opening the circuit only for the kinds waiting will not
 * fix soon. A timeout is not one of them here, whatever its name: see
 * `recordTimeout`.
 */
export function recordFailure(name: string, error: unknown, now: number = Date.now()): void {
  if (!isPermanent(error)) return;
  openUntil.set(name, now + COOLDOWN_MS);
  logWarn(
    'model',
    `${name} is refusing for a reason retrying will not fix; skipping it for ${COOLDOWN_MS / 60_000} minutes.`,
  );
}

/**
 * Demotes a provider that missed the answer's first-word deadline, for a
 * minute. Called by the fallback chain only when asked to (`demoteOnTimeout`),
 * which only the chat answer does.
 */
export function recordTimeout(name: string, now: number = Date.now()): void {
  // Never shorten a longer, permanent cooldown already in force.
  openUntil.set(name, Math.max(openUntil.get(name) ?? 0, now + TIMEOUT_COOLDOWN_MS));
  logWarn('model', `${name} timed out; asking the others first for ${TIMEOUT_COOLDOWN_MS / 1000} seconds.`);
}

/** A provider that answers clears whatever was held against it. */
export function recordSuccess(name: string): void {
  openUntil.delete(name);
}

/** Test-only. */
export function resetCircuits(): void {
  openUntil.clear();
}
