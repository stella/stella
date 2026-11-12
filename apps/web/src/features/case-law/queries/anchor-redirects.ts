import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapPublicLawResponse } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

/**
 * Where block anchors an earlier version of a decision's document held went.
 * `anchors` is one read's batch; callers split longer lists at
 * `DECISION_ANCHOR_REDIRECT_MAX_ANCHORS`.
 */
export const decisionAnchorRedirectsOptions = (
  decisionId: string,
  anchors: readonly string[],
) =>
  queryOptions({
    queryKey: [
      "case-law-decisions",
      "anchor-redirects",
      decisionId,
      [...anchors].toSorted(),
    ],
    queryFn: async ({ signal }) => {
      const decision = api.case.decisions({
        decisionId: toSafeId<"caseLawDecision">(decisionId),
      });
      const response = await decision["anchor-redirects"].get({
        query: { anchors: anchors.join(",") },
        fetch: { signal },
      });
      return unwrapPublicLawResponse(response, "readDecisionAnchorRedirects");
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
