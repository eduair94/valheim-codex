import { Chat } from '@ai-sdk/react';
import type { ChatTransport } from 'ai';
import { PUBLIC_HOME } from '@/lib/auth/access';
import type { ChatErrorData, MessageOutcome, ValheimUIMessage } from '@/lib/chat-types';
import type { ChatMode } from './account';
import { onSignOutElsewhere } from './auth-channel';
import type { ConversationSummary } from './conversations';
import type { LoadedConversation } from './history';
import { readPuterModel, rememberPuterModel, type PuterModel } from './models';
import { leaveTo } from './navigate';
import { forgetPuterToken } from './puter-client';

/**
 * The chat as it stands in this tab, kept outside React.
 *
 * Next unmounts the chat page whenever the reader leaves it — to follow a
 * citation, or for the wiki's tabs — and serves it again from its client
 * cache on the way back, without asking the server. With the thread held in
 * component state, every return opened an empty chat, and the follow-up
 * question went out as a new conversation with no history to rewrite it
 * from. Kept here, the thread, the conversation id and an answer still
 * streaming all survive the trip; `useChat({ chat })` picks the same `Chat`
 * up again on remount.
 *
 * One session per tab, for one reader: a different profile or way of
 * connecting replaces it, and signing out leaves with a full page load, which
 * drops it altogether — in this tab and, told over `auth-channel.ts`, in
 * every other one (`signedOutElsewhere`). Never created on the server, where
 * module state would be shared between readers (see `sessionFor`).
 */

export type SessionSnapshot = {
  conversationId: string;
  /**
   * How messages ended, when not normally: answers stopped or cut short, and
   * questions left without an answer (stopped before one started).
   */
  outcomes: Record<string, MessageOutcome>;
  /** The code a failed stream sent just before its error (`data-error`). */
  streamError: ChatErrorData | null;
  /** The conversation on screen has older messages that were not loaded (`LoadedConversation`). */
  truncated: boolean;
  conversations: ConversationSummary[];
  /** The model a Puter reader answers with, remembered per browser. */
  puterModel: PuterModel;
};

/** A random conversation id; `randomUUID` only exists in secure contexts (not plain http on a LAN). */
export function newConversationId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class ChatSession {
  readonly profile: string;
  readonly mode: ChatMode;
  readonly chat: Chat<ValheimUIMessage>;
  private snapshot: SessionSnapshot;
  private readonly listeners = new Set<() => void>();
  private transport: ChatTransport<ValheimUIMessage> | null = null;

  constructor(init: {
    profile: string;
    mode: ChatMode;
    /** Built on first use, in the browser only. */
    transport: () => ChatTransport<ValheimUIMessage>;
    conversation: LoadedConversation | null;
    conversations: ConversationSummary[];
  }) {
    this.profile = init.profile;
    this.mode = init.mode;
    this.snapshot = {
      conversationId: init.conversation?.id ?? newConversationId(),
      outcomes: init.conversation?.outcomes ?? {},
      streamError: null,
      truncated: init.conversation?.truncated ?? false,
      conversations: init.conversations,
      // The server renders the default; the browser's choice is applied on mount (`loadPuterModel`).
      puterModel: readPuterModel(null),
    };
    const transport = (): ChatTransport<ValheimUIMessage> => (this.transport ??= init.transport());
    this.chat = new Chat<ValheimUIMessage>({
      id: 'valheim-codex',
      messages: init.conversation?.messages ?? [],
      transport: {
        sendMessages: (options) => transport().sendMessages(options),
        reconnectToStream: (options) => transport().reconnectToStream(options),
      },
      onData: (part) => {
        if (part.type === 'data-error') this.update({ streamError: part.data });
      },
      onFinish: ({ message, messages, isAbort, isError }) => this.finished(message, messages, isAbort, isError),
    });
  }

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private setOutcome(id: string, outcome: MessageOutcome | null): void {
    const outcomes = { ...this.snapshot.outcomes };
    if (outcome && outcome !== 'complete') outcomes[id] = outcome;
    else delete outcomes[id];
    this.update({ outcomes });
  }

  /**
   * Records how an answer ended. A stop before the answer began leaves the
   * question unanswered, which the thread says rather than showing a
   * question that looks like it is still waiting.
   */
  private finished(message: ValheimUIMessage, messages: ValheimUIMessage[], isAbort: boolean, isError: boolean): void {
    const inThread = messages.some((m) => m.id === message.id);
    if (inThread) {
      this.setOutcome(message.id, isAbort ? 'stopped' : isError ? 'error' : null);
      return;
    }
    const question = messages.at(-1);
    if (isAbort && question?.role === 'user') this.setOutcome(question.id, 'stopped');
  }

  /** Before a question is sent or sent again: earlier failures no longer describe the thread's end. */
  prepareRequest(): void {
    const last = this.chat.messages.at(-1);
    const outcomes = { ...this.snapshot.outcomes };
    if (last) delete outcomes[last.id];
    this.update({ streamError: null, outcomes });
  }

  /** Shows another conversation, or a new empty one. */
  show(conversation: LoadedConversation | null): void {
    void this.chat.stop();
    this.chat.clearError();
    this.chat.messages = conversation?.messages ?? [];
    this.update({
      conversationId: conversation?.id ?? newConversationId(),
      outcomes: conversation?.outcomes ?? {},
      streamError: null,
      truncated: conversation?.truncated ?? false,
    });
  }

  setConversations(conversations: ConversationSummary[]): void {
    this.update({ conversations });
  }

  /** Reads the browser's saved Puter model. After hydration only: the server cannot know it. */
  loadPuterModel(): void {
    const saved = readPuterModel();
    if (saved !== this.snapshot.puterModel) this.update({ puterModel: saved });
  }

  /** Answers the next question with another Puter model, and remembers it in this browser. */
  setPuterModel(model: PuterModel): void {
    rememberPuterModel(model);
    this.update({ puterModel: model });
  }
}

let current: ChatSession | null = null;

/**
 * This tab's session for the reader, created on first use. On the server it
 * is always a fresh one that is never kept: a module there serves every
 * reader at once.
 */
export function sessionFor(key: { profile: string; mode: ChatMode }, create: () => ChatSession): ChatSession {
  if (typeof window === 'undefined') return create();
  if (current && current.profile === key.profile && current.mode === key.mode) return current;
  if (current) void current.chat.stop();
  current = create();
  return current;
}

/** Drops this tab's session (signing out, switching method). */
export function endSession(): void {
  if (current) void current.chat.stop();
  current = null;
}

/**
 * Signed out in another tab, or the key forgotten there (`auth-channel.ts`):
 * what this tab still holds of the reader goes too — the session, and the
 * Puter SDK's copy of the token — and the page is loaded again from the
 * server. Whatever page the tab is on: one that left the chat for the wiki
 * still has the chat in Next's client cache, as the previous reader saw it,
 * and a Back would show it; a full load drops that cache. The chat itself
 * goes to the wiki, as the tab that signed out did.
 *
 * Listening from here, for as long as the tab has loaded the chat at all,
 * rather than only while the chat is on screen.
 */
function signedOutElsewhere(): void {
  endSession();
  forgetPuterToken();
  if (window.location.pathname === '/') leaveTo(PUBLIC_HOME);
  else window.location.reload();
}

if (typeof window !== 'undefined') onSignOutElsewhere(signedOutElsewhere);
