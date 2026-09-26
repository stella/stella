import { useTranslations } from "use-intl";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import { analysisLayersOf } from "@stll/legal-ast/analysis";
import { BidiText } from "@stll/ui/bidi-text";

import { HeadnoteBlock } from "@/features/case-law/components/case-viewer/headnote-block";
import type { HeadnoteOrigin } from "@/features/case-law/components/case-viewer/headnote-block";

/** Every block here was written by a model, and says so on each block. */
const AI_ORIGIN = { type: "ai" } as const satisfies HeadnoteOrigin;

type AiHeadnotesProps = {
  analysis: DecisionAnalysis;
  /** Scrolls the text to a paragraph the holding rests on. */
  onAnchorClick: (anchorId: string) => void;
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
export const AiHeadnotes = ({ analysis, onAnchorClick }: AiHeadnotesProps) => {
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
          <BidiText as="p" className="reader-justify" lang={holding.language}>
            {holding.text}
          </BidiText>
          {holding.anchors.length > 0 && (
            <div className="reader-chrome flex flex-wrap gap-1 pt-2">
              {holding.anchors.map((anchor) => (
                <button
                  className="text-muted-foreground hover:text-foreground hover:bg-muted text-3xs rounded px-1.5 py-1"
                  key={`${anchor.startAnchorId}-${anchor.endAnchorId}`}
                  onClick={() => {
                    onAnchorClick(anchor.startAnchorId);
                  }}
                  type="button"
                >
                  {t("caseLaw.analysis.holdingAnchor")}
                </button>
              ))}
            </div>
          )}
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
