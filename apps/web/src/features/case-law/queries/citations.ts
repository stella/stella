import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { unwrapPublicLawEden } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

/**
 * One side of a decision's citation graph: the decisions it relies on
 * (`outgoing`) or the decisions that rely on it (`incoming`).
 */
export const CITATION_DIRECTIONS = ["incoming", "outgoing"] as const;
export type CitationDirection = (typeof CITATION_DIRECTIONS)[number];

export const decisionCitationKeys = {
  all: ["case-law-decisions", "citations"],
  forDecision: (decisionId: string, direction: CitationDirection) => [
    ...decisionCitationKeys.all,
    decisionId,
    direction,
  ],
  summary: (decisionId: string) => [
    ...decisionCitationKeys.all,
    decisionId,
    "summary",
  ],
  leading: (decisionId: string, direction: CitationDirection) => [
    ...decisionCitationKeys.all,
    decisionId,
    "leading",
    direction,
  ],
};

/** One direction of a decision's citations, a page at a time. */
export const decisionCitationsInfiniteOptions = (
  decisionId: string,
  direction: CitationDirection,
) =>
  infiniteQueryOptions({
    queryKey: decisionCitationKeys.forDecision(decisionId, direction),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.case
        .decisions({ decisionId: toSafeId<"caseLawDecision">(decisionId) })
        .citations.get({
          query: {
            direction,
            ...(pageParam !== null && { cursor: pageParam }),
          },
          fetch: { signal },
        });

      const data = unwrapPublicLawEden(response, "listPublicDecisionCitations");

      return data;
    },
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/** The few most authoritative decisions per treatment, one direction. */
export const decisionLeadingCitationsOptions = (
  decisionId: string,
  direction: CitationDirection,
) =>
  queryOptions({
    queryKey: decisionCitationKeys.leading(decisionId, direction),
    queryFn: async ({ signal }) => {
      const response = await api.case
        .decisions({ decisionId: toSafeId<"caseLawDecision">(decisionId) })
        .citations.leading.get({ query: { direction }, fetch: { signal } });

      const data = unwrapPublicLawEden(
        response,
        "listLeadingDecisionCitations",
      );

      return data.items;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export type LeadingCitation = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof decisionLeadingCitationsOptions>["queryFn"]>
  >
>[number];

/** How many citations each direction holds, by treatment. */
export const decisionCitationSummaryOptions = (decisionId: string) =>
  queryOptions({
    queryKey: decisionCitationKeys.summary(decisionId),
    queryFn: async ({ signal }) => {
      const response = await api.case
        .decisions({ decisionId: toSafeId<"caseLawDecision">(decisionId) })
        .citations.summary.get({ fetch: { signal } });

      const data = unwrapPublicLawEden(
        response,
        "summarizePublicDecisionCitations",
      );

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
