import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { workspaceMembersQueryRoot } from "@/lib/resource-query-roots.logic";

export const workspaceMembersKeys = {
  all: workspaceMembersQueryRoot,
};

export const workspaceMembersOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: workspaceMembersKeys.all(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .members.get({ fetch: { signal } });

      return unwrapApiResponse(response);
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
