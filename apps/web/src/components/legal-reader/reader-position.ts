import { flushSync } from "react-dom";

/**
 * How long a reader's place is held after a change that reshapes the text.
 * Long enough for every card the change opened to read its wording; a
 * reader who scrolls first takes the place back sooner.
 */
const READING_POSITION_HOLD_MS = 10_000;

/** Whether an `overflow-y` value lets the element scroll its content. */
const scrollsVertically = (overflowY: string): boolean =>
  overflowY === "auto" || overflowY === "overlay" || overflowY === "scroll";

/** The element that scrolls the text this element sits in. */
export const readerScrollOwner = (element: Element): HTMLElement | null => {
  for (
    let candidate = element.parentElement;
    candidate !== null;
    candidate = candidate.parentElement
  ) {
    if (scrollsVertically(getComputedStyle(candidate).overflowY)) {
      return candidate;
    }
  }
  return null;
};

/** The block being read: the first one still showing below the top edge. */
const readingAnchor = (scroller: HTMLElement): HTMLElement | null => {
  const top = scroller.getBoundingClientRect().top;
  for (const block of scroller.querySelectorAll<HTMLElement>("[data-anchor]")) {
    if (block.getBoundingClientRect().bottom > top) {
      return block;
    }
  }
  return null;
};

/** The hold each scroller is under, released when a newer change starts. */
const releaseHold = new WeakMap<HTMLElement, () => void>();

type HoldOptions = {
  anchor: HTMLElement;
  scroller: HTMLElement;
  /** Where the anchor sat on screen before the change. */
  top: number;
};

/**
 * Keeps `anchor` at `top` while a change settles: a card that had no wording
 * yet shows a placeholder first and its text when the read answers, which
 * reshapes the text again after the change was committed. Every mutation or
 * resize inside the scroller is absorbed until the reader scrolls, a newer
 * change takes over, or the hold runs out. The scroller's own anchoring is
 * off meanwhile, so browsers that anchor scrolling and browsers that do not
 * hold the same passage, and the two corrections never add up.
 *
 * Returns the correction, for the caller to apply right after its change.
 */
const holdReadingPosition = ({ anchor, scroller, top }: HoldOptions) => {
  releaseHold.get(scroller)?.();
  const overflowAnchor = scroller.style.overflowAnchor;
  scroller.style.overflowAnchor = "none";
  let expectedScrollTop = scroller.scrollTop;
  const undo: (() => void)[] = [];

  const release = () => {
    if (releaseHold.get(scroller) !== release) {
      return;
    }
    releaseHold.delete(scroller);
    for (const step of undo) {
      step();
    }
    scroller.style.overflowAnchor = overflowAnchor;
  };
  const correct = () => {
    if (!anchor.isConnected) {
      release();
      return;
    }
    const drift = anchor.getBoundingClientRect().top - top;
    if (drift !== 0) {
      scroller.scrollTop += drift;
    }
    expectedScrollTop = scroller.scrollTop;
  };
  const onScroll = () => {
    // A scroll the hold did not make is the reader's or another control's;
    // either way the place is theirs now.
    if (scroller.scrollTop !== expectedScrollTop) {
      release();
    }
  };

  const mutations = new MutationObserver(correct);
  mutations.observe(scroller, {
    characterData: true,
    childList: true,
    subtree: true,
  });
  undo.push(() => {
    mutations.disconnect();
  });
  const resizes = new ResizeObserver(correct);
  for (const child of scroller.children) {
    resizes.observe(child);
  }
  undo.push(() => {
    resizes.disconnect();
  });
  const listeners = new AbortController();
  const options = { capture: true, passive: true, signal: listeners.signal };
  // Input that means the reader is moving the view themselves.
  scroller.addEventListener("keydown", release, options);
  scroller.addEventListener("pointerdown", release, options);
  scroller.addEventListener("touchstart", release, options);
  scroller.addEventListener("wheel", release, options);
  scroller.addEventListener("scroll", onScroll, options);
  undo.push(() => {
    listeners.abort();
  });
  const timer = setTimeout(release, READING_POSITION_HOLD_MS);
  undo.push(() => {
    clearTimeout(timer);
  });
  releaseHold.set(scroller, release);
  return correct;
};

type KeepReadingPositionOptions = {
  /**
   * What must not move: the control that was pressed when it sits in the
   * text, or by default the block at the top of the view.
   */
  anchor?: HTMLElement | undefined;
  scroller: HTMLElement | null;
};

/**
 * Applies a change that adds or removes content in the text (every
 * provision card at once, or one card's whole provision) without moving what
 * the reader is looking at. The anchor is measured before the change is
 * committed, and the scroll offset absorbs every difference from then on:
 * the change's own, and those of the reads it starts, until the reader
 * scrolls. Without it the passage is pushed away by everything inserted
 * above it.
 */
export const keepReadingPosition = (
  { anchor, scroller }: KeepReadingPositionOptions,
  change: () => void,
): void => {
  const held = anchor ?? (scroller === null ? null : readingAnchor(scroller));
  if (scroller === null || held === null) {
    change();
    return;
  }
  const correct = holdReadingPosition({
    anchor: held,
    scroller,
    top: held.getBoundingClientRect().top,
  });
  flushSync(change);
  correct();
};
