// The strip's hue and strength travel as `--reference-strip`, so the band is
// drawn once below and each treatment only names its colour. Literal per
// treatment: Tailwind only generates classes it can read in the source.
const DECISION_REFERENCE_UNKNOWN_TINT =
  "[--reference-strip:color-mix(in_oklab,var(--foreground)_9%,transparent)] hover:[--reference-strip:color-mix(in_oklab,var(--foreground)_16%,transparent)]";

const CITATION_TREATMENT_TINT = {
  negative:
    "[--reference-strip:color-mix(in_oklab,var(--destructive)_16%,transparent)] hover:[--reference-strip:color-mix(in_oklab,var(--destructive)_26%,transparent)]",
  mixed:
    "[--reference-strip:color-mix(in_oklab,var(--warning)_18%,transparent)] hover:[--reference-strip:color-mix(in_oklab,var(--warning)_28%,transparent)]",
  neutral: DECISION_REFERENCE_UNKNOWN_TINT,
  positive:
    "[--reference-strip:color-mix(in_oklab,var(--success)_16%,transparent)] hover:[--reference-strip:color-mix(in_oklab,var(--success)_26%,transparent)]",
  supportive:
    "[--reference-strip:color-mix(in_oklab,var(--success)_12%,transparent)] hover:[--reference-strip:color-mix(in_oklab,var(--success)_22%,transparent)]",
  unclassified: DECISION_REFERENCE_UNKNOWN_TINT,
} as const;

/**
 * A light band across the lower part of the words rather than a wash behind
 * them: a decision's text names dozens of others, and a full highlight on
 * each outweighs the prose the reader is in. `box-decoration-clone` so a
 * citation broken across two lines keeps its band on both, and no band at all
 * on paper, where it only costs toner.
 */
const DECISION_REFERENCE_TINT_SHAPE =
  "box-decoration-clone px-0.5 bg-no-repeat bg-[linear-gradient(to_top,transparent_10%,var(--reference-strip)_10%_35%,transparent_35%)] print:bg-none";

/**
 * The tint for one reference: its treatment's, where the citator classified
 * the citation, and the neutral band where it did not (an unresolved or
 * external reference is still a reference).
 */
export const decisionReferenceTintClassName = (
  treatment?: ReaderCitationTreatment,
): string =>
  `${DECISION_REFERENCE_TINT_SHAPE} ${treatment === undefined ? DECISION_REFERENCE_UNKNOWN_TINT : CITATION_TREATMENT_TINT[treatment]}`;

export type ReaderCitationTreatment = keyof typeof CITATION_TREATMENT_TINT;
