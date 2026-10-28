'use client';

import { useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { AccountPanel, MODEL_SELECT_ID } from './chat/account-panel';
import { Dock, type ActionLinks, type Notice } from './chat/dock';
import { Thread } from './chat/thread';
import { STATIC_SIDEBAR_QUERY, useDrawer } from './chat/use-drawer';
import { useStickToBottom } from './chat/use-stick-to-bottom';
import { Composer, COMPOSER_ID, focusComposer } from './composer';
import { Sidebar, type IndexInfo } from './sidebar';
import { useStrings } from '@/components/shell/lang-context';
import { loginHref, PUBLIC_HOME } from '@/lib/auth/access';
import { changeByokModel, forgetByokKey, signOutEverywhere, type ChatAccount } from '@/lib/chat/account';
import { announceSignOut } from '@/lib/chat/auth-channel';
import { connectErrorText, connectPageHref } from '@/lib/chat/connect';
import { conversationFromParams, conversationHref } from '@/lib/chat/conversation-url';
import {
  conversationNotice,
  deleteConversation,
  fetchConversation,
  fetchConversations,
  keepsAddress,
  type ConversationSummary,
} from '@/lib/chat/conversations';
import { describeFailure, failureOf, type FailureAction } from '@/lib/chat/errors';
import { byKeyboard } from '@/lib/chat/focus';
import type { LoadedConversation } from '@/lib/chat/history';
import { createServerTransport } from '@/lib/chat/http-transport';
import type { PuterModel } from '@/lib/chat/models';
import { leaveTo } from '@/lib/chat/navigate';
import { connectPuter, forgetPuterToken, loadedPuter, loadPuter, type PuterLike } from '@/lib/chat/puter-client';
import { PuterChatTransport } from '@/lib/chat/puter-transport';
import { ChatSession, endSession, sessionFor } from '@/lib/chat/session-store';
import type { ValheimUIMessage } from '@/lib/chat-types';
import { readLangCookie, setLangCookie } from '@/lib/i18n/lang-cookie';
import type { Lang } from '@/lib/i18n/strings';

/**
 * Keeps the address on the conversation on screen (`/?c=<id>`), without a navigation.
 *
 * Only while the address is still the chat's. A conversation opened or
 * deleted just as the reader tapped away is answered once the next page is
 * on screen, and writing then put the chat's address on that page: a reload
 * there opened the chat. Coming back, the arrival names the conversation the
 * chat holds.
 *
 * Written with the router's own history state, which Next lets through as
 * it is. Written without it, Next took the write in as a restore of the
 * router to that address, and a restore drops any navigation still on its
 * way: a tap on "Wiki" made just before an answer started was lost.
 *
 * So the router does not see `?c=`: `useSearchParams` keeps the address the
 * page was arrived at, and a refresh of the router would put that address
 * back (nothing here refreshes it; the error page's retry does). What reads
 * it here (`addressed`, the "Ask about this" prefill) only matters on
 * arrival, and Back or Forward onto this entry hands the router the address
 * as it is, `?c=` included. The arrival itself reads `window.location`.
 */
function syncAddress(id: string | null): void {
  const target = conversationHref(id);
  const { pathname, search } = window.location;
  if (pathname !== new URL(target, window.location.href).pathname) return;
  if (`${pathname}${search}` !== target) {
    window.history.replaceState(window.history.state, '', target);
  }
}

export function Chat({
  account,
  initialLang,
  initialConversations,
  initialIndex,
  initialConversation,
}: {
  account: ChatAccount;
  initialLang: Lang;
  initialConversations: ConversationSummary[];
  initialIndex: IndexInfo;
  /** The conversation `?c=` named, loaded on the server so a reload shows it at once. */
  initialConversation: LoadedConversation | null;
}) {
  // The cookie, not the server's render: coming back to a page Next kept in
  // its cache, that render predates a language switch made in the chat.
  const [lang, setLang] = useState<Lang>(() => readLangCookie() ?? initialLang);
  // The page carries only its own language's copy; the other is fetched once
  // the page is idle, so the language switch here stays instant.
  const t = useStrings(lang, { preloadOther: true });

  /*
   * This tab's session: the same `Chat`, thread and conversation id every
   * time the page mounts again (`src/lib/chat/session-store.ts`). The
   * transport is built on first use: the server answers for the password and
   * a reader's own key, the browser itself for Puter.
   */
  const [session] = useState(() =>
    sessionFor({ profile: account.profile, mode: account.mode }, () => {
      const created: ChatSession = new ChatSession({
        profile: account.profile,
        mode: account.mode,
        transport: () =>
          account.mode === 'puter'
            ? new PuterChatTransport({ loadPuter, model: () => created.getSnapshot().puterModel })
            : createServerTransport(),
        conversation: initialConversation,
        conversations: initialConversations,
      });
      return created;
    }),
  );
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { conversationId, outcomes, streamError, conversations, puterModel, truncated } = snapshot;

  // Throttled: without it every token re-rendered the whole chat, sidebar and
  // every earlier answer's parse included.
  const { messages, status, error, sendMessage, regenerate, stop, clearError } = useChat<ValheimUIMessage>({
    chat: session.chat,
    throttle: 50,
  });
  const busy = status === 'submitted' || status === 'streaming';

  // "Ask about this" arrives as `/?about=<title>`; the question box starts
  // with the article's name. Read from the address as it is now, not from the
  // server's render: once a question is asked the address names the
  // conversation instead, and coming back must not refill the box.
  const searchParams = useSearchParams();
  const addressed = conversationFromParams(searchParams);
  const about = searchParams.get('about');
  const prefill = about && !addressed ? `${about.slice(0, 120)}: ` : '';

  const [index, setIndex] = useState<IndexInfo>(initialIndex);
  const [reindexing, setReindexing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The address names a conversation this tab does not hold (one the server
  // could not load for this reader, or a link): it is fetched on arrival, and
  // the thread says so meanwhile instead of showing an empty chat.
  const [restoring, setRestoring] = useState(
    () => addressed !== null && addressed !== session.getSnapshot().conversationId,
  );
  const [byokModel, setByokModel] = useState(account.mode === 'byok' ? account.model : '');
  const [savingModel, setSavingModel] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const { open: drawerOpen, show: showDrawer, hide: hideDrawer, triggerRef, panelRef, closeRef } = useDrawer();
  const { scrollRef, following, follow, jumpToLatest } = useStickToBottom(messages);

  /* ---------------------------- conversations --------------------------- */

  const refreshConversations = async (): Promise<void> => {
    const result = await fetchConversations();
    if (result.ok) session.setConversations(result.conversations);
  };

  const startFresh = (): void => {
    setNotice(null);
    session.show(null);
    syncAddress(null);
    follow();
  };

  /** "Nueva consulta": an empty thread, and the question field ready for typing. */
  const startNew = (): void => {
    startFresh();
    if (drawerOpen) hideDrawer({ focusId: COMPOSER_ID });
    else document.getElementById(COMPOSER_ID)?.focus();
  };

  /**
   * Fetches a stored conversation and shows it. Nothing changes on screen
   * until it has arrived: a failed open used to stop the answer on screen
   * for nothing.
   */
  const showStored = async (id: string, fromAddress: boolean): Promise<void> => {
    showFetched(id, await fetchConversation(id), fromAddress);
  };

  const showFetched = (
    id: string,
    result: Awaited<ReturnType<typeof fetchConversation>>,
    fromAddress: boolean,
  ): void => {
    setRestoring(false);
    if (!result.ok) {
      // An address naming what cannot be opened goes back to what is shown;
      // one refused only for now stays on it while the thread is empty (`keepsAddress`).
      const shown = session.chat.messages.length > 0 ? session.getSnapshot().conversationId : null;
      if (fromAddress && !keepsAddress(result, shown)) syncAddress(shown);
      setNotice(conversationNotice(result, 'open'));
      // A row for a conversation that is gone (deleted in another tab).
      if (result.status === 404) void refreshConversations();
      return;
    }
    session.show(result.conversation);
    follow();
    syncAddress(id);
  };

  const openConversation = (id: string): void => {
    setNotice(null);
    hideDrawer();
    if (session.chat.messages.length === 0) setRestoring(true);
    void showStored(id, false);
  };

  /** True once it is deleted and out of the list (the sidebar then moves focus on). */
  const removeConversation = async (id: string): Promise<boolean> => {
    setNotice(null);
    const result = await deleteConversation(id);
    if (!result.ok) {
      setNotice(conversationNotice(result, 'delete'));
      return false;
    }
    session.setConversations(session.getSnapshot().conversations.filter((c) => c.id !== id));
    if (id === session.getSnapshot().conversationId) startFresh();
    return true;
  };

  /* ------------------------------ asking ------------------------------ */

  /**
   * Sends a question and refreshes the sidebar once the answer completes, so
   * a new thread appears with the title the server derived from it. The
   * conversation id and the language travel in the body, under names the
   * transport does not overwrite (`id` is the SDK's own).
   */
  const ask = async (text: string): Promise<void> => {
    setNotice(null);
    session.prepareRequest();
    follow();
    await sendMessage({ text }, { body: { conversationId: session.getSnapshot().conversationId, lang } });
    void refreshConversations();
  };

  /**
   * Sends the last question again: after a failure, a stop, or an answer cut
   * short. The server recognises the same message id and replaces the answer
   * rather than storing the question twice.
   */
  const retry = async (): Promise<void> => {
    if (session.chat.messages.length === 0) return;
    setNotice(null);
    session.prepareRequest();
    follow();
    await regenerate({ body: { conversationId: session.getSnapshot().conversationId, lang } });
    void refreshConversations();
  };

  /*
   * The address names the conversation once the server has it — when its
   * answer starts arriving, not when the question leaves: a question refused
   * outright (an ended session) was never stored, and an address naming it
   * would lead nowhere after signing in again.
   */
  useEffect(() => {
    if (status === 'streaming') syncAddress(conversationId);
  }, [status, conversationId]);

  /* ----------------------------- arrival ------------------------------ */

  /**
   * Arriving, or coming back. The address wins: it names the conversation
   * the reader asked for (a reload, a link, Back), and one this tab does not
   * hold is returned to be fetched. A fresh "Ask about this" starts a new
   * conversation even if this tab still holds one. Otherwise the thread this
   * tab holds stays, and the address is made to name it.
   */
  const arrive = useEffectEvent((): string | null => {
    const params = new URLSearchParams(window.location.search);
    const requested = conversationFromParams(params);
    const current = session.getSnapshot().conversationId;
    if (account.mode === 'puter') session.loadPuterModel();
    if (requested && requested !== current) return requested;
    if (!requested && params.has('about') && session.chat.messages.length > 0) {
      session.show(null);
      syncAddress(null);
    } else if (session.chat.messages.length > 0) {
      syncAddress(current);
    }
    return null;
  });

  const arrived = useEffectEvent((id: string, result: Awaited<ReturnType<typeof fetchConversation>>) => {
    // The reader started asking before it arrived: their new question wins.
    if (session.chat.status !== 'ready' && session.chat.status !== 'error') {
      setRestoring(false);
      return;
    }
    showFetched(id, result, true);
  });
  const listed = useEffectEvent((result: Awaited<ReturnType<typeof fetchConversations>>) => {
    if (result.ok) session.setConversations(result.conversations);
  });

  useEffect(() => {
    const requested = arrive();
    if (requested) void fetchConversation(requested).then((result) => arrived(requested, result));
    // The list from the server's render is stale on a return from the cache.
    void fetchConversations().then(listed);
  }, []);

  /*
   * Puter: load the SDK now, so a "Reconnect" click can open Puter's popup
   * inside the click, and say so straight away if this browser has lost its
   * Puter session rather than on the first question.
   */
  useEffect(() => {
    if (account.mode !== 'puter') return;
    let cancelled = false;
    loadPuter().then(
      (puter) => {
        if (!cancelled && !puter.auth.isSignedIn()) {
          setNotice({ text: (copy) => copy.chatErrorPuterSignedOut, actions: ['reconnect-puter'] });
        }
      },
      () => {
        if (!cancelled) setNotice({ text: (copy) => copy.authErrorPuterLoad, actions: ['reload'] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [account.mode]);

  /* ------------------------------ index ------------------------------- */

  const refreshIndex = async (): Promise<void> => {
    try {
      const response = await fetch('/api/ingest');
      if (!response.ok) return;
      const data = (await response.json()) as Pick<IndexInfo, 'stats' | 'canTrigger'>;
      setIndex((current) => ({ ...current, stats: data.stats, canTrigger: data.canTrigger }));
    } catch {
      // A failed refresh must not disturb an answer in progress.
    }
  };

  const reindex = async (): Promise<void> => {
    setReindexing(true);
    setNotice(null);
    try {
      const response = await fetch('/api/ingest', { method: 'POST' });
      if (response.status === 501) setNotice({ text: (copy) => copy.reindexUnavailable });
      else if (!response.ok) setNotice({ text: (copy) => copy.errorGeneric });
      else setNotice({ text: (copy) => copy.reindexQueued });
    } catch {
      setNotice({ text: (copy) => copy.errorNetwork });
    } finally {
      setReindexing(false);
      void refreshIndex();
    }
  };

  /* ----------------------------- account ------------------------------ */

  const changeLang = (next: Lang): void => {
    setLang(next);
    // Also moves `<html lang>`, so a screen reader voices the new language.
    setLangCookie(next);
  };

  const chooseByokModel = async (model: string): Promise<void> => {
    const previous = byokModel;
    setByokModel(model);
    setSavingModel(true);
    const result = await changeByokModel(model);
    setSavingModel(false);
    if (!result.ok) {
      setByokModel(previous);
      setNotice({
        text: (copy) => connectErrorText(result.code, copy, result.retryAfter),
        actions: result.code === 'unauthorized' ? ['signin'] : undefined,
      });
      return;
    }
    setByokModel(result.model);
  };

  const choosePuterModel = (model: PuterModel): void => session.setPuterModel(model);

  /** Sends the reader to the model menu: in the sidebar, or in the drawer below 1024px. */
  const focusModelMenu = (): void => {
    if (window.matchMedia(STATIC_SIDEBAR_QUERY).matches) document.getElementById(MODEL_SELECT_ID)?.focus();
    else showDrawer({ focusId: MODEL_SELECT_ID });
  };

  const forgetKey = async (): Promise<void> => {
    if (!window.confirm(t.chatForgetKeyConfirm)) return;
    const result = await forgetByokKey();
    if (!result.ok) {
      setNotice({ text: (copy) => connectErrorText(result.code, copy, result.retryAfter) });
      return;
    }
    announceSignOut();
    // A full load: the session store, and the key's history with it, go.
    endSession();
    leaveTo(loginHref());
  };

  const signOut = async (): Promise<void> => {
    setSigningOut(true);
    const result = await signOutEverywhere();
    if (!result.ok) {
      setSigningOut(false);
      setNotice({ text: (copy) => connectErrorText(result.code, copy, result.retryAfter) });
      return;
    }
    // Puter's token lives in this browser's storage; on a shared computer it
    // should not outlast the sign-out, and it is what any other tab would
    // renew its session with. (Nothing is revoked at Puter.)
    forgetPuterToken();
    announceSignOut();
    endSession();
    leaveTo(PUBLIC_HOME);
  };

  /**
   * Signs in to Puter again, from a click: `signIn()` has to run inside it
   * for the popup to be allowed, so it is called before anything is awaited.
   * The SDK was loaded on mount; if it had not finished, Puter shows its own
   * one-tap consent dialog first. Success removes the control that asked for
   * it, so a keyboard reader's focus moves on to the question field.
   */
  const reconnectPuter = (keyboard: boolean): void => {
    const run = async (puter: PuterLike): Promise<void> => {
      const result = await connectPuter(puter);
      if (!result.ok) {
        setNotice({ text: (copy) => connectErrorText(result.code, copy, result.retryAfter), actions: ['reconnect-puter'] });
        return;
      }
      if (account.mode === 'puter' && result.name && result.name !== account.name) {
        // Another Puter account: another history. Start from it cleanly.
        endSession();
        leaveTo('/');
        return;
      }
      if (keyboard) focusComposer();
      setNotice(null);
      const last = session.chat.messages.at(-1);
      if (session.chat.error || last?.role === 'user') void retry();
    };
    const puter = loadedPuter();
    if (puter) void run(puter);
    else
      loadPuter().then(run, () => setNotice({ text: (copy) => copy.authErrorPuterLoad, actions: ['reload'] }));
  };

  /**
   * An action from the error bar or a notice. `keyboard`: it was used from
   * the keyboard, and the ones that take their bar away with them (retry,
   * dismiss) first move focus to the question field, or it would fall to
   * `<body>` and the next Tab would start over at the top of the page.
   */
  const onAction = (action: FailureAction, keyboard: boolean): void => {
    switch (action) {
      case 'retry':
        if (keyboard) focusComposer();
        void retry();
        return;
      case 'reconnect-puter':
        reconnectPuter(keyboard);
        return;
      case 'change-model':
        focusModelMenu();
        return;
      case 'new-chat':
        startNew();
        return;
      case 'reload':
        window.location.reload();
        return;
      case 'dismiss':
        if (keyboard) focusComposer();
        clearError();
        return;
      default:
        // `signin`, `change-key` and `change-method` are links.
        return;
    }
  };

  /* -------------------------------- view -------------------------------- */

  const here = conversationHref(messages.length > 0 ? conversationId : null);
  // Another way of connecting is another history: it comes back to a new chat.
  const changeMethodHref = connectPageHref({ switching: true });
  // A new key keeps the history, so it comes back to this conversation.
  const changeKeyHref = connectPageHref({ switching: true, method: 'byok', next: here });
  const links: ActionLinks = {
    signin: loginHref(here),
    'change-key': changeKeyHref,
    'change-method': changeMethodHref,
  };
  const failure = error ? describeFailure(failureOf(error, streamError), t) : null;

  return (
    <div className="flex h-dvh overflow-hidden bg-bog">
      <a href={`#${COMPOSER_ID}`} className="skip-link" inert={drawerOpen}>
        {t.chatSkipToComposer}
      </a>

      {drawerOpen ? (
        <div className="fixed inset-0 z-40 bg-bog/70 lg:hidden" onClick={() => hideDrawer()} aria-hidden="true" />
      ) : null}
      {/*
       * Below 1024px a drawer: closed, `invisible` takes it out of the tab
       * order and the accessibility tree; open, a modal dialog. Visibility
       * flips at once on opening, so focus can move in straight away, and
       * only at the end of the slide on closing. From 1024px a plain column.
       */}
      <div
        ref={panelRef}
        id="chat-drawer"
        role={drawerOpen ? 'dialog' : undefined}
        aria-modal={drawerOpen || undefined}
        aria-label={drawerOpen ? t.conversations : undefined}
        className={`fixed inset-y-0 left-0 z-50 w-[calc(17rem+env(safe-area-inset-left))] duration-200 ease-out lg:visible lg:static lg:z-auto lg:w-68 lg:translate-x-0 ${
          drawerOpen ? 'translate-x-0 transition-[translate]' : 'invisible -translate-x-full transition-[translate,visibility]'
        }`}
      >
        <Sidebar
          lang={lang}
          conversations={conversations}
          activeId={messages.length > 0 ? conversationId : null}
          index={index}
          reindexing={reindexing}
          onSelect={openConversation}
          onNew={startNew}
          onDelete={removeConversation}
          onReindex={() => void reindex()}
          onClose={() => hideDrawer()}
          closeRef={closeRef}
          account={
            <AccountPanel
              lang={lang}
              account={account}
              byokModel={byokModel}
              puterModel={puterModel}
              savingModel={savingModel}
              signingOut={signingOut}
              changeMethodHref={changeMethodHref}
              changeKeyHref={changeKeyHref}
              onLangChange={changeLang}
              onByokModel={(model) => void chooseByokModel(model)}
              onPuterModel={choosePuterModel}
              onForgetKey={() => void forgetKey()}
              onSignOut={() => void signOut()}
            />
          }
        />
      </div>

      <main
        inert={drawerOpen}
        className="flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] max-lg:pl-[env(safe-area-inset-left)]"
      >
        <header className="flex items-center gap-2 border-b border-moss py-1 pr-2 pl-2 lg:hidden">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => showDrawer()}
            aria-label={t.conversations}
            aria-expanded={drawerOpen}
            aria-controls="chat-drawer"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-ash transition-colors hover:text-birch"
          >
            <span aria-hidden="true">☰</span>
          </button>
          {/*
           * The page's heading below 1024px, where the sidebar's is hidden
           * with the closed drawer (and this header with it from 1024px up):
           * one exposed at a time.
           */}
          <h1 className="display min-w-0 flex-1 truncate text-sm text-birch">{t.appName}</h1>
          {/* The way back to the reader, one tap away rather than inside the drawer. */}
          <Link
            href="/wiki"
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-sm px-3 text-sm text-ash transition-colors hover:text-birch"
          >
            <span aria-hidden="true">⌕</span>
            {t.wiki}
          </Link>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
              <Thread
                lang={lang}
                mode={account.mode}
                messages={messages}
                outcomes={outcomes}
                busy={busy}
                hasError={Boolean(error)}
                restoring={restoring}
                truncated={truncated}
                onRetry={(keyboard) => {
                  if (keyboard) focusComposer();
                  void retry();
                }}
                onPick={(question, keyboard) => {
                  if (keyboard) focusComposer();
                  void ask(question);
                }}
              />
            </div>
          </div>
          {!following && messages.length > 0 ? (
            <button
              type="button"
              onClick={(event) => {
                // It goes away at the bottom; keyboard focus goes on to the question field.
                if (byKeyboard(event)) focusComposer();
                jumpToLatest();
              }}
              className="absolute bottom-3 left-1/2 inline-flex min-h-9 -translate-x-1/2 items-center gap-2 rounded-full border border-lichen bg-peat px-4 text-xs text-birch shadow-[0_4px_12px_rgb(0_0_0/0.35)] transition-colors hover:border-forge/50 pointer-coarse:min-h-11"
            >
              <span aria-hidden="true">↓</span>
              {t.chatJumpToLatest}
            </button>
          ) : null}
        </div>

        <Dock
          lang={lang}
          failure={failure}
          failureToken={error}
          notice={notice}
          links={links}
          onAction={onAction}
          onDismissNotice={(keyboard) => {
            if (keyboard) focusComposer();
            setNotice(null);
          }}
        />

        <Composer
          lang={lang}
          busy={busy}
          initialValue={prefill}
          onSend={(text) => void ask(text)}
          onStop={() => void stop()}
        />
      </main>
    </div>
  );
}
