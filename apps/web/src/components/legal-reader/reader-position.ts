import { flushSync } from "react-dom";

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

/**
 * Applies a change that adds or removes content throughout the text (every
 * provision card at once) without moving what the reader is looking at. The
 * block at the top of the view is measured before and after the change is
 * committed, and the scroll offset absorbs the difference. Browsers that
 * anchor scrolling themselves already leave nothing to absorb; the rest would
 * otherwise push the passage away by everything the change inserted above it.
 */
export const keepReadingPosition = (
  scroller: HTMLElement | null,
  change: () => void,
): void => {
  const anchor = scroller === null ? null : readingAnchor(scroller);
  if (scroller === null || anchor === null) {
    change();
    return;
  }
  const before = anchor.getBoundingClientRect().top;
  flushSync(change);
  if (!anchor.isConnected) {
    return;
  }
  scroller.scrollTop += anchor.getBoundingClientRect().top - before;
};
