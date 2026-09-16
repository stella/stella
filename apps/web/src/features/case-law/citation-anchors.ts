import type {
  CitationTreatment,
  CitedDecisionAddress,
} from "@/features/case-law/citation-treatment";

/** A resolved citation: the text as the decision wrote it, and its target. */
export type CitationAnchorSource = {
  citationText: string;
  decision: CitedDecisionAddress;
  id: string;
  /** The source section the classifier used for this citation's treatment. */
  sectionIndex?: number | null | undefined;
  /** How this text treats the decision it names, as the citator read it. */
  treatment: CitationTreatment;
};
