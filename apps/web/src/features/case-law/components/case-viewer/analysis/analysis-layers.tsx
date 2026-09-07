import type { ReactNode } from "react";

import { SparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import { analysisLayersOf } from "@stll/legal-ast/analysis";
import { BidiText } from "@stll/ui/bidi-text";

type AnalysisLayersProps = {
  analysis: DecisionAnalysis;
  /** Scrolls the text to a paragraph the holding rests on. */
  onAnchorClick: (anchorId: string) => void;
};

/**
 * One layer, under its own name and its own AI mark. The mark is repeated
 * per layer rather than left to the column's badge: a reader who lands on
 * the abstract must be told that sentence was written by a model, without
 * having to scroll to find out.
 */
const Layer = ({
  children,
  label,
}: {
  children: ReactNode;
  /** The layer's own name, already translated by the caller. */
  label: string;
}) => {
  const t = useTranslations();
  return (
    <section className="px-2 pt-4">
      <h3 className="text-foreground-disabled flex items-center gap-1 pb-1 text-[0.6rem] font-medium tracking-wider uppercase">
        <SparklesIcon aria-hidden className="size-3" />
        {t("caseLaw.analysis.aiLayer", { layer: label })}
      </h3>
      {children}
    </section>
  );
};

/**
 * The written layers of an analysis, above the margin notes: the holding
 * with the paragraphs it rests on, the abstract, the topics, and — when the
 * corpus has been read for it — how later courts have treated the decision.
 *
 * A stored analysis from before these layers existed carries none of them,
 * and then nothing renders: an absent layer is absent, never an empty box.
 */
export const AnalysisLayers = ({
  analysis,
  onAnchorClick,
}: AnalysisLayersProps) => {
  const t = useTranslations();
  const { abstract, holding, significance, topics } =
    analysisLayersOf(analysis);

  if (
    holding === null &&
    abstract === null &&
    significance === null &&
    topics.length === 0
  ) {
    return null;
  }

  return (
    <div className="border-border/60 border-b pb-3">
      {holding !== null && (
        <Layer label={t("caseLaw.analysis.categories.holding")}>
          <BidiText
            className="text-foreground text-xs leading-relaxed"
            lang={holding.language}
          >
            {holding.text}
          </BidiText>
          {holding.anchors.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1.5">
              {holding.anchors.map((anchor) => (
                <button
                  className="text-muted-foreground hover:text-foreground hover:bg-muted rounded px-1.5 py-1 text-[0.65rem] transition-colors"
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
        </Layer>
      )}

      {abstract !== null && (
        <Layer label={t("caseLaw.analysis.abstract")}>
          <BidiText
            className="text-muted-foreground text-xs leading-relaxed"
            lang={abstract.language}
          >
            {abstract.text}
          </BidiText>
        </Layer>
      )}

      {topics.length > 0 && (
        <Layer label={t("caseLaw.analysis.topics")}>
          <ul className="flex flex-wrap gap-1">
            {topics.map((topic) => (
              <li
                className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[0.65rem]"
                key={topic}
              >
                {topic}
              </li>
            ))}
          </ul>
        </Layer>
      )}

      {significance !== null && (
        <Layer label={t("caseLaw.analysis.treatment")}>
          <BidiText
            className="text-muted-foreground text-xs leading-relaxed"
            lang={significance.language}
          >
            {significance.text}
          </BidiText>
        </Layer>
      )}
    </div>
  );
};
