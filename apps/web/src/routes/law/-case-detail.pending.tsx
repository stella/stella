import type { ReactNode, Ref } from "react";

import { useParams } from "@tanstack/react-router";

import {
  APPEAL_REVIEWS_COUNTRY,
  DecisionAppealReviewsPending,
} from "@/features/case-law/components/case-viewer/decision-appeal-reviews.pending";
import { DecisionWorkspacePending } from "@/features/case-law/components/case-viewer/decision-workspace.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

// The decision page's frame, drawn by both phases: the page, the review band a
// Czech decision opens with, and the row the reader fills. The page fills it
// with the decision the route read; the pending phase with the reader's
// layout and the text still to come, so the decision lands where its
// placeholders stood.

/** The decision's page; find attaches its highlights to it. */
export const DecisionReaderFrame = ({
  children,
  panelRef,
}: {
  children: ReactNode;
  panelRef?: Ref<HTMLElement> | undefined;
}) => (
  <main className="flex min-h-0 flex-1 flex-col overflow-hidden" ref={panelRef}>
    {children}
  </main>
);

/** The band above the reader the review section stands in. */
export const DecisionReviewsBand = ({ children }: { children: ReactNode }) => (
  <div className="px-4 py-2">{children}</div>
);

/** The row the reader, or the notice that there is no text, fills. */
export const DecisionReaderContent = ({
  children,
  contentRef,
}: {
  children: ReactNode;
  contentRef?: Ref<HTMLDivElement> | undefined;
}) => (
  <div className="flex min-h-0 flex-1 overflow-hidden" ref={contentRef}>
    {children}
  </div>
);

/** The reader's column, a visitor's and a member's alike. */
export const DecisionReaderColumn = ({ children }: { children: ReactNode }) => (
  <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
);

/**
 * The decision page before its decision is read. The address names the
 * corpus, so a Czech decision's review band is there from the start.
 */
const DecisionReaderPendingView = () => {
  // The address carries the corpus in lower case (`/law/cze/...`).
  const hasReviews = useParams({
    strict: false,
    select: (params) =>
      params.country?.toUpperCase() === APPEAL_REVIEWS_COUNTRY,
  });
  return (
    <DecisionReaderFrame>
      {hasReviews && (
        <DecisionReviewsBand>
          <DecisionAppealReviewsPending />
        </DecisionReviewsBand>
      )}
      <DecisionReaderContent>
        <DecisionReaderColumn>
          <DecisionWorkspacePending />
        </DecisionReaderColumn>
      </DecisionReaderContent>
    </DecisionReaderFrame>
  );
};

export const DecisionReaderPending = framePendingView(
  DecisionReaderPendingView,
);
