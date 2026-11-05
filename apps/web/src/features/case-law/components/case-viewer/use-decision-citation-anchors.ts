import { useInfiniteQuery } from "@tanstack/react-query";

import type {
  CitationAnchorSource,
  UnresolvedCitationAnchorSource,
} from "@stll/decision-reader/reader-types";

import { decisionCitationsInfiniteOptions } from "@/features/case-law/queries/citations";
import { optionalArray } from "@/lib/arrays";
import { queryView } from "@/lib/query-view.logic";
import type { SafeId } from "@/lib/safe-id";
import { useQueryViewError } from "@/lib/use-query-view";

type DecisionCitationAnchors = {
  /** Citations of a held decision, linked to it. */
  citationAnchors: CitationAnchorSource[];
  /** Citations the corpus could not resolve, marked as text. */
  unresolvedCitationAnchors: UnresolvedCitationAnchorSource[];
};

/** Outgoing citations already loaded for inline marking in a decision. */
export const useDecisionCitationAnchors = (
  decisionId: SafeId<"caseLawDecision">,
): DecisionCitationAnchors => {
  const dataQuery = useInfiniteQuery(
    decisionCitationsInfiniteOptions(decisionId, "outgoing"),
  );
  const dataView = queryView(dataQuery);
  useQueryViewError(dataView, "useDecisionCitationAnchors:query");
  const data = dataView.type === "items" ? dataView.items : undefined;
  const anchors: DecisionCitationAnchors = {
    citationAnchors: [],
    unresolvedCitationAnchors: [],
  };

  for (const page of optionalArray(data?.pages)) {
    for (const item of page.items) {
      if (item.decision === null) {
        anchors.unresolvedCitationAnchors.push({
          citationText: item.citationText,
          id: item.id,
          sectionIndex: item.sectionIndex,
        });
        continue;
      }
      anchors.citationAnchors.push({
        citationText: item.citationText,
        decision: item.decision,
        id: item.id,
        sectionIndex: item.sectionIndex,
        treatment: item.treatment,
      });
    }
  }

  return anchors;
};
