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

export const resolveParagraphReference = ({
  blocks,
  formatNumber,
  range,
}: ResolveParagraphReferenceOptions): ResolvedParagraphReference | null => {
  const { startAnchorId, endAnchorId } = range;
  const startIndex = blocks.findIndex(
    (block) => block.anchorId === startAnchorId,
  );
  const endIndex = blocks.findIndex((block) => block.anchorId === endAnchorId);
  if (startIndex === -1 || endIndex < startIndex) {
    return null;
  }

  const startNumber = paragraphNumber(
    blocks[startIndex],
    startIndex,
    formatNumber,
  );
  const endNumber = paragraphNumber(blocks[endIndex], endIndex, formatNumber);
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
