import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

export const workspaceMemberPreviewsKeys = {
  all: () => ["workspace-member-previews"] as const,
  batch: (workspaceIds: readonly string[]) =>
    [...workspaceMemberPreviewsKeys.all(), workspaceIds.toSorted()] as const,
};

const readWorkspaceMemberPreviews = async (
  workspaceIds: readonly string[],
  signal: AbortSignal,
) =>
  unwrapEden(
    await api.workspaces["member-previews"].get({
      query: {
        workspaceIds: workspaceIds
          .toSorted()
          .map((id) => toSafeId<"workspace">(id)),
      },
      fetch: { signal },
    }),
  );

export type WorkspaceMemberPreview = Awaited<
  ReturnType<typeof readWorkspaceMemberPreviews>
>["previews"][number];

export const workspaceMemberPreviewsOptions = (
  workspaceIds: readonly string[],
) =>
  queryOptions({
    queryKey: workspaceMemberPreviewsKeys.batch(workspaceIds),
    queryFn: ({ signal }) => readWorkspaceMemberPreviews(workspaceIds, signal),
    enabled: workspaceIds.length > 0,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
