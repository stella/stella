import { useQueries } from "@tanstack/react-query";
import { panic } from "better-result";

import {
  anchorRedirectBatches,
  type AnchorRedirectRead,
  type HeldDecisionAnchor,
  resolveHeldDecisionAnchor,
} from "@/features/case-law/decision-anchor-resolution.logic";
import { decisionAnchorRedirectsOptions } from "@/features/case-law/queries/anchor-redirects";
import { queryView } from "@/lib/query-view.logic";

type UseHeldDecisionAnchorsOptions = {
  decisionId: string;
  /** Anchors the reader holds: a fragment, stored links, answer paragraphs. */
  anchors: readonly string[];
  /** Every anchor of the decision document shown now. */
  currentAnchors: ReadonlySet<string>;
};

/**
 * Resolves held anchors against the shown document. Anchors it holds cost
 * nothing; the rest are read from the decision's redirects in batches.
 */
export const useHeldDecisionAnchors = ({
  decisionId,
  anchors,
  currentAnchors,
}: UseHeldDecisionAnchorsOptions): ((anchor: string) => HeldDecisionAnchor) => {
  const batches = anchorRedirectBatches(anchors, currentAnchors);
  const results = useQueries({
    queries: batches.map((batch) =>
      decisionAnchorRedirectsOptions(decisionId, batch),
    ),
  });
  const reads = batches.map((batch, index): AnchorRedirectRead => {
    const result =
      results.at(index) ?? panic("Every redirect batch must have a read");
    // An answer with no items is still an answer: never read as empty.
    const view = queryView(result, { isEmpty: () => false });
    switch (view.type) {
      case "items":
        return { type: "answered", items: view.items.items };
      case "error":
        return { type: "failed", anchors: batch };
      case "pending":
      case "empty":
        return { type: "pending", anchors: batch };
      default:
        view satisfies never;
        return panic("Unhandled redirect read view");
    }
  });
  return (anchor) =>
    resolveHeldDecisionAnchor({ anchor, currentAnchors, reads });
};
