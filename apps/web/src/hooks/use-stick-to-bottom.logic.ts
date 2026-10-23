// Decisions behind the chat transcript's stick-to-bottom behaviour, kept free
// of DOM access so every transition can be driven from a test. The hook in
// `use-stick-to-bottom.ts` reads the scroll metrics, hands them here, and
// applies the outcome (scroll the element, update the visible flags).

// The view is "pinned" (auto-scroll follows, button hidden) only when
// essentially at the bottom. A scroll-up past this both releases the lock and
// shows the button in lockstep — keeping that threshold small is what stops
// the resize observer from yanking the view back and flickering the button.
export const PINNED_BOTTOM_THRESHOLD_PX = 8;

export type ScrollMetrics = {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
};

/** Follow state owned by one attached scroll element. */
export type FollowState = {
  /** The reader scrolled away from the end, so content growth is not
   *  followed until they return to the bottom or press the button. */
  readonly userScrolledUp: boolean;
  /** The element's scroll offset at the previous scroll event. */
  readonly lastScrollTop: number;
};

/** A transition's next state plus the visible "at bottom" flag, when the
 *  transition changes it (`undefined` leaves the current value). */
export type FollowTransition = {
  readonly isAtBottom: boolean | undefined;
  readonly state: FollowState;
};

const distanceFromBottom = (metrics: ScrollMetrics): number =>
  metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;

/**
 * State for a freshly attached scroll element. The escape state belongs to
 * the element, not the provider: the provider outlives a thread switch, so a
 * new viewport starts pinned and measures from its own offset instead of the
 * previous element's.
 */
export const attachFollowState = (scrollTop: number): FollowState => ({
  lastScrollTop: scrollTop,
  userScrolledUp: false,
});

/**
 * A scroll event on the element. An upward move escapes the lock unless the
 * reader is selecting text; landing near the bottom re-arms it.
 *
 * The visible flag is always the escape state, including while the
 * scroll-to-bottom button's smooth scroll runs: that scroll only moves down,
 * so it never escapes, and a reader who interrupts it by touch, keyboard or
 * scrollbar (no wheel event) gets the button back at once.
 */
export const followAfterScroll = (
  state: FollowState,
  metrics: ScrollMetrics,
  isSelecting: () => boolean,
): FollowTransition => {
  const scrolledUp = metrics.scrollTop < state.lastScrollTop && !isSelecting();
  const userScrolledUp =
    (state.userScrolledUp || scrolledUp) &&
    distanceFromBottom(metrics) > PINNED_BOTTOM_THRESHOLD_PX;

  return {
    // Button visibility tracks the escape state exactly, so the two can
    // never disagree: hidden only while pinned/following, shown the moment
    // the user has scrolled away (which also pauses auto-scroll). Releasing
    // the lock only near the bottom is what prevents the resize-observer
    // yank-and-flicker, without a dead band.
    isAtBottom: !userScrolledUp,
    state: { lastScrollTop: metrics.scrollTop, userScrolledUp },
  };
};

/**
 * Wheel-escape detection. The browser may cancel an ongoing programmatic
 * scroll when a wheel event fires, so an upward wheel escapes immediately
 * rather than waiting for the resulting scroll event. Content that fits the
 * viewport cannot scroll, so a wheel there changes nothing.
 */
export const followAfterWheel = (
  state: FollowState,
  deltaY: number,
  metrics: Pick<ScrollMetrics, "clientHeight" | "scrollHeight">,
): FollowTransition => {
  if (deltaY >= 0 || metrics.scrollHeight <= metrics.clientHeight) {
    return { isAtBottom: undefined, state };
  }
  return { isAtBottom: false, state: { ...state, userScrolledUp: true } };
};

/** The scroll-to-bottom action re-arms following; the view counts as at the
 *  bottom at once while its smooth scroll runs. */
export const followAfterScrollToBottomRequest = (
  state: FollowState,
): FollowState => ({ ...state, userScrolledUp: false });

export type ContentResizeDecision = {
  readonly isScrollable: boolean;
  /** Jump to the bottom and mark the view pinned. */
  readonly scrollToBottom: boolean;
};

/**
 * The content grew or shrank (streaming text, an image loading, a fold
 * opening). Following continues only while the reader has not escaped and is
 * not selecting text; the layout change itself is never read as an escape.
 */
export const decideContentResize = (
  state: FollowState,
  metrics: Pick<ScrollMetrics, "clientHeight" | "scrollHeight">,
  isSelecting: () => boolean,
): ContentResizeDecision => ({
  isScrollable: metrics.scrollHeight > metrics.clientHeight,
  scrollToBottom: !state.userScrolledUp && !isSelecting(),
});
