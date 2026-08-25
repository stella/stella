import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

export type DecisionAnnotationsKey = {
  activeOrganizationId: string;
  decisionId: string;
};

type AnnotationPage<T> = {
  items: readonly T[];
  nextCursor: string | null;
};

type FetchAnnotationPage<T> = (
  cursor: string | undefined,
) => Promise<AnnotationPage<T>>;

export const collectAnnotationPages = async <T>(
  fetchPage: FetchAnnotationPage<T>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;

  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return items;
};

const ANNOTATIONS_PAGE_SIZE = 100;

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
    queryFn: ({ signal }) =>
      collectAnnotationPages(async (cursor) => {
        const response = await api.case
          .decisions({
            decisionId: toSafeId<"caseLawDecision">(key.decisionId),
          })
          .annotations.get({
            query: {
              limit: ANNOTATIONS_PAGE_SIZE,
              ...(cursor === undefined ? {} : { cursor }),
            },
            fetch: { signal },
          });
        return unwrapEden(response);
      }),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export type DecisionAnnotation = Awaited<
  ReturnType<ReturnType<typeof decisionAnnotationsOptions>["queryFn"]>
>[number];
