const DECISION_REFERENCE_UNKNOWN_TINT =
  "bg-foreground/6 hover:bg-foreground/10";

const CITATION_TREATMENT_TINT = {
  negative: "bg-destructive/8 hover:bg-destructive/14",
  mixed: "bg-warning/8 hover:bg-warning/14",
  neutral: DECISION_REFERENCE_UNKNOWN_TINT,
  positive: "bg-success/10 hover:bg-success/16",
  supportive: "bg-success/8 hover:bg-success/14",
  unclassified: DECISION_REFERENCE_UNKNOWN_TINT,
} as const;

/**
 * `box-decoration-clone` so a citation broken across two lines keeps its
 * rounded ends on both, and no tint at all on paper, where a grey wash only
 * costs toner.
 */
const DECISION_REFERENCE_TINT_SHAPE =
  "box-decoration-clone rounded-sm px-0.5 print:bg-transparent";

/**
 * The tint for one reference: its treatment's, where the citator classified
 * the citation, and the neutral wash where it did not (an unresolved or
 * external reference is still a reference).
 */
export const decisionReferenceTintClassName = (
  treatment?: ReaderCitationTreatment,
): string =>
  `${DECISION_REFERENCE_TINT_SHAPE} ${treatment === undefined ? DECISION_REFERENCE_UNKNOWN_TINT : CITATION_TREATMENT_TINT[treatment]}`;

export type ReaderCitationTreatment = keyof typeof CITATION_TREATMENT_TINT;
