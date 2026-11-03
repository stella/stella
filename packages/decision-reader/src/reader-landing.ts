/** How long a landing holds its passage while the page around it settles. */
const LANDING_HOLD_MS = 4000;

/** Input that means the reader has taken the scroll position over. */
const READER_SCROLL_INPUT = [
  "keydown",
  "pointerdown",
  "touchstart",
  "wheel",
] satisfies readonly (keyof DocumentEventMap)[];

const scrollingAncestor = (element: HTMLElement): HTMLElement | null => {
  for (
    let ancestor = element.parentElement;
    ancestor !== null;
    ancestor = ancestor.parentElement
  ) {
    const { overflowY } = getComputedStyle(ancestor);
    if (overflowY === "auto" || overflowY === "scroll") {
      return ancestor;
    }
  }
  return null;
};

type HoldPositionOptions = {
  /** What scrolls the reader; its children are what grows while it settles. */
  scroller: HTMLElement | null;
  /** The content observed when nothing above it scrolls. */
  fallback: HTMLElement;
  land: () => void;
};

/**
 * Applies a landing and keeps it while the page settles. Panels above the
 * text arrive after it, each at full height at once, and an engine without
 * scroll anchoring would leave the landing pushed away by them. The router's
 * scroll restoration also writes the previous position back after a hash
 * navigation renders. Until the reader scrolls, types or clicks, every such
 * scroll is not the reader's, so the hold lands again. The hold ends on that
 * input, or once the page has had time to settle.
 */
const holdPosition = ({
  scroller,
  fallback,
  land,
}: HoldPositionOptions): (() => void) => {
  land();

  const observer = new ResizeObserver(land);
  for (const content of scroller?.children ?? [fallback]) {
    observer.observe(content);
  }
  const { ownerDocument } = fallback;
  const scrollSource = scroller ?? ownerDocument;
  scrollSource.addEventListener("scroll", land, { passive: true });
  const release = () => {
    observer.disconnect();
    clearTimeout(timeout);
    scrollSource.removeEventListener("scroll", land);
    for (const type of READER_SCROLL_INPUT) {
      ownerDocument.removeEventListener(type, release, { capture: true });
    }
  };
  const timeout = setTimeout(release, LANDING_HOLD_MS);
  for (const type of READER_SCROLL_INPUT) {
    ownerDocument.addEventListener(type, release, {
      capture: true,
      passive: true,
    });
  }
  return release;
};

/** Lands on the passage and keeps it there while the page settles. */
export const holdLanding = ({
  article,
  target,
}: {
  article: HTMLElement;
  target: HTMLElement;
}): (() => void) =>
  holdPosition({
    // The panels are the text's siblings, not its children, so what grows is
    // the content of whatever scrolls the text.
    scroller: scrollingAncestor(article),
    fallback: article,
    land: () => {
      target.scrollIntoView({
        behavior: "instant",
        block: "center",
        inline: "nearest",
      });
    },
  });

/** Keeps the reader at its top, where a landing notice shows, while it settles. */
export const holdTop = (scroller: HTMLElement): (() => void) =>
  holdPosition({
    scroller,
    fallback: scroller,
    land: () => {
      scroller.scrollTo({ top: 0, behavior: "instant" });
    },
  });

/** The rendered block a landing names, inside one reader's text. */
export const readerBlockByAnchor = (
  article: HTMLElement,
  anchorId: string,
): HTMLElement | null =>
  article.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchorId)}"]`);

type ClientTop = { top: number };

/** The members of a block a landing reads. */
export type ReaderBlock = { getBoundingClientRect: () => ClientTop };

/**
 * The members of a scroll container a landing needs. Narrower than
 * `HTMLElement` so the arithmetic can be exercised without a DOM.
 */
export type ReaderScroller = {
  getBoundingClientRect: () => ClientTop;
  scrollTop: number;
  scrollTo: (options: { top: number; behavior: ScrollBehavior }) => void;
};

/** How far down its scroller a block sits, whatever is scrolled away. */
export const blockOffset = (
  target: ReaderBlock,
  container: ReaderScroller,
): number =>
  target.getBoundingClientRect().top -
  container.getBoundingClientRect().top +
  container.scrollTop;

/**
 * How far below the top of the text a block lands: the reader's controls bar
 * floats over that band, so anything higher is hidden behind it. It is
 * `--reader-controls-clearance` as a number, what `--reader-anchor-offset`
 * gives a followed address, and the line that decides which heading the
 * reader is on.
 */
export const READER_BREADCRUMB_CLEARANCE = 64;

/** Every jump in a reader lands here: at the top of the text, below the bar. */
export const scrollReaderToBlock = (
  target: ReaderBlock,
  container: ReaderScroller,
): void => {
  // Round toward the block so an integer scroll position crosses that line,
  // and the reader is on the block they jumped to.
  container.scrollTo({
    top: Math.ceil(
      blockOffset(target, container) - READER_BREADCRUMB_CLEARANCE,
    ),
    behavior: "instant",
  });
};
