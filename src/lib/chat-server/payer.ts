import { isOperatorPaid, type ChatPrincipal } from '@/lib/auth/principal';
import { byokModel, type ByokAnswerModel } from '@/lib/rag/byok-model';

/**
 * Who pays for a turn's model calls, decided once, from the only two tests
 * allowed to decide it.
 *
 * - `operator`: `isOperatorPaid(principal)`, the one test the spec allows in
 *   front of operator spending. The operator's chain answers.
 * - `byok`: a reader with their own Gemini key. That key answers, alone.
 *
 * Anyone else gets no payer at all, and the route refuses them before
 * anything is spent. The opposite shape — "the reader's key, or else the
 * operator" — fails open: a new kind of principal, or a later edit to the
 * Puter check in front of it, would land on the operator's paid chain with
 * nothing to flag it. Here a new kind has no payer until someone writes one,
 * and every consumer switches on `kind` exhaustively, so adding a payer kind
 * without handling it does not compile.
 */
export type Payer = { kind: 'operator' } | { kind: 'byok'; model: ByokAnswerModel };

/**
 * The payer for a principal, or null for a principal no model may be run for
 * on this server.
 *
 * Throws when a reader's key cannot be used to build a model (see
 * byok-model.ts: a missing key must never reach the SDK, which would quietly
 * fall back to the operator's).
 */
export function payerFor(principal: ChatPrincipal): Payer | null {
  if (isOperatorPaid(principal)) return { kind: 'operator' };
  if (principal.kind === 'byok') return { kind: 'byok', model: byokModel(principal.apiKey, principal.model) };
  return null;
}

/**
 * For the `default` of an exhaustive switch over a payer's kind. Names the
 * kind only: a payer can hold a reader's model, and with it their key.
 */
export function unknownPayer(payer: never): never {
  throw new Error(`No model path for payer kind ${String((payer as { kind?: unknown }).kind)}`);
}
