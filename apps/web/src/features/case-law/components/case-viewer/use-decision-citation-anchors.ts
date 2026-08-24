import { useInfiniteQuery } from "@tanstack/react-query";

import type { CitationAnchorSource } from "@/features/case-law/citation-anchors";
import { decisionCitationsInfiniteOptions } from "@/features/case-law/queries/citations";
import { optionalArray } from "@/lib/arrays";
import type { SafeId } from "@/lib/safe-id";

/** Resolved outgoing citations already loaded for inline linking in a decision. */
export const useDecisionCitationAnchors = (
  decisionId: SafeId<"caseLawDecision">,
): CitationAnchorSource[] => {
  const { data } = useInfiniteQuery(
    decisionCitationsInfiniteOptions(decisionId, "outgoing"),
  );
  const anchors: CitationAnchorSource[] = [];

  for (const page of optionalArray(data?.pages)) {
    for (const item of page.items) {
      if (item.decision !== null) {
        anchors.push({
          citationText: item.citationText,
          decision: item.decision,
          id: item.id,
        });
      }
    }
  }

  return anchors;
};
