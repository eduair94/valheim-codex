import type { UIMessage } from 'ai';
import type { Citation } from '@/lib/db/schema';

/**
 * What a failed answer tells the client besides its message: a stable code to
 * pick the right action (retry, wait, change key, reconnect) and, for a quota,
 * how long to wait. Sent as a transient part just before the stream's `error`
 * part, whose text is already in the reader's language.
 */
export type ChatErrorData = { code: string; retryAfter?: number };

/**
 * Custom data parts streamed alongside the answer.
 *
 * `sources` is written before the first token so the citation list renders
 * immediately instead of appearing after the answer finishes. `status` reports
 * which retrieval stage is running, which is the only feedback available
 * during the second or so before generation starts. `error` is transient: it
 * reaches `onData` and is never kept in the message.
 */
export type ValheimDataParts = {
  sources: { citations: Citation[] };
  status: { stage: 'rewriting' | 'searching' | 'answering'; queries?: string[] };
  error: ChatErrorData;
};

export type ValheimUIMessage = UIMessage<never, ValheimDataParts>;

/**
 * How a stored answer ended.
 *
 * - `complete`: the model finished normally.
 * - `stopped`: the reader stopped it, or left; the text is what they had seen.
 * - `error`: it failed or was cut off — a provider error, a timeout, a length
 *   or safety stop. The text, possibly empty, is what had arrived.
 *
 * A cut-off answer is never stored as `complete`: reopened later it would read
 * as the whole answer.
 */
export type MessageOutcome = 'complete' | 'stopped' | 'error';

export const MESSAGE_OUTCOMES: readonly MessageOutcome[] = ['complete', 'stopped', 'error'];

export function isMessageOutcome(value: unknown): value is MessageOutcome {
  return typeof value === 'string' && (MESSAGE_OUTCOMES as readonly string[]).includes(value);
}

/** Concatenates the text parts of a UI message. */
export function messageText(message: {
  parts: { type: string; text?: string }[];
}): string {
  return message.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim();
}

/** Citations attached to a message, if any were streamed with it. */
export function messageCitations(message: {
  parts: { type: string; data?: unknown }[];
}): Citation[] {
  for (const part of message.parts) {
    if (part.type === 'data-sources') {
      const data = part.data as { citations?: Citation[] } | undefined;
      if (data?.citations) return data.citations;
    }
  }
  return [];
}
