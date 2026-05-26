import { lazy, Suspense } from "react";

import type { ReviewPanelProps } from "./review-panel.impl";

// The review panel imports `diffWordSegments` from `@stll/folio` to
// compute inline word-level diffs for each AI suggestion. That value
// import alone is enough to drag the whole vendor-folio chunk into
// the eager preload graph (the panel is mounted by the inspector,
// which loads with the workspaces layout). Defer it.
const LazyReviewPanel = lazy(async () => {
  const m = await import("./review-panel.impl");
  return { default: m.ReviewPanelImpl };
});

export const ReviewPanel = (props: ReviewPanelProps) => (
  <Suspense fallback={null}>
    <LazyReviewPanel {...props} />
  </Suspense>
);
