'use client';

import { useEffect, useState } from 'react';
import { useStrings } from '@/components/shell/lang-context';
import type { FailureAction, FailureView, Notice } from '@/lib/chat/errors';
import { byKeyboard } from '@/lib/chat/focus';
import type { Lang, Strings } from '@/lib/i18n/strings';

export type { Notice };

/** Where the link-shaped actions go; the rest are buttons. */
export type ActionLinks = Partial<Record<'signin' | 'change-key' | 'change-method', string>>;

const BUTTON =
  'inline-flex min-h-9 items-center justify-center rounded-sm border px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:min-h-11';

function actionLabel(action: FailureAction, t: Strings): string {
  switch (action) {
    case 'retry':
      return t.retry;
    case 'signin':
      return t.chatActionSignIn;
    case 'reconnect-puter':
      return t.chatActionReconnectPuter;
    case 'change-key':
      return t.chatActionChangeKey;
    case 'change-model':
      return t.chatActionChangeModel;
    case 'change-method':
      return t.chatActionChangeMethod;
    case 'new-chat':
      return t.newChat;
    case 'reload':
      return t.chatActionReload;
    case 'dismiss':
      return t.chatActionDismiss;
  }
}

/**
 * A countdown from `seconds`, restarted whenever `token` changes (a new
 * failure is a new object), ticking once a second down to zero.
 */
function useCountdown(token: unknown, seconds: number): number {
  const [state, setState] = useState({ token, left: seconds });
  // A new failure restarts the count: adjusted while rendering, as React
  // recommends for state derived from a prop.
  if (state.token !== token) setState({ token, left: seconds });
  useEffect(() => {
    if (state.left <= 0) return;
    const id = window.setTimeout(() => setState((current) => ({ ...current, left: current.left - 1 })), 1000);
    return () => window.clearTimeout(id);
  }, [state]);
  return state.token === token ? state.left : seconds;
}

function Actions({
  actions,
  t,
  links,
  waitLeft,
  onAction,
  tone,
}: {
  actions: FailureAction[];
  t: Strings;
  links: ActionLinks;
  waitLeft: number;
  onAction: (action: FailureAction, keyboard: boolean) => void;
  tone: 'alert' | 'note';
}) {
  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      {actions.map((action, i) => {
        const skin =
          i === 0
            ? tone === 'alert'
              ? 'border-blood/60 text-birch hover:bg-blood/20'
              : 'border-lichen text-birch hover:bg-moss'
            : 'border-moss text-ash hover:border-lichen hover:text-birch';
        const href = action === 'signin' || action === 'change-key' || action === 'change-method' ? links[action] : undefined;
        if (href) {
          return (
            <a key={action} href={href} className={`${BUTTON} ${skin}`}>
              {actionLabel(action, t)}
            </a>
          );
        }
        const waiting = action === 'retry' && waitLeft > 0;
        return (
          <button
            key={action}
            type="button"
            disabled={waiting}
            onClick={(event) => onAction(action, byKeyboard(event))}
            className={`${BUTTON} ${skin}`}
          >
            {waiting ? t.chatRetryIn.replace('{n}', String(waitLeft)) : actionLabel(action, t)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * What went wrong, and what is going on, just above the question field.
 *
 * Outside the scrolling thread on purpose: at the end of a long conversation
 * a notice used to land below the fold, a sliver of it showing. The error is
 * an alert, announced when it appears; the notice region stays mounted and
 * only its text changes, which is what makes a polite live region reliable.
 * Neither hides itself on a timer: a message that vanishes before it is read
 * did not help.
 *
 * Every action says whether it came from the keyboard: most of them remove
 * the bar they sit in, and the chat then gives focus a place to go.
 */
export function Dock({
  lang,
  failure,
  failureToken,
  notice,
  links,
  onAction,
  onDismissNotice,
}: {
  lang: Lang;
  failure: FailureView | null;
  /** The failure itself (the chat's `error`): a new one restarts the wait. */
  failureToken: unknown;
  notice: Notice | null;
  links: ActionLinks;
  onAction: (action: FailureAction, keyboard: boolean) => void;
  onDismissNotice: (keyboard: boolean) => void;
}) {
  const t = useStrings(lang);
  const waitLeft = useCountdown(failureToken, failure?.wait ?? 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
      {failure ? (
        <div className="mb-3 flex flex-col gap-2 rounded-md border border-blood/50 bg-blood/10 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p role="alert" className="min-w-0 text-sm leading-snug text-birch">
            {failure.text}
          </p>
          <Actions actions={failure.actions} t={t} links={links} waitLeft={waitLeft} onAction={onAction} tone="alert" />
        </div>
      ) : null}

      <div role="status">
        {notice ? (
          <div className="mb-3 flex flex-col gap-2 rounded-md border border-moss bg-peat px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <p className="min-w-0 text-sm leading-snug text-birch/90">{notice.text(t)}</p>
            <div className="flex shrink-0 items-center gap-2">
              {notice.actions?.length ? (
                <Actions actions={notice.actions} t={t} links={links} waitLeft={0} onAction={onAction} tone="note" />
              ) : null}
              <button
                type="button"
                onClick={(event) => onDismissNotice(byKeyboard(event))}
                aria-label={t.chatDismiss}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-ash transition-colors hover:bg-moss hover:text-birch pointer-coarse:h-11 pointer-coarse:w-11"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
