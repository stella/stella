import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import type { DecisionReference } from "@/api/handlers/case-law/citations/decision-references";
import { classifyCitedPart } from "@/api/handlers/case-law/polarity/cited-part";
import { POLARITY_CLASSIFIER_VERSION } from "@/api/handlers/case-law/polarity/consts";
import { selectCitationPolarity } from "@/api/handlers/case-law/polarity/rule-engine";
import type { CitationPolarityVerdict } from "@/api/handlers/case-law/polarity/rule-engine";
import { CITED_PART } from "@/api/lib/case-law/citation-vocabulary";
import type { CitedPart } from "@/api/lib/case-law/citation-vocabulary";

/** One reference and the rule tier's reading of its treatment. */
export type ReadReference = {
  reference: DecisionReference;
  verdict: CitationPolarityVerdict | null;
  citedPart: CitedPart;
};

/**
 * Read one reference: the opinion part it cites, and for a precedent the rule
 * tier's verdict over its mention windows.
 */
export const readReference = (
  reference: DecisionReference,
  rules: Parameters<typeof selectCitationPolarity>[0],
  language: string,
): ReadReference => {
  const windows = reference.polarityWindows;
  return {
    reference,
    citedPart:
      windows === null
        ? CITED_PART.NOT_STATED
        : classifyCitedPart({
            contexts: windows.contexts,
            citationText: reference.printed,
            language,
          }),
    verdict:
      reference.kind !== CITATION_KIND.PRECEDENT || windows === null
        ? null
        : selectCitationPolarity(rules, windows.mentions),
  };
};

/** The evidence a rule verdict is stored with, beside the polarity it set. */
export const citationEvidenceColumns = ({
  reference,
  verdict,
  citedPart,
}: ReadReference) => ({
  polaritySource: verdict ? ("rule" as const) : null,
  polarityClassifierVersion: verdict ? POLARITY_CLASSIFIER_VERSION : null,
  polarityEvidenceWindows:
    verdict === null
      ? null
      : (reference.polarityWindows?.evidenceWindows ?? null),
  polarityConfidence: verdict?.confidence ?? null,
  citedPart,
});
