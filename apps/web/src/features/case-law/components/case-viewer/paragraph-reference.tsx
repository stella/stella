import { useTranslations } from "use-intl";

import type { AnalysisAnchorRange } from "@stll/legal-ast/analysis";
import type { Block } from "@stll/legal-ast/document-ast";

type ParagraphReferenceProps = AnalysisAnchorRange & {
  blocks: Block[];
  onAnchorClick: (startAnchorId: string, endAnchorId: string) => void;
};

type ResolvedParagraphReference = AnalysisAnchorRange & {
  endIndex: number;
  label: string;
  startIndex: number;
};

const paragraphNumber = (block: Block, index: number): string =>
  block.type === "paragraph" && block.number !== undefined
    ? String(block.number)
    : `¶${index + 1}`;

export const resolveParagraphReference = (
  blocks: Block[],
  { startAnchorId, endAnchorId }: AnalysisAnchorRange,
): ResolvedParagraphReference | null => {
  const startIndex = blocks.findIndex(
    (block) => block.anchorId === startAnchorId,
  );
  const endIndex = blocks.findIndex((block) => block.anchorId === endAnchorId);
  if (startIndex === -1 || endIndex < startIndex) {
    return null;
  }

  const startNumber = paragraphNumber(blocks[startIndex], startIndex);
  const endNumber = paragraphNumber(blocks[endIndex], endIndex);
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
  const reference = resolveParagraphReference(blocks, {
    startAnchorId,
    endAnchorId,
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
