/**
 * What a verdict means to the review surface, in one place.
 *
 * Two questions are asked of every verdict — does it need the reviewer's
 * attention, and is there anything to negotiate — and the map is total over
 * the vocabulary the engine writes, so a verdict added on the server has to
 * answer both here before it can render.
 */

import type {
  ReviewSeverity,
  ReviewVerdict,
} from "@/components/ai-suggestions/document-review-queries";

/** Worst first: the order a reviewer reads findings in. */
export const SEVERITY_ORDER = [
  "blocker",
  "high",
  "medium",
  "low",
] as const satisfies readonly ReviewSeverity[];

type MissingReviewSeverity = Exclude<
  ReviewSeverity,
  (typeof SEVERITY_ORDER)[number]
>;

true satisfies MissingReviewSeverity extends never ? true : never;

/**
 * Which severities get the review surface's one accent — the clause map's
 * ticks, a sidenote's rule. The rest is neutral ink: four colours is a legend,
 * not a signal. Total over the engine's vocabulary, so a severity added on the
 * server has to say whether it stops a deal.
 */
const DEAL_BREAKING_SEVERITY = {
  blocker: true,
  high: true,
  medium: false,
  low: false,
} as const satisfies Record<ReviewSeverity, boolean>;

export const isDealBreakingSeverity = (severity: ReviewSeverity): boolean =>
  DEAL_BREAKING_SEVERITY[severity];

const REVIEW_VERDICT_POLICY = {
  compliant: { risk: "clear", negotiation: "unavailable" },
  fallback: { risk: "flagged", negotiation: "available" },
  deviation: { risk: "flagged", negotiation: "available" },
  missing: { risk: "flagged", negotiation: "unavailable" },
  // Outside the compliance ladder: the document carries something the standard
  // does not speak to. Not a gap, so not flagged — but there is something to
  // say about it, so negotiation guidance still surfaces. Whether it hurts is
  // the finding's `impact`, not its verdict.
  additional: { risk: "clear", negotiation: "available" },
  // Also outside the ladder: the position does not pertain to this document,
  // so it is neither a pass nor a flagged gap and is excluded from any
  // compliance denominator computed over these verdicts.
  "not-applicable": { risk: "clear", negotiation: "unavailable" },
} as const satisfies Record<
  ReviewVerdict,
  { risk: "clear" | "flagged"; negotiation: "available" | "unavailable" }
>;

export type FlaggedReviewVerdict = {
  [TVerdict in ReviewVerdict]: (typeof REVIEW_VERDICT_POLICY)[TVerdict]["risk"] extends "flagged"
    ? TVerdict
    : never;
}[ReviewVerdict];

type NegotiableReviewVerdict = {
  [TVerdict in ReviewVerdict]: (typeof REVIEW_VERDICT_POLICY)[TVerdict]["negotiation"] extends "available"
    ? TVerdict
    : never;
}[ReviewVerdict];

export const isFlaggedVerdict = (
  verdict: ReviewVerdict,
): verdict is FlaggedReviewVerdict =>
  REVIEW_VERDICT_POLICY[verdict].risk === "flagged";

export const isNegotiableVerdict = (
  verdict: ReviewVerdict,
): verdict is NegotiableReviewVerdict =>
  REVIEW_VERDICT_POLICY[verdict].negotiation === "available";
