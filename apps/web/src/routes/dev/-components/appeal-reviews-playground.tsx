import type {
  DecisionReviewLink,
  DecisionReviews,
} from "@stll/api-contract/case-law-reviews";

import { DecisionAppealReviews } from "@/features/case-law/components/case-viewer/decision-appeal-reviews";

const link = {
  reviewingDecisionId: "00000000-0000-4000-8000-000000000701",
  reviewingCaseNumber: "SYN 2/2026",
  reviewingCourt: "Synthetic reviewing court",
  reviewedDecisionId: "00000000-0000-4000-8000-000000000702",
  reviewedCaseNumber: "SYN 1/2026",
  reviewedCourt: "Synthetic regional court",
  reviewedDecisionDate: "2026-01-16",
  outcome: "upheld",
  source: "opening",
  evidenceStatus: "opening_only",
} as const satisfies DecisionReviewLink;

const bounds = {
  basis: "available_corpus",
  reviewedByTruncated: false,
  reviewsTruncated: false,
} as const;

const fixtures = {
  upheld: {
    status: "upheld",
    ...bounds,
    reviewedBy: [link],
    reviews: [],
  },
  overturned: {
    status: "overturned",
    ...bounds,
    reviewedBy: [{ ...link, outcome: "overturned" }],
    reviews: [{ ...link, outcome: "overturned" }],
  },
  none_found: {
    status: "none_found",
    reason: "no_link_in_corpus",
    ...bounds,
    reviewedBy: [],
    reviews: [],
  },
  conflict: {
    status: "unknown",
    ...bounds,
    reviewedBy: [{ ...link, source: "metadata", evidenceStatus: "conflict" }],
    reviews: [],
  },
  pending: {
    status: "under_review",
    ...bounds,
    reviewedBy: [
      {
        ...link,
        outcome: "pending",
        source: "metadata",
        evidenceStatus: "metadata_only",
      },
    ],
    reviews: [],
  },
} satisfies Record<string, DecisionReviews>;

/** All content is synthetic; links demonstrate reader navigation only. */
export const AppealReviewsPlayground = () => (
  <div
    className="flex max-w-xl flex-col gap-8"
    data-playground-section="appeal-reviews"
  >
    {Object.entries(fixtures).map(([state, reviews]) => (
      <div
        className="flex flex-col gap-3"
        data-playground-state={state}
        key={state}
      >
        <h2 className="text-muted-foreground text-xs">{state}</h2>
        <DecisionAppealReviews country="CZE" reviews={reviews} />
      </div>
    ))}
  </div>
);
