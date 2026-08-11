import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";

const DOCUMENT_REVIEW_SOURCE_LIMIT = 20;

export const documentReviewSourceKeys = {
  all: (workspaceId: string) =>
    ["document-review-sources", workspaceId] as const,
  search: (workspaceId: string, q: string) =>
    [...documentReviewSourceKeys.all(workspaceId), { q }] as const,
};

export const documentReviewSourcesOptions = ({
  workspaceId,
  q,
}: {
  workspaceId: string;
  q: string;
}) =>
  infiniteQueryOptions({
    queryKey: documentReviewSourceKeys.search(workspaceId, q),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["document-reviews"].sources.get({
          fetch: { signal },
          query: {
            q,
            limit: DOCUMENT_REVIEW_SOURCE_LIMIT,
            cursor: pageParam,
          },
        });
      return unwrapEden(response);
    },
    initialPageParam: stringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
