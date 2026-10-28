/**
 * Whether the thread should keep following a streaming answer.
 *
 * Every streamed token used to scroll the thread to the bottom, so a reader
 * who scrolled up to reread the start of a long answer was dragged back down
 * within half a second, and on a phone could not leave the bottom at all.
 *
 * The rule is about intent, not distance. A distance threshold ("within 80px
 * of the bottom means follow") fails exactly where it matters: a touch drag
 * or a trackpad arrives as many small scroll events, each well under the
 * threshold, so the next token pulled the reader back before they had moved
 * far enough to count. Any upward movement is the reader's own doing — the
 * thread only ever scrolls itself downwards — so it stops the following, and
 * reaching the bottom again resumes it.
 */

export type StickState = {
  /** Following the bottom. */
  stick: boolean;
  /** `scrollTop` at the previous scroll event. */
  lastTop: number;
};

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Within this many pixels of the bottom counts as at the bottom (subpixel rounding, zoom). */
export const BOTTOM_SLACK_PX = 4;

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

/** The state after one scroll event. */
export function nextStick(state: StickState, metrics: ScrollMetrics): StickState {
  let { stick } = state;
  if (distanceFromBottom(metrics) <= BOTTOM_SLACK_PX) stick = true;
  // One pixel of tolerance: a programmatic scroll to the bottom can land a
  // fraction short and read as a tiny move up.
  else if (metrics.scrollTop < state.lastTop - 1) stick = false;
  return { stick, lastTop: metrics.scrollTop };
}
