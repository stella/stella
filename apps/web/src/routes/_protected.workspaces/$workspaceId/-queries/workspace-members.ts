import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export const workspaceMembersKeys = {
  all: (workspaceId: string) => ["workspace-members", workspaceId],
};

export const workspaceMembersOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: workspaceMembersKeys.all(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .members.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
