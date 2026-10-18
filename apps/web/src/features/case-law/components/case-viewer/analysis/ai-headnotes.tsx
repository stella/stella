import { useTranslations } from "use-intl";

import { HeadnoteBlock } from "@stll/decision-reader/headnote-block";
import type { HeadnoteOrigin } from "@stll/decision-reader/headnote-block";
import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import { analysisLayersOf } from "@stll/legal-ast/analysis";
import type { Block } from "@stll/legal-ast/document-ast";
import { BidiText } from "@stll/ui/bidi-text";

import {
  ParagraphReference,
  resolveParagraphReference,
} from "../paragraph-reference";

/** Every block here was written by a model, and says so on each block. */
const AI_ORIGIN = { type: "ai" } as const satisfies HeadnoteOrigin;

type AiHeadnotesProps = {
  analysis: DecisionAnalysis;
  blocks: Block[];
  /** Scrolls the text to a paragraph the holding rests on. */
  onAnchorClick: (startAnchorId: string, endAnchorId: string) => void;
};

/**
 * Whether an analysis carries either block. A stored analysis from before
 * these layers existed carries neither, and then the reader is given nothing
 * to draw: an absent layer is absent, never an empty box above the text.
 */
export const hasAiHeadnotes = (analysis: DecisionAnalysis): boolean => {
  const { abstract, holding } = analysisLayersOf(analysis);
  return holding !== null || abstract !== null;
};

/**
 * The model's headnote and abstract, drawn in the decision's top matter under
 * the court's own: the same block, the same labels, the same folds. A reader
 * tells the two apart by the mark, which is the point — not by a shape that
 * would also rank one above the other.
 */
export const AiHeadnotes = ({
  analysis,
  blocks,
  onAnchorClick,
}: AiHeadnotesProps) => {
  const t = useTranslations();
  const { abstract, holding } = analysisLayersOf(analysis);

  return (
    <>
      {holding !== null && (
        <HeadnoteBlock
          defaultOpen
          label={t("caseLaw.viewer.legalSentence")}
          origin={AI_ORIGIN}
        >
          <p className="reader-justify">
            <BidiText as="span" lang={holding.language}>
              {holding.text}
            </BidiText>{" "}
            {[...holding.anchors]
              .map((anchor) => resolveParagraphReference(blocks, anchor))
              .filter((anchor) => anchor !== null)
              .toSorted((left, right) => left.startIndex - right.startIndex)
              .filter(
                (anchor, index, anchors) =>
                  index === 0 ||
                  anchor.startAnchorId !== anchors[index - 1]?.startAnchorId ||
                  anchor.endAnchorId !== anchors[index - 1]?.endAnchorId,
              )
              .map((anchor, index) => (
                <span key={`${anchor.startAnchorId}-${anchor.endAnchorId}`}>
                  {index > 0 && " "}
                  <ParagraphReference
                    blocks={blocks}
                    endAnchorId={anchor.endAnchorId}
                    onAnchorClick={onAnchorClick}
                    startAnchorId={anchor.startAnchorId}
                  />
                </span>
              ))}
          </p>
        </HeadnoteBlock>
      )}

      {/* Open, unlike the court's abstract: the model's summary is the
          reader's way into a decision the court did not abstract. */}
      {abstract !== null && (
        <HeadnoteBlock
          defaultOpen
          label={t("caseLaw.viewer.abstract")}
          origin={AI_ORIGIN}
        >
          <BidiText
            as="p"
            className="reader-justify text-foreground-strong-muted"
            lang={abstract.language}
          >
            {abstract.text}
          </BidiText>
        </HeadnoteBlock>
      )}
    </>
  );
};
