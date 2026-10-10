import { readerBlockByAnchor } from "@stll/decision-reader/reader-landing";

const READER_BREADCRUMB_UPDATE_MS = 200;
export const READER_BREADCRUMB_CLEARANCE = 64;

const readerBreadcrumbCutoff = (viewport: HTMLElement) =>
  viewport.getBoundingClientRect().top + READER_BREADCRUMB_CLEARANCE;

type ScrollReaderBreadcrumbToHeadingOptions = {
  viewport: HTMLElement;
  target: HTMLElement;
};

export const scrollReaderBreadcrumbToHeading = ({
  viewport,
  target,
}: ScrollReaderBreadcrumbToHeadingOptions): void => {
  // Round toward the heading so an integer scroll position crosses the cutoff.
  viewport.scrollTo({
    top: Math.ceil(
      viewport.scrollTop +
        target.getBoundingClientRect().top -
        readerBreadcrumbCutoff(viewport),
    ),
  });
};

const nodeRange = (node: Node) => {
  const range = document.createRange();
  range.selectNode(node);
  return range;
};

type ObserveReaderBreadcrumbOptions = {
  viewport: HTMLElement;
  content: HTMLElement;
  anchors: readonly string[];
  onAnchorChange: (anchorId: string | null) => void;
};

/** Throttle both visual and live-region changes; search only rendered headings. */
export const observeReaderBreadcrumb = ({
  viewport,
  content,
  anchors,
  onAnchorChange,
}: ObserveReaderBreadcrumbOptions): (() => void) => {
  // The binary search below needs document order; heading sources such as an
  // analysis outline may list anchors in tree order instead.
  const headings = anchors
    .flatMap((anchorId) => {
      const element = readerBlockByAnchor(content, anchorId);
      return element === null ? [] : [{ anchorId, element }];
    })
    .toSorted((left, right) =>
      nodeRange(left.element).compareBoundaryPoints(
        Range.START_TO_START,
        nodeRange(right.element),
      ),
    );
  let active: string | null | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    timer = undefined;
    // At the end, short final sections cannot reach the usual heading cutoff.
    const atEnd =
      Math.ceil(viewport.scrollTop) >=
      viewport.scrollHeight - viewport.clientHeight;
    const top = atEnd
      ? viewport.getBoundingClientRect().bottom
      : readerBreadcrumbCutoff(viewport);
    let start = 0;
    let end = headings.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      const heading = headings.at(middle);
      if (
        heading !== undefined &&
        (atEnd
          ? heading.element.getBoundingClientRect().top < top
          : heading.element.getBoundingClientRect().top <= top)
      ) {
        start = middle + 1;
      } else {
        end = middle;
      }
    }
    const next =
      start === 0 ? null : (headings.at(start - 1)?.anchorId ?? null);
    if (next === active) {
      return;
    }
    active = next;
    onAnchorChange(next);
  };
  const schedule = () => {
    if (timer !== undefined) {
      return;
    }
    timer = setTimeout(update, READER_BREADCRUMB_UPDATE_MS);
  };
  viewport.addEventListener("scroll", schedule, { passive: true });
  const observer = new ResizeObserver(schedule);
  observer.observe(content);
  observer.observe(viewport);
  update();
  return () => {
    viewport.removeEventListener("scroll", schedule);
    observer.disconnect();
    clearTimeout(timer);
  };
};
