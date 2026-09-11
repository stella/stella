/**
 * Where a selection sits in the decision, in the terms an annotation is
 * stored in: per paragraph, the block's stable anchor and offsets into the
 * block's rendered text, which is the same text the reader lays inline
 * anchors over. A selection over several paragraphs yields one span each.
 *
 * Reader chrome inside a block (the permalink, a hanging paragraph number)
 * is marked `data-reader-chrome` and does not count; the offsets index the
 * words alone.
 */

export const READER_CHROME_ATTRIBUTE = "data-reader-chrome";

export type SelectionAnchor = {
  blockAnchorId: string;
  endOffset: number;
  quote: string;
  startOffset: number;
};

export type ReaderSelectionContainmentAction =
  | "ignore"
  | "remember"
  | "restore";

type ReaderAnnotationActivationState = {
  selection: "collapsed" | "range";
  target: "annotation" | "other";
};

/** A drag over a mark selects text; only a plain click activates the mark. */
export const readerAnnotationActivationAction = ({
  selection,
  target,
}: ReaderAnnotationActivationState): "activate" | "ignore" =>
  target === "annotation" && selection === "collapsed" ? "activate" : "ignore";

type ReaderSelectionContainmentState = {
  anchor: "inside" | "outside";
  drag: "active" | "inactive";
  focus: "inside" | "outside";
  snapshot: "available" | "empty";
};

/**
 * Keep a pointer selection that began in the reader from crossing into
 * adjacent application chrome. Selections that begin elsewhere are ignored,
 * so Inspector and chat text remain independently selectable.
 */
export const readerSelectionContainmentAction = ({
  anchor,
  drag,
  focus,
  snapshot,
}: ReaderSelectionContainmentState): ReaderSelectionContainmentAction => {
  if (anchor === "outside") {
    return "ignore";
  }
  if (focus === "inside") {
    return "remember";
  }
  return drag === "active" && snapshot === "available" ? "restore" : "ignore";
};

type ReaderChromeParent = Pick<Element, "closest">;

/** Whether a text node's element parent belongs to non-document reader UI. */
export const isReaderChromeParent = (
  element: ReaderChromeParent | null,
): boolean =>
  element !== null && element.closest(`[${READER_CHROME_ATTRIBUTE}]`) !== null;

const isChrome = (node: Node): boolean => {
  const element = node instanceof Element ? node : node.parentElement;
  return isReaderChromeParent(element);
};

const textNodesOf = (root: Node): Text[] => {
  const walker = root.ownerDocument?.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  if (walker === undefined) {
    return [];
  }
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && !isChrome(node)) {
      nodes.push(node);
    }
  }
  return nodes;
};

/** The block's words, in the order and form the offsets index. */
export const blockWords = (block: HTMLElement): string =>
  textNodesOf(block)
    .map((node) => node.data)
    .join("");

/**
 * Text offset of a DOM point within the block's words. A point on an element
 * boundary counts every word node before the boundary's child index.
 */
const offsetWithin = (
  block: HTMLElement,
  container: Node,
  offset: number,
): number => {
  const beforeBoundary = block.ownerDocument.createRange();
  beforeBoundary.setStart(block, 0);
  beforeBoundary.setEnd(container, offset);
  return textNodesOf(beforeBoundary.cloneContents()).reduce(
    (total, node) => total + node.data.length,
    0,
  );
};

/**
 * The spans for the current selection, one per paragraph it touches, or an
 * empty list: collapsed, outside the reader, or nothing but whitespace. A
 * quote is taken from each block's own words, so it is what the reader saw.
 */
export const selectionAnchorsFrom = (
  selection: Selection,
  root: HTMLElement,
): SelectionAnchor[] => {
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return [];
  }
  const range = selection.getRangeAt(0);
  const spans: SelectionAnchor[] = [];
  for (const block of root.querySelectorAll<HTMLElement>("[data-anchor]")) {
    if (!range.intersectsNode(block)) {
      continue;
    }
    const blockAnchorId = block.dataset["anchor"];
    if (blockAnchorId === undefined || blockAnchorId === "") {
      continue;
    }
    const words = blockWords(block);
    const startOffset = block.contains(range.startContainer)
      ? offsetWithin(block, range.startContainer, range.startOffset)
      : 0;
    const endOffset = block.contains(range.endContainer)
      ? offsetWithin(block, range.endContainer, range.endOffset)
      : words.length;
    // Trailing and leading whitespace a drag picks up is not a mark on the
    // words; a paragraph the selection only brushes contributes nothing.
    const quote = words.slice(startOffset, endOffset);
    const trimmedStart =
      startOffset + (quote.length - quote.trimStart().length);
    const trimmedEnd = endOffset - (quote.length - quote.trimEnd().length);
    if (trimmedEnd <= trimmedStart) {
      continue;
    }
    spans.push({
      blockAnchorId,
      endOffset: trimmedEnd,
      quote: words.slice(trimmedStart, trimmedEnd),
      startOffset: trimmedStart,
    });
  }
  return spans;
};
