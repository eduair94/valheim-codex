'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { Answer } from './answer';
import { Composer } from './composer';
import { Sidebar, type ConversationSummary, type IndexInfo } from './sidebar';
import { Sources } from './sources';
import { messageCitations, messageText, type ValheimUIMessage } from '@/lib/chat-types';
import type { Citation } from '@/lib/db/schema';
import { setLangCookie } from '@/lib/i18n/lang-cookie';
import { strings, type Lang } from '@/lib/i18n/strings';

export function Chat({
  profile,
  initialLang,
  initialConversations,
  initialIndex,
  about,
}: {
  profile: string;
  initialLang: Lang;
  initialConversations: ConversationSummary[];
  initialIndex: IndexInfo;
  /** Article title carried over from "Ask about this". */
  about?: string;
}) {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>(initialLang);
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID());
  const [conversations, setConversations] = useState<ConversationSummary[]>(initialConversations);
  const [index, setIndex] = useState<IndexInfo | null>(initialIndex);
  const [reindexing, setReindexing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeCitation, setActiveCitation] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const t = strings(lang);

  /**
   * One chat instance for the whole session, with the conversation id and
   * language sent per request.
   *
   * Keying `useChat` by conversation id would swap the underlying instance on
   * every switch, and the `setMessages` captured in that render would write to
   * the instance just navigated away from — opening a saved conversation would
   * load nothing.
   */
  const transport = useMemo(
    () => new DefaultChatTransport<ValheimUIMessage>({ api: '/api/chat' }),
    [],
  );

  const { messages, setMessages, sendMessage, status, stop, error, clearError } =
    useChat<ValheimUIMessage>({
      id: 'valheim-codex',
      transport,
    });

  const busy = status === 'submitted' || status === 'streaming';

  /* ----------------------------- side data ----------------------------- */

  const refreshConversations = useCallback(async () => {
    try {
      const response = await fetch('/api/conversations');
      if (!response.ok) return;
      const data = (await response.json()) as { conversations: ConversationSummary[] };
      setConversations(data.conversations);
    } catch {
      // A failed sidebar refresh must not disturb an answer in progress.
    }
  }, []);

  const refreshIndex = useCallback(async () => {
    try {
      const response = await fetch('/api/ingest');
      if (!response.ok) return;
      setIndex((await response.json()) as IndexInfo);
    } catch {
      /* same */
    }
  }, []);

  /**
   * Sends a question and refreshes the sidebar once the answer completes, so a
   * new thread appears with the title the server derived from it. Hanging this
   * off the promise rather than off a status effect keeps the update in an
   * event handler, where it belongs.
   */
  const ask = useCallback(
    async (text: string) => {
      // A distinct key on purpose: DefaultChatTransport overwrites `id` in
      // the body with the chat's own id, so the conversation id must not
      // travel under that name.
      await sendMessage({ text }, { body: { conversationId, lang } });
      await refreshConversations();
    },
    [sendMessage, refreshConversations, conversationId, lang],
  );

  const changeLang = (next: Lang): void => {
    setLang(next);
    setLangCookie(next);
  };

  /* ---------------------------- conversations --------------------------- */

  const startNew = (): void => {
    stop();
    setConversationId(crypto.randomUUID());
    setMessages([]);
    setSidebarOpen(false);
  };

  const openConversation = async (id: string): Promise<void> => {
    stop();
    setSidebarOpen(false);
    try {
      const response = await fetch(`/api/conversations/${id}`);
      if (!response.ok) return;
      const data = (await response.json()) as {
        conversation: { lang: Lang };
        messages: { id: string; role: 'user' | 'assistant'; parts: unknown[]; citations: Citation[] }[];
      };

      setConversationId(id);
      setLang(data.conversation.lang);
      setMessages(
        data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          // Citations were stored beside the message; put them back as the
          // data part the renderer reads, so history looks like live output.
          parts: [
            ...(m.citations.length > 0
              ? [{ type: 'data-sources' as const, id: 'sources', data: { citations: m.citations } }]
              : []),
            ...(m.parts as ValheimUIMessage['parts']),
          ],
        })) as ValheimUIMessage[],
      );
    } catch {
      setNotice(t.errorNetwork);
    }
  };

  const removeConversation = async (id: string): Promise<void> => {
    try {
      const response = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
      if (!response.ok) return;
      setConversations((current) => current.filter((c) => c.id !== id));
      if (id === conversationId) startNew();
    } catch {
      setNotice(t.errorNetwork);
    }
  };

  const reindex = async (): Promise<void> => {
    setReindexing(true);
    setNotice(null);
    try {
      const response = await fetch('/api/ingest', { method: 'POST' });
      if (response.status === 501) setNotice(t.reindexUnavailable);
      else if (!response.ok) setNotice(t.errorGeneric);
      else setNotice(t.reindexQueued);
    } catch {
      setNotice(t.errorNetwork);
    } finally {
      setReindexing(false);
      void refreshIndex();
    }
  };

  const logout = async (): Promise<void> => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  /* -------------------------------- view -------------------------------- */

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const statusLabel =
    status === 'submitted' || status === 'streaming' ? currentStage(messages, t) : null;

  return (
    <div className="flex h-dvh overflow-hidden bg-bog pt-[env(safe-area-inset-top)]">
      {/* Mobile drawer */}
      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-40 bg-bog/70 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-[17rem] transition-transform lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar
          lang={lang}
          profile={profile}
          conversations={conversations}
          activeId={conversationId}
          index={index}
          reindexing={reindexing}
          onSelect={(id) => void openConversation(id)}
          onNew={startNew}
          onDelete={(id) => void removeConversation(id)}
          onReindex={() => void reindex()}
          onLangChange={changeLang}
          onLogout={() => void logout()}
          onClose={() => setSidebarOpen(false)}
        />
      </div>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-moss px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label={t.conversations}
            className="rounded-sm px-2 py-1 text-ash hover:text-birch"
          >
            ☰
          </button>
          <span className="display text-sm text-birch">{t.appName}</span>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
            {messages.length === 0 ? (
              <EmptyState lang={lang} onPick={(q) => void ask(q)} />
            ) : (
              <ul className="flex flex-col gap-7">
                {messages.map((message) => (
                  <li key={message.id} className="rise">
                    {message.role === 'user' ? (
                      <div className="flex justify-end">
                        <p className="max-w-[85%] rounded-md rounded-br-sm border border-moss bg-peat px-3.5 py-2 text-[0.95rem] text-birch">
                          {messageText(message)}
                        </p>
                      </div>
                    ) : (
                      <article>
                        <Answer
                          text={messageText(message)}
                          citations={messageCitations(message)}
                          activeCitation={activeCitation}
                          onCitationHover={setActiveCitation}
                        />
                        <Sources
                          citations={messageCitations(message)}
                          lang={lang}
                          activeCitation={activeCitation}
                          onCitationHover={setActiveCitation}
                        />
                      </article>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {statusLabel ? (
              <p className="mt-6 flex items-center gap-2 font-mono text-xs text-ash">
                <span className="flex gap-1" aria-hidden="true">
                  <span className="ember" />
                  <span className="ember" />
                  <span className="ember" />
                </span>
                {statusLabel}
              </p>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="mt-6 flex items-center justify-between gap-3 rounded-md border border-blood/50 bg-blood/10 px-3 py-2 text-sm"
              >
                <span>{error.message || t.errorGeneric}</span>
                <button
                  type="button"
                  onClick={clearError}
                  className="shrink-0 rounded-sm border border-blood/50 px-2 py-1 text-xs hover:bg-blood/20"
                >
                  {t.retry}
                </button>
              </div>
            ) : null}

            {notice ? (
              <p role="status" className="mt-6 rounded-md border border-moss bg-peat px-3 py-2 text-sm text-ash">
                {notice}
              </p>
            ) : null}
          </div>
        </div>

        <Composer
          lang={lang}
          disabled={busy}
          busy={busy}
          initialValue={about ? `${about}: ` : ''}
          onSend={(text) => void ask(text)}
          onStop={stop}
        />
      </main>
    </div>
  );
}

/** Reads the last streamed status part so the wait says what is happening. */
function currentStage(messages: ValheimUIMessage[], t: ReturnType<typeof strings>): string {
  const last = messages.at(-1);
  const parts = last?.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part?.type === 'data-status') {
      const stage = (part.data as { stage?: string }).stage;
      if (stage === 'rewriting') return t.thinking;
      if (stage === 'searching') return t.searching;
      if (stage === 'answering') return t.answering;
    }
  }
  return t.thinking;
}

function EmptyState({ lang, onPick }: { lang: Lang; onPick: (q: string) => void }) {
  const t = strings(lang);
  return (
    <div className="rise pt-6">
      <h2 className="display text-lg text-birch">{t.emptyTitle}</h2>
      <p className="mt-2 max-w-[52ch] text-[0.95rem] text-ash">{t.emptyBody}</p>
      <ul className="mt-6 flex flex-col gap-2">
        {t.examples.map((example) => (
          <li key={example}>
            <button
              type="button"
              onClick={() => onPick(example)}
              className="w-full rounded-md border border-moss bg-peat px-3.5 py-2.5 text-left text-sm text-birch/90 transition-colors hover:border-forge/40 hover:text-birch"
            >
              {example}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
