import { useTranslations } from "use-intl";

import type { AnalysisAnchorRange } from "@stll/legal-ast/analysis";
import type { Block } from "@stll/legal-ast/document-ast";

import { useFormatter } from "@/i18n/formatting-context";

type ParagraphReferenceProps = AnalysisAnchorRange & {
  blocks: Block[];
  onAnchorClick: (startAnchorId: string, endAnchorId: string) => void;
};

type ResolvedParagraphReference = AnalysisAnchorRange & {
  endIndex: number;
  label: string;
  startIndex: number;
};

type FormatNumber = (value: number) => string;

const paragraphNumber = (
  block: Block,
  index: number,
  formatNumber: FormatNumber,
): string =>
  block.type === "paragraph" && block.number !== undefined
    ? formatNumber(block.number)
    : `¶${formatNumber(index + 1)}`;

type ResolveParagraphReferenceOptions = {
  blocks: Block[];
  formatNumber: FormatNumber;
  range: AnalysisAnchorRange;
};

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

  const startNumber = paragraphNumber(startBlock, startIndex, formatNumber);
  const endNumber = paragraphNumber(endBlock, endIndex, formatNumber);
  return {
    startAnchorId,
    endAnchorId,
    startIndex,
    endIndex,
    label:
      startIndex === endIndex
        ? `[${startNumber}]`
        : `[${startNumber}]-[${endNumber}]`,
  };
};

export const ParagraphReference = ({
  blocks,
  startAnchorId,
  endAnchorId,
  onAnchorClick,
}: ParagraphReferenceProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const reference = resolveParagraphReference({
    blocks,
    formatNumber: format.number,
    range: { startAnchorId, endAnchorId },
  });
  if (reference === null) {
    return null;
  }

  return (
    <button
      aria-label={t("caseLaw.viewer.paragraphReference", {
        number: reference.label.slice(1, -1).replace("]-[", "–"),
      })}
      className="reader-chrome text-muted-foreground hover:text-foreground rounded-sm underline-offset-2 hover:underline"
      onClick={() => onAnchorClick(startAnchorId, endAnchorId)}
      type="button"
    >
      <bdi>{reference.label}</bdi>
    </button>
  );
};
