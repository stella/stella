import { queryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { workspaceMembersQueryRoot } from "@/lib/resource-query-roots.logic";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

const workspaceMembersKeys = {
  all: workspaceMembersQueryRoot,
};

export const workspaceMembersOptions = (workspaceId: string) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: workspaceMembersKeys.all(workspaceId),
      queryFn: async ({ signal }) => {
        const response = await api
          .workspaces({ workspaceId })
          .members.get({ fetch: { signal } });

        return unwrapApiResponse(response);
      },
      staleTime: ROUTE_QUERY_STALE_TIME_MS,
    }),
    {
      resources: [RESOURCE_TYPE.WORKSPACE],
      scope: { type: "workspace", workspaceId },
    },
  );
