/**
 * Where a selection sits in the decision, in the terms an annotation is
 * stored in: the block's stable anchor and offsets into the block's rendered
 * text, which is the same text the reader lays inline anchors over.
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

const blockOf = (node: Node): HTMLElement | null => {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>("[data-anchor]") ?? null;
};

const isChrome = (node: Node): boolean => {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(`[${READER_CHROME_ATTRIBUTE}]`) !== null;
};

/** Text offset of a DOM point within the block's words. */
const offsetWithin = (
  block: HTMLElement,
  container: Node,
  offset: number,
): number | null => {
  const walker = block.ownerDocument.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT,
  );
  let total = 0;
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
    if (isChrome(text)) {
      continue;
    }
    if (text === container) {
      return total + offset;
    }
    // A point on an element boundary: everything before the boundary's
    // child index counts.
    if (
      container instanceof Element &&
      container.contains(text) &&
      Array.from(container.childNodes)
        .slice(0, offset)
        .some((child) => child === text || child.contains(text))
    ) {
      total += text.data.length;
      continue;
    }
    if (container instanceof Element && container.contains(text)) {
      return total;
    }
    total += text.data.length;
  }
  return container instanceof Element && block.contains(container)
    ? total
    : null;
};

/**
 * The anchor for the current selection when it lies within one block, or
 * null: across blocks, outside the reader, collapsed, or on chrome. A quote
 * is taken from the block's own words, so it is what the reader saw.
 */
export const selectionAnchorFrom = (
  selection: Selection,
  root: HTMLElement,
): SelectionAnchor | null => {
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const block = blockOf(range.startContainer);
  if (
    block === null ||
    !root.contains(block) ||
    blockOf(range.endContainer) !== block ||
    isChrome(range.startContainer) ||
    isChrome(range.endContainer)
  ) {
    return null;
  }
  const blockAnchorId = block.dataset["anchor"];
  if (blockAnchorId === undefined || blockAnchorId === "") {
    return null;
  }
  const startOffset = offsetWithin(
    block,
    range.startContainer,
    range.startOffset,
  );
  const endOffset = offsetWithin(block, range.endContainer, range.endOffset);
  if (startOffset === null || endOffset === null || endOffset <= startOffset) {
    return null;
  }
  const words = blockWords(block);
  const quote = words.slice(startOffset, endOffset);
  if (quote.trim() === "") {
    return null;
  }
  return { blockAnchorId, endOffset, quote, startOffset };
};

/** The block's words, in the order and form the offsets index. */
export const blockWords = (block: HTMLElement): string => {
  const walker = block.ownerDocument.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT,
  );
  let words = "";
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
    if (!isChrome(text)) {
      words += text.data;
    }
  }
  return words;
};
