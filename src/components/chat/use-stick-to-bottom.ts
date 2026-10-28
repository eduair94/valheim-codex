'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { nextStick, type StickState } from '@/lib/chat/scroll';

/**
 * Keeps the thread at its newest line while an answer streams, unless the
 * reader has scrolled away from it (see `nextStick` for why the rule is about
 * direction, not distance).
 *
 * `version` changes with the thread (the messages array does, per streamed
 * update): each change scrolls to the bottom, instantly and before paint,
 * while following. A smooth scroll per token used to fight the reader's own
 * scrolling. Anything else that makes the thread taller — the status line, a
 * note under an answer, a picture loading — is caught by watching the
 * content's size.
 */
export function useStickToBottom(version: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const state = useRef<StickState>({ stick: true, lastTop: 0 });
  // Mirrored into state only when it changes, for the "jump to latest" button.
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      state.current = nextStick(state.current, el);
      const stick = state.current.stick;
      setFollowing((previous) => (previous === stick ? previous : stick));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // The viewport (keyboard, rotation, the field growing) and the content.
    const resize = new ResizeObserver(() => {
      if (state.current.stick) el.scrollTop = el.scrollHeight;
    });
    resize.observe(el);
    if (el.firstElementChild) resize.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', onScroll);
      resize.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && state.current.stick) el.scrollTop = el.scrollHeight;
  }, [version]);

  /** Follow again from the next change: the reader asked, opened or started something. */
  const follow = useCallback((): void => {
    state.current = { ...state.current, stick: true };
    setFollowing(true);
  }, []);

  const jumpToLatest = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    state.current = { stick: true, lastTop: el.scrollTop };
    setFollowing(true);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Downward only, so it never reads as the reader scrolling away.
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  }, []);

  return { scrollRef, following, follow, jumpToLatest };
}
