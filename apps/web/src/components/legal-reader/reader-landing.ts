/** How long a landing holds its passage while the page around it settles. */
const LANDING_HOLD_MS = 4000;

/** Input that means the reader has taken the scroll position over. */
const READER_SCROLL_INPUT = [
  "keydown",
  "pointerdown",
  "touchstart",
  "wheel",
] as const;

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

/**
 * Lands on the passage and keeps it there while the page settles. Panels
 * above the text arrive after it, each at full height at once, and an engine
 * without scroll anchoring would leave the passage pushed down by them. The
 * hold ends the moment the reader scrolls, types or clicks, or once the
 * page has had time to settle.
 */
export const holdLanding = ({
  article,
  target,
}: {
  article: HTMLElement;
  target: HTMLElement;
}): (() => void) => {
  const land = () => {
    target.scrollIntoView({
      behavior: "instant",
      block: "center",
      inline: "nearest",
    });
  };
  land();

  // The panels are the text's siblings, not its children, so what grows is
  // the content of whatever scrolls the text.
  const observer = new ResizeObserver(land);
  const scroller = scrollingAncestor(article);
  for (const content of scroller?.children ?? [article]) {
    observer.observe(content);
  }
  const { ownerDocument } = article;
  const release = () => {
    observer.disconnect();
    clearTimeout(timeout);
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

/** The rendered block a landing names, inside one reader's text. */
export const readerBlockByAnchor = (
  article: HTMLElement,
  anchorId: string,
): HTMLElement | null =>
  article.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchorId)}"]`);
