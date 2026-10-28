'use client';

import { useState } from 'react';
import { Answer } from '@/components/answer';
import { useStrings } from '@/components/shell/lang-context';
import { Sources } from '@/components/sources';
import type { ChatMode } from '@/lib/chat/account';
import { byKeyboard } from '@/lib/chat/focus';
import { messageCitations, messageText, type MessageOutcome, type ValheimUIMessage } from '@/lib/chat-types';
import type { Lang, Strings } from '@/lib/i18n/strings';

type ActiveCitation = { messageId: string; n: number } | null;

/**
 * The conversation: questions, answers with their sources, and a line under
 * any answer that did not end normally.
 *
 * A stopped or failed answer used to look exactly like a finished one, or
 * like a question still waiting; now it says which, and the last one offers
 * to ask again.
 *
 * A long conversation is opened on its newest messages only (the server
 * reads at most 200, about a megabyte); a line above the first one says so,
 * where the thread would otherwise seem to start mid-way with no sign of
 * what came before.
 *
 * The retry and the example questions go away once used, so they say
 * whether the keyboard used them: the chat then moves focus on.
 */
export function Thread({
  lang,
  mode,
  messages,
  outcomes,
  busy,
  hasError,
  restoring,
  truncated,
  onRetry,
  onPick,
}: {
  lang: Lang;
  mode: ChatMode;
  messages: ValheimUIMessage[];
  outcomes: Record<string, MessageOutcome>;
  busy: boolean;
  /** An error is on screen with its own actions; the thread does not repeat them. */
  hasError: boolean;
  /** A conversation named in the address is being opened. */
  restoring: boolean;
  /** Older messages of this conversation exist that the thread does not show. */
  truncated: boolean;
  onRetry: (keyboard: boolean) => void;
  onPick: (question: string, keyboard: boolean) => void;
}) {
  const t = useStrings(lang);
  const [active, setActive] = useState<ActiveCitation>(null);

  if (messages.length === 0) {
    if (restoring) {
      return (
        <p className="flex items-center gap-2 pt-6 font-mono text-xs text-ash">
          <Embers />
          {t.chatLoadingConversation}
        </p>
      );
    }
    return <EmptyState t={t} onPick={onPick} />;
  }

  const canRetry = !busy && !hasError;

  return (
    <>
      {truncated ? (
        <p className="mb-8 flex items-center gap-3 text-xs text-ash">
          <span className="h-px min-w-6 flex-1 bg-moss" aria-hidden="true" />
          <span className="min-w-0 text-center text-balance">{t.chatOlderHidden}</span>
          <span className="h-px min-w-6 flex-1 bg-moss" aria-hidden="true" />
        </p>
      ) : null}
      <ul className="flex flex-col gap-8">
        {messages.map((message, i) => {
          const last = i === messages.length - 1;

          if (message.role === 'user') {
            // A question with nothing after it, and nothing on its way.
            const unanswered = last && canRetry;
            return (
              <li key={message.id} className="rise">
                <div className="flex justify-end">
                  <p className="max-w-[85%] rounded-md rounded-br-sm border border-moss bg-peat px-4 py-2 text-[0.95rem] break-words whitespace-pre-wrap text-birch">
                    {messageText(message)}
                  </p>
                </div>
                {unanswered ? (
                  <OutcomeNote
                    text={outcomes[message.id] === 'stopped' ? t.chatOutcomeUnanswered : t.chatOutcomeFailed}
                    retry={t.retry}
                    onRetry={onRetry}
                    align="end"
                  />
                ) : null}
              </li>
            );
          }

          const text = messageText(message);
          const citations = messageCitations(message);
          // While it streams, or while the error above the field explains it, no note.
          const quiet = last && (busy || hasError);
          const note = quiet ? null : outcomeText(outcomes[message.id], text, t);
          const activeHere = active?.messageId === message.id ? active.n : null;
          const hover = (n: number | null): void => setActive(n === null ? null : { messageId: message.id, n });

          return (
            <li key={message.id} className="rise">
              <article>
                {text ? <Answer text={text} citations={citations} lang={lang} activeCitation={activeHere} onCitationHover={hover} /> : null}
                <Sources citations={citations} lang={lang} activeCitation={activeHere} onCitationHover={hover} />
                {note ? <OutcomeNote text={note} retry={t.retry} onRetry={last && canRetry ? onRetry : undefined} /> : null}
              </article>
            </li>
          );
        })}
      </ul>

      {busy ? (
        <p className="mt-6 flex items-center gap-2 font-mono text-xs text-ash">
          <Embers />
          {currentStage(messages, t, mode)}
        </p>
      ) : null}
    </>
  );
}

function outcomeText(outcome: MessageOutcome | undefined, text: string, t: Strings): string | null {
  if (outcome === 'stopped') return t.chatOutcomeStopped;
  if (outcome === 'error') return text ? t.chatOutcomeCut : t.chatOutcomeFailed;
  // An answer with no words and no recorded ending did not get anywhere either.
  return text ? null : t.chatOutcomeFailed;
}

function OutcomeNote({
  text,
  retry,
  onRetry,
  align = 'start',
}: {
  text: string;
  retry: string;
  onRetry?: (keyboard: boolean) => void;
  align?: 'start' | 'end';
}) {
  return (
    <div className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ash ${align === 'end' ? 'justify-end' : ''}`}>
      <p>{text}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={(event) => onRetry(byKeyboard(event))}
          className="inline-flex min-h-9 items-center rounded-sm border border-moss px-3 text-xs text-birch transition-colors hover:border-lichen hover:bg-peat pointer-coarse:min-h-11"
        >
          {retry}
        </button>
      ) : null}
    </div>
  );
}

function Embers() {
  return (
    <span className="flex gap-1" aria-hidden="true">
      <span className="ember" />
      <span className="ember" />
      <span className="ember" />
    </span>
  );
}

/**
 * Reads the last streamed status part so the wait says what is happening.
 * Before any part arrives: for Puter that is the excerpts being fetched (the
 * prompt is built on the server), for the rest the question being read.
 */
function currentStage(messages: ValheimUIMessage[], t: Strings, mode: ChatMode): string {
  const last = messages.at(-1);
  if (last?.role === 'assistant') {
    for (let i = last.parts.length - 1; i >= 0; i -= 1) {
      const part = last.parts[i];
      if (part?.type === 'data-status') {
        const { stage } = part.data;
        if (stage === 'rewriting') return t.thinking;
        if (stage === 'searching') return t.searching;
        if (stage === 'answering') return t.answering;
      }
    }
  }
  return mode === 'puter' ? t.searching : t.thinking;
}

function EmptyState({ t, onPick }: { t: Strings; onPick: (q: string, keyboard: boolean) => void }) {
  return (
    <div className="rise pt-6">
      <h2 className="display text-lg text-balance text-birch">{t.emptyTitle}</h2>
      <p className="mt-2 max-w-[52ch] text-[0.95rem] text-ash">{t.emptyBody}</p>
      <ul className="mt-6 flex flex-col gap-2">
        {t.examples.map((example) => (
          <li key={example}>
            <button
              type="button"
              onClick={(event) => onPick(example, byKeyboard(event))}
              className="min-h-11 w-full rounded-md border border-moss bg-peat px-4 py-2 text-left text-sm text-birch/90 transition-colors hover:border-forge/40 hover:text-birch"
            >
              {example}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
