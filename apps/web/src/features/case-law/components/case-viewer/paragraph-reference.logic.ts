import type { AnalysisAnchorRange } from "@stll/legal-ast/analysis";
import type { Block } from "@stll/legal-ast/document-ast";

type FormatNumber = (value: number) => string;

/** A cited block as a reader cites it: by its number, with its own text. */
type CitedParagraph = {
  anchorId: string;
  number: string;
  text: string;
};

export type ResolvedParagraphReference = AnalysisAnchorRange & {
  endIndex: number;
  label: string;
  /** Every block the range covers, in reading order. */
  paragraphs: CitedParagraph[];
  startIndex: number;
};

const paragraphNumber = (
  block: Block,
  index: number,
  formatNumber: FormatNumber,
): string =>
  block.type === "paragraph" && block.number !== undefined
    ? formatNumber(block.number)
    : `¶${formatNumber(index + 1)}`;

/**
 * Where a cited range sits among the blocks: its first and last block index,
 * or null when either anchor is missing or the range runs backwards. The one
 * place a range is located, for drawing a reference and for highlighting it.
 */
export const paragraphRangeIndices = (
  blocks: readonly Block[],
  { startAnchorId, endAnchorId }: AnalysisAnchorRange,
): {
  endBlock: Block;
  endIndex: number;
  startBlock: Block;
  startIndex: number;
} | null => {
  const startIndex = blocks.findIndex(
    (block) => block.anchorId === startAnchorId,
  );
  const endIndex = blocks.findIndex((block) => block.anchorId === endAnchorId);
  const startBlock = blocks[startIndex];
  const endBlock = blocks[endIndex];
  return startBlock === undefined ||
    endBlock === undefined ||
    endIndex < startIndex
    ? null
    : { endBlock, endIndex, startBlock, startIndex };
};

type ResolveParagraphReferenceOptions = {
  blocks: readonly Block[];
  formatNumber: FormatNumber;
  range: AnalysisAnchorRange;
};

/** A cited range read against the loaded text; null when it does not resolve. */
export const resolveParagraphReference = ({
  blocks,
  formatNumber,
  range,
}: ResolveParagraphReferenceOptions): ResolvedParagraphReference | null => {
  const indices = paragraphRangeIndices(blocks, range);
  if (indices === null) {
    return null;
  }
  const { startAnchorId, endAnchorId } = range;
  const { startBlock, startIndex, endBlock, endIndex } = indices;
  const paragraphs = blocks
    .slice(startIndex, endIndex + 1)
    .map((block, offset) => ({
      anchorId: block.anchorId,
      number: paragraphNumber(block, startIndex + offset, formatNumber),
      text: block.plainText,
    }));
  const startNumber = paragraphNumber(startBlock, startIndex, formatNumber);
  const endNumber = paragraphNumber(endBlock, endIndex, formatNumber);
  return {
    startAnchorId,
    endAnchorId,
    startIndex,
    endIndex,
    paragraphs,
    label:
      startIndex === endIndex
        ? `[${startNumber}]`
        : `[${startNumber}]-[${endNumber}]`,
  };
};

/** Characters a preview shows before it hands the rest to the reader. */
export const PARAGRAPH_PREVIEW_CHARACTER_LIMIT = 1200;

type ParagraphPreview = {
  paragraphs: CitedParagraph[];
  /** Whether text was left out, so the preview offers the full paragraph. */
  truncated: boolean;
};

/** The last whitespace run and the partial word after it. */
const TRAILING_PARTIAL_WORD = /\s+\S*$/u;
/** A high surrogate whose pair the cut dropped. */
const DANGLING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/u;

const cutAtWord = (text: string, budget: number): string => {
  const cut = text.slice(0, budget);
  const wordEnd = cut.search(TRAILING_PARTIAL_WORD);
  return wordEnd > 0
    ? cut.slice(0, wordEnd)
    : cut.replace(DANGLING_HIGH_SURROGATE, "");
};

/**
 * The cited paragraphs cut to a reading budget: whole paragraphs in order,
 * then the next one cut at a word. A range of long paragraphs would otherwise
 * draw a card the size of the decision.
 */
export const paragraphPreview = (
  paragraphs: readonly CitedParagraph[],
  limit = PARAGRAPH_PREVIEW_CHARACTER_LIMIT,
): ParagraphPreview => {
  const shown: CitedParagraph[] = [];
  let remaining = limit;
  for (const paragraph of paragraphs) {
    if (paragraph.text.length <= remaining) {
      shown.push(paragraph);
      remaining -= paragraph.text.length;
      continue;
    }
    const text = cutAtWord(paragraph.text, remaining);
    if (text.length > 0) {
      shown.push({
        anchorId: paragraph.anchorId,
        number: paragraph.number,
        text,
      });
    }
    return { paragraphs: shown, truncated: true };
  }
  return { paragraphs: shown, truncated: false };
};
