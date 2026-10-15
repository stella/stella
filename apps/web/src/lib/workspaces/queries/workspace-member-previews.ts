import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

type WorkspaceMemberPreviewsScope = {
  organizationId: string;
  userId: string;
};

type WorkspaceMemberPreviewsKey = WorkspaceMemberPreviewsScope & {
  workspaceIds: readonly string[];
};

const workspaceMemberPreviewsKeys = {
  root: () => ["workspace-member-previews"] as const,
  all: ({ organizationId, userId }: WorkspaceMemberPreviewsScope) =>
    [...workspaceMemberPreviewsKeys.root(), organizationId, userId] as const,
  batch: ({
    organizationId,
    userId,
    workspaceIds,
  }: WorkspaceMemberPreviewsKey) =>
    [
      ...workspaceMemberPreviewsKeys.all({ organizationId, userId }),
      workspaceIds.toSorted(),
    ] as const,
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

export const workspaceMemberPreviewsOptions = ({
  organizationId,
  userId,
  workspaceIds,
}: WorkspaceMemberPreviewsKey) =>
  queryOptions({
    queryKey: workspaceMemberPreviewsKeys.batch({
      organizationId,
      userId,
      workspaceIds,
    }),
    queryFn: async ({ signal }) =>
      await readWorkspaceMemberPreviews(workspaceIds, signal),
    enabled: workspaceIds.length > 0,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
