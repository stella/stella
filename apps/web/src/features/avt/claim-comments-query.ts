import { queryOptions } from "@tanstack/react-query";

import { collectAnnotationPages } from "@/components/legal-reader/annotations/reader-annotations-query";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

export type ClaimCommentsKey = {
  claimId: string;
  runId: string;
  /** Who reads: private comments are the author's alone. */
  viewer: { organizationId: string; userId: string };
  workspaceId: string;
};

export const claimCommentKeys = {
  all: (workspaceId: string) => ["avt", workspaceId, "claim-comments"] as const,
  forClaim: ({ claimId, runId, viewer, workspaceId }: ClaimCommentsKey) =>
    [
      ...claimCommentKeys.all(workspaceId),
      {
        claimId,
        organizationId: viewer.organizationId,
        runId,
        userId: viewer.userId,
      },
    ] as const,
};

const COMMENTS_PAGE_SIZE = 100;

/**
 * The comments on one verification claim the reader can see: their own and
 * what colleagues on the matter shared, in the reader-annotation shape the
 * case-law reader's comments use.
 */
export const claimCommentsOptions = (key: ClaimCommentsKey) =>
  queryOptions({
    queryKey: claimCommentKeys.forClaim(key),
    queryFn: async ({ signal }) =>
      await collectAnnotationPages(async (cursor) => {
        const workspaceId = toSafeId<"workspace">(key.workspaceId);
        const page = await api.lists({ workspaceId })["claim-comments"].get({
          query: {
            claimId: toSafeId<"legalListClaim">(key.claimId),
            limit: COMMENTS_PAGE_SIZE,
            runId: toSafeId<"legalListVerificationRun">(key.runId),
            ...(cursor === undefined ? {} : { cursor }),
          },
          fetch: { signal },
        });
        return unwrapApiResponse(page);
      }),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
