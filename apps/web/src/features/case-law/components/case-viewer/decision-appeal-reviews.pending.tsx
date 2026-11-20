import { FaceLabelPending } from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";

/** The one corpus whose decisions carry procedural review evidence. */
export const APPEAL_REVIEWS_COUNTRY = "CZE";

/** The review section, its heading row and the heading, in both phases. */
export const DECISION_REVIEWS_CLASS_NAMES = {
  section: "reader-chrome flex flex-col gap-2 text-sm",
  headingRow: "flex flex-wrap items-center gap-2",
  heading: "text-foreground-strong-muted text-xs font-medium",
} as const;

/**
 * `DecisionAppealReviews` before the decision is read: its heading and the
 * status badge's box with the status still to come. What follows the row
 * (the review links, the corpus note) depends on what was found, so it waits.
 */
export const DecisionAppealReviewsPending = () => (
  <section aria-hidden="true" className={DECISION_REVIEWS_CLASS_NAMES.section}>
    <div className={DECISION_REVIEWS_CLASS_NAMES.headingRow}>
      <h2 className={DECISION_REVIEWS_CLASS_NAMES.heading}>
        <PendingText
          barClassName="w-28"
          id="caseLaw.viewer.appealReviews.title"
        />
      </h2>
      {/* `ReviewStatusBadge` at its `xs` size: the pill's border, padding
          and type, so the bar's box is the badge's. */}
      <span className="text-2xs inline-flex items-center rounded-full border px-1.5 py-0.5">
        <FaceLabelPending className="w-14" />
      </span>
    </div>
  </section>
);
