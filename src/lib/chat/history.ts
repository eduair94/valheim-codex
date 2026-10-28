import { isMessageOutcome, type MessageOutcome, type ValheimUIMessage } from '@/lib/chat-types';
import type { Citation } from '@/lib/db/schema';

/**
 * A stored conversation, turned back into the messages the chat renders.
 *
 * Shared by the chat page, which loads `?c=` on the server so a reload shows
 * the thread on first paint, and by the browser, which opens conversations
 * from the sidebar through `GET /api/conversations/:id`. One mapping, so a
 * thread looks the same however it was reached.
 */

export type StoredChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: unknown[];
  citations: Citation[];
  outcome?: MessageOutcome;
};

/** What the chat needs to show a conversation it did not just stream. */
export type LoadedConversation = {
  id: string;
  messages: ValheimUIMessage[];
  /** How each stored answer ended, by message id; absent means complete. */
  outcomes: Record<string, MessageOutcome>;
  /**
   * Older messages exist that were left out: a read returns a conversation's
   * newest 200 messages at most, about a megabyte (`listRecentMessages`),
   * and then opens on a question.
   */
  truncated: boolean;
};

function textParts(parts: unknown[]): { type: 'text'; text: string }[] {
  const out: { type: 'text'; text: string }[] = [];
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const { type, text } = part as { type?: unknown; text?: unknown };
    if (type === 'text' && typeof text === 'string') out.push({ type: 'text', text });
  }
  return out;
}

/**
 * Text only, plus the sources: anything else an old row carries (a status
 * part, a client's extras) was never part of the conversation. Citations were
 * stored beside the answer; they go back in as the data part the renderer
 * reads, so history looks like live output.
 */
export function toLoadedConversation(id: string, rows: StoredChatMessage[], truncated = false): LoadedConversation {
  const outcomes: Record<string, MessageOutcome> = {};
  const messages = rows.map((row): ValheimUIMessage => {
    if (row.role === 'assistant' && row.outcome && row.outcome !== 'complete') outcomes[row.id] = row.outcome;
    const sources =
      row.role === 'assistant' && row.citations.length > 0
        ? [{ type: 'data-sources' as const, id: 'sources', data: { citations: row.citations } }]
        : [];
    return { id: row.id, role: row.role, parts: [...sources, ...textParts(row.parts)] };
  });
  return { id, messages, outcomes, truncated };
}

/**
 * The body of `GET /api/conversations/:id`, checked rather than trusted: a
 * proxy's error page or a half-deployed server must not reach the renderer as
 * a thread.
 */
export function parseConversationResponse(body: unknown): LoadedConversation | null {
  if (typeof body !== 'object' || body === null) return null;
  const { conversation, messages, truncated } = body as {
    conversation?: { id?: unknown };
    messages?: unknown;
    truncated?: unknown;
  };
  if (typeof conversation?.id !== 'string' || !Array.isArray(messages)) return null;
  const rows: StoredChatMessage[] = [];
  for (const entry of messages) {
    if (typeof entry !== 'object' || entry === null) continue;
    const m = entry as Record<string, unknown>;
    if (typeof m['id'] !== 'string' || (m['role'] !== 'user' && m['role'] !== 'assistant')) continue;
    rows.push({
      id: m['id'],
      role: m['role'],
      parts: Array.isArray(m['parts']) ? m['parts'] : [],
      citations: Array.isArray(m['citations']) ? (m['citations'] as Citation[]) : [],
      outcome: isMessageOutcome(m['outcome']) ? m['outcome'] : undefined,
    });
  }
  return toLoadedConversation(conversation.id, rows, truncated === true);
}
