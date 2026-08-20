import type { UIMessage } from 'ai';
import type { Citation } from '@/lib/db/schema';

/**
 * Custom data parts streamed alongside the answer.
 *
 * `sources` is written before the first token so the citation list renders
 * immediately instead of appearing after the answer finishes. `status` reports
 * which retrieval stage is running, which is the only feedback available
 * during the second or so before generation starts.
 */
export type ValheimDataParts = {
  sources: { citations: Citation[] };
  status: { stage: 'rewriting' | 'searching' | 'answering'; queries?: string[] };
};

export type ValheimUIMessage = UIMessage<never, ValheimDataParts>;

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
