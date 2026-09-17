import type { ReactNode } from "react";

import { SparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import { analysisLayersOf } from "@stll/legal-ast/analysis";
import { BidiText } from "@stll/ui/bidi-text";

type AnalysisLayersProps = {
  analysis: DecisionAnalysis;
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
      <h3 className="text-foreground-disabled text-3xs flex items-center gap-1 pb-1 font-medium tracking-wider uppercase">
        <SparklesIcon aria-hidden className="size-3" />
        {t("caseLaw.analysis.aiLayer", { layer: label })}
      </h3>
      {children}
    </section>
  );
};

/**
 * The written layers of an analysis that keep the margin column: the topics,
 * and — when the corpus has been read for it — how later courts have treated
 * the decision. The holding and the abstract open the decision itself, in its
 * top matter, drawn as the court's own headnote is.
 *
 * A stored analysis from before these layers existed carries none of them,
 * and then nothing renders: an absent layer is absent, never an empty box.
 */
export const AnalysisLayers = ({ analysis }: AnalysisLayersProps) => {
  const t = useTranslations();
  const { significance, topics } = analysisLayersOf(analysis);

  if (significance === null && topics.length === 0) {
    return null;
  }

  return (
    <div className="border-border/60 border-b pb-3">
      {topics.length > 0 && (
        <Layer label={t("caseLaw.analysis.topics")}>
          <ul className="flex flex-wrap gap-1">
            {topics.map((topic) => (
              <li
                className="bg-muted text-muted-foreground text-3xs rounded px-1.5 py-0.5"
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
