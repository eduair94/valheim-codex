/**
 * Tells this site's other open tabs that the reader signed out, or forgot
 * their key, so they stop showing the reader's chat as well.
 *
 * Without it, signing out in one tab left every other chat tab on screen
 * with the thread and the conversation list, until its next question was
 * refused; on a shared computer, for whoever sat down next. A tab that hears
 * it drops what it holds and loads its page again (`signedOutElsewhere` in
 * `session-store.ts`).
 *
 * One channel object per tab: a `BroadcastChannel` never delivers a message
 * to the object that posted it, so the tab signing out does not hear itself
 * and run the other tabs' reaction on top of its own.
 */

export const AUTH_CHANNEL = 'wv-auth';

type Message = { type: 'signed-out' };

type ChannelLike = Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'removeEventListener'>;

let channel: ChannelLike | null | undefined;

/** This tab's channel; null where there is none (an old browser, a test, a refusing sandbox). */
function tabChannel(): ChannelLike | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_CHANNEL);
    // Node's channel (tests) would otherwise keep the process alive; browsers have no `unref`.
    (channel as { unref?: () => void } | null)?.unref?.();
  } catch {
    channel = null;
  }
  return channel;
}

/** Tells the other tabs that this browser's session has ended. */
export function announceSignOut(): void {
  try {
    tabChannel()?.postMessage({ type: 'signed-out' } satisfies Message);
  } catch {
    // The other tabs find out on their next request instead.
  }
}

/** Calls `listener` when another tab announces a sign-out; returns the unsubscribe. */
export function onSignOutElsewhere(listener: () => void): () => void {
  const current = tabChannel();
  if (!current) return () => {};
  const onMessage = (event: MessageEvent<unknown>): void => {
    if ((event.data as Partial<Message> | null)?.type === 'signed-out') listener();
  };
  current.addEventListener('message', onMessage as EventListener);
  return () => current.removeEventListener('message', onMessage as EventListener);
}
