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

import { readerTextQuoteContext } from "@stll/legal-ast/reader-text-quote";
import type { ReaderTextQuoteSelector } from "@stll/legal-ast/reader-text-quote";

const READER_CHROME_ATTRIBUTE = "data-reader-chrome";

/**
 * One paragraph's share of a selection, with the words either side of it in
 * the block: a re-parse can move the anchor and offsets, and the words are
 * what find the mark again.
 */
export type SelectionAnchor = ReaderTextQuoteSelector;

export type ReaderSelectionContainmentAction =
  "ignore" | "remember" | "restore";

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

type AnchoredBlock<T> = { contains: (other: T | null) => boolean };

/**
 * Whether this anchored element is the one a mark inside it belongs to. A
 * table is anchored and so is every cell in it: the table is a container
 * whose "text" is every cell run together, while a cell owns the offsets a
 * mark is stored with. The innermost anchored element is the one that owns
 * the words, so a container that holds another anchored element yields no
 * span of its own and a selection is never anchored twice.
 */
export const isInnermostAnchoredBlock = <T extends AnchoredBlock<T>>(
  block: T,
  blocks: readonly T[],
): boolean => !blocks.some((other) => other !== block && block.contains(other));

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

/** Text and explicit line breaks share the renderer's UTF-16 offset axis. */
const blockWords = (root: Node): string => {
  const walker = root.ownerDocument?.createTreeWalker(
    root,
    NodeFilter.SHOW_ALL,
  );
  if (walker === undefined) {
    return "";
  }
  const words: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (isChrome(node)) {
      continue;
    }
    if (node instanceof Text) {
      words.push(node.data);
    } else if (node instanceof Element && node.tagName === "BR") {
      words.push("\n");
    }
  }
  return words.join("");
};

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
  return blockWords(beforeBoundary.cloneContents()).length;
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
  const anchored = [...root.querySelectorAll<HTMLElement>("[data-anchor]")];
  for (const block of anchored) {
    if (
      !range.intersectsNode(block) ||
      !isInnermostAnchoredBlock(block, anchored)
    ) {
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
      ...readerTextQuoteContext(words, {
        startOffset: trimmedStart,
        endOffset: trimmedEnd,
      }),
    });
  }
  return spans;
};
