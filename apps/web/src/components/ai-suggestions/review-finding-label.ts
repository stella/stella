/**
 * What a finding's judgment reads as, in words.
 *
 * There is no glyph column any more: a reviewer opening the panel for the
 * first time cannot be expected to know that ▼ means "worse for your side"
 * and ○ means "the document does not have this at all". Every map here is
 * total over the vocabulary the engine writes, so a verdict, impact, or
 * severity added on the server has to state its word before it can render.
 */

import type { ReviewPerspective } from "@/components/ai-suggestions/document-review-basis.logic";
import type {
  ReviewFinding,
  ReviewSeverity,
  ReviewVerdict,
} from "@/components/ai-suggestions/document-review-queries";
import type { ReviewImpact } from "@/components/ai-suggestions/review-delta";

// TODO(i18n): English until the review surface is localized as a whole.
const VERDICT_LABEL = {
  compliant: "Compliant",
  fallback: "Fallback",
  deviation: "Deviation",
  missing: "Missing",
  additional: "Additional",
  "not-applicable": "Not applicable",
} as const satisfies Record<ReviewVerdict, string>;

/** A run that judged no direction and reached no verdict compared nothing. */
const NOT_COMPARED_LABEL = "Not compared";

export type DirectedImpact = Exclude<ReviewImpact, "unknown">;

/** An impact the card can put a direction on; `unknown` and findings the run
 *  never judged for a side fall back to the verdict. */
export const isDirectedImpact = (
  impact: ReviewFinding["impact"],
): impact is DirectedImpact => impact !== undefined && impact !== "unknown";

// Labels name the side so "worse" is never ambiguous on a printed or shared
// card.
const IMPACT_LABEL = {
  unfavourable: "Unfavourable",
  favourable: "Favourable",
  neutral: "Neutral",
} as const satisfies Record<DirectedImpact, string>;
const IMPACT_FOR_SIDE_LABEL = {
  unfavourable: "Worse for",
  favourable: "Better for",
  neutral: "No effect for",
} as const satisfies Record<DirectedImpact, string>;

export const impactLabel = (
  impact: DirectedImpact,
  perspective: ReviewPerspective,
): string =>
  perspective.type === "party"
    ? `${IMPACT_FOR_SIDE_LABEL[impact]} ${perspective.role}`
    : IMPACT_LABEL[impact];

/**
 * The judgment in one phrase: the direction the run judged for, the verdict
 * when it judged no direction, and "Missing" for a standard the document has
 * nothing to answer with — checked before impact, because "nothing to compare"
 * is a different finding from "no verdict either way".
 */
export const findingLabel = (
  finding: ReviewFinding,
  perspective: ReviewPerspective,
): string => {
  const { verdict, impact } = finding;
  if (verdict === "missing") {
    return VERDICT_LABEL.missing;
  }
  const resolvedImpact = impact ?? "unknown";
  if (isDirectedImpact(resolvedImpact)) {
    return impactLabel(resolvedImpact, perspective);
  }
  return verdict === null ? NOT_COMPARED_LABEL : VERDICT_LABEL[verdict];
};

/**
 * Which severities are worth repeating on the card. The list is already sorted
 * worst first, so naming every level would only restate the row's position;
 * the two that stop a deal are the ones a reviewer scanning the list has to
 * see without opening anything.
 */
const SEVERITY_WORD = {
  blocker: "Blocker",
  high: "High",
  medium: null,
  low: null,
} as const satisfies Record<ReviewSeverity, string | null>;

const LABEL_SEPARATOR = " · ";

/** The card header's right-aligned label: `High · Unfavourable`. */
export const findingHeaderLabel = (
  finding: ReviewFinding,
  perspective: ReviewPerspective,
): string => {
  const severityWord = SEVERITY_WORD[finding.severity];
  const judgment = findingLabel(finding, perspective);
  return severityWord === null
    ? judgment
    : `${severityWord}${LABEL_SEPARATOR}${judgment}`;
};
