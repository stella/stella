import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

export type DecisionAnnotationsKey = {
  activeOrganizationId: string;
  decisionId: string;
};

export const decisionAnnotationKeys = {
  all: ["case-law", "annotations"],
  forDecision: ({
    activeOrganizationId,
    decisionId,
  }: DecisionAnnotationsKey) => [
    ...decisionAnnotationKeys.all,
    { activeOrganizationId, decisionId },
  ],
};

/**
 * The reader's own marks on a decision and what colleagues shared. Keyed by
 * organization as well as decision: the same decision carries different
 * notes in each organization the reader belongs to.
 */
export const decisionAnnotationsOptions = (key: DecisionAnnotationsKey) =>
  queryOptions({
    queryKey: decisionAnnotationKeys.forDecision(key),
    queryFn: async ({ signal }) => {
      const response = await api.case
        .decisions({ decisionId: toSafeId<"caseLawDecision">(key.decisionId) })
        .annotations.get({ fetch: { signal } });
      return unwrapEden(response).items;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export type DecisionAnnotation = Awaited<
  ReturnType<ReturnType<typeof decisionAnnotationsOptions>["queryFn"]>
>[number];
